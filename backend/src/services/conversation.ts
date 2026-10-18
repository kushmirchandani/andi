// Routes inbound iMessage events from Photon to the right person and action.
//
// Order of operations for every inbound text:
//   1. SAFETY FIRST. The deterministic crisis / withdrawal router runs on the raw text before
//      anything else (linking, keywords, sponsor relay, strangers). A crisis reply goes out
//      immediately, with no typing delay, and the rest of the pipeline never replaces it.
//   2. Sponsor links: anyone whose number someone picked as "their person" is linked on their
//      first message (even if they're also an Andi user themselves).
//   3. Sign-in codes from the app's first screen ("hi andi <code>" from the number typed there):
//      - a linked account for the sender's handle         -> signed in: the account takes over the
//                                                             install's token (other installs sign out)
//      - no account                                        -> a verified new signup; /api/onboard
//                                                             finishes it
//      Andi's reply is the only place either outcome shows, so only that number's owner learns it.
//   4. Resolve the person:
//      - a linked account for this handle                  -> that person
//      - "hi andi <code>" for a pending account            -> link it, but only if the sender's
//        handle is the number typed at onboarding (or an iMessage email handle)
//      - a reinstall (pending code + existing linked account
//        for the same number)                             -> restore the existing account onto
//                                                             the new install's token
//      Phone-only linking is not allowed: anyone can type anyone's number at onboarding.
//   5. Person -> conversation. Sponsor -> encouragement relay. Otherwise a stranger.

import { config } from "../config.js";
import { think, type BrainContext, type Turn } from "../agent/brain.js";
import { copingMentions, patternMemory } from "../risk/patterns.js";
import { routeInbound, violatesGuard } from "../agent/safety.js";
import { clock } from "../clock.js";
import { log, mask } from "../log.js";
import { photon } from "../photon/client.js";
import type { PhotonEvent, PhotonMessage } from "../photon/events.js";
import { localClockParts } from "../risk/signals.js";
import { daysSober, normalizeHandle, nowIso, store } from "../store.js";
import type { Person } from "../types.js";
import { callPerson } from "./calls.js";
import { checkinReply, evaluate, onCheckin, onSlip, startBreathing } from "./engine.js";
import { releaseSponsorLine } from "./lines.js";
import { updateSponsorStatus } from "./sponsor.js";
import { personTarget, sponsorTarget, textPerson, textSponsor } from "./targets.js";
import { heart, sendVoiceNote } from "./rich.js";

const MAX_CHAT_TURNS = 20;
const UNKNOWN_REPLY_GAP_MS = 24 * 3600_000;
const CODE_ATTEMPTS_PER_HOUR = 5;

export function agentContext(p: Person): BrainContext {
  const recent = p.events
    .slice(-8)
    .filter((e) => !["inbound", "outreach", "risk_change", "voice_note"].includes(e.kind))
    .map((e) => `${e.kind}${e.detail ? ` (${e.detail})` : ""}`);
  return {
    name: p.name,
    daysSober: daysSober(p),
    sponsorName: p.sponsor?.name,
    why: p.whyText,
    riskLevel: p.lastRisk?.level ?? "low",
    riskReasons: p.lastRisk?.reasons ?? [],
    localTime: localClockParts(clock.now(), p.timezone).label,
    recent,
    memory: patternMemory(p.patterns),
  };
}

const extractCode = (m: PhotonMessage) => (m.content.type === "text" ? m.content.text?.match(/\b(\d{6})\b/)?.[1] : undefined);

// Wrong-code attempts per handle, so nobody can guess their way into a pending account.
const codeAttempts = new Map<string, { n: number; resetAt: number }>();
function codeAttemptAllowed(handle: string) {
  const a = codeAttempts.get(handle);
  return !a || a.resetAt <= Date.now() || a.n < CODE_ATTEMPTS_PER_HOUR;
}
function recordBadCode(handle: string) {
  const now = Date.now();
  const a = codeAttempts.get(handle);
  if (!a || a.resetAt <= now) codeAttempts.set(handle, { n: 1, resetAt: now + 3600_000 });
  else a.n++;
}

// A sign-in code from the app's first screen. Returns true when the message was one (handled here).
async function handleSignIn(m: PhotonMessage, safetyReply?: string) {
  const code = extractCode(m);
  const handle = normalizeHandle(m.sentBy.handle);
  if (!code || !codeAttemptAllowed(handle)) return false;
  const s = store.signInByCode(code);
  if (!s) return false;
  // Same rule as linking: the code must come from the number typed in the app (or an iMessage
  // email handle, which can only reach its own account below).
  if (!handle.includes("@") && handle !== s.phone) {
    recordBadCode(handle);
    log.warn("signin", `code for ${s.id} sent from a different number (${mask(handle)}); ignored`);
    return false;
  }
  await photon.markRead(m.id);

  const existing = store.linkedByPhone(handle);
  if (existing) {
    store.update(existing.id, (x) => {
      x.apiToken = s.token; // the old install's token stops working
      x.linkCode = undefined;
      x.photon.lastInboundAt = nowIso();
    });
    store.removeSignIn(s.id); // the line stays: the account uses the same handle
    store.log(existing.id, { kind: "restored" });
    log.info("signin", `signed in ${existing.id} on a new install (${mask(handle)})`);
    if (!safetyReply) {
      const p = store.must(existing.id);
      await textPerson(p, `welcome back, ${p.name.toLowerCase()}. you're signed in on this phone. day ${daysSober(p)}.`);
    }
    return true;
  }

  store.updateSignIn(s.id, (x) => {
    x.verifiedAt = nowIso();
    x.phone = handle;
    x.photon.spaceId = m.space.id;
    x.photon.agentUserId = m.receivedBy?.id;
    x.photon.userId = m.sentBy.id;
    x.photon.lastInboundAt = nowIso();
    if (m.receivedBy?.handle && !x.photon.andiNumber) x.photon.andiNumber = m.receivedBy.handle;
  });
  log.info("signin", `verified new signup ${s.id} (${mask(handle)})`);
  if (!safetyReply && m.receivedBy) {
    await photon
      .text({ spaceId: m.space.id, senderId: m.receivedBy.id }, "hi, i'm andi. really glad you're here. finish setting up in the app and i'll be right here.")
      .catch((err) => log.error("signin", "welcome text failed", err));
  }
  return true;
}

// The first texts to someone whose signup was verified before onboarding (see /api/onboard).
export async function welcomeNewPerson(p: Person) {
  await textPerson(
    p,
    `hey ${p.name.toLowerCase()}, it's andi. save me in your phone. text me anytime, especially the hard nights.`,
    `day ${daysSober(p)}. that's real. proud of you.`,
  );
}

// Find (and if needed, link or restore) the person this message is from.
function resolvePerson(m: PhotonMessage): { person: Person; restored: boolean } | null {
  const handle = normalizeHandle(m.sentBy.handle);
  const linked = store.linkedByPhone(handle);
  const code = extractCode(m);
  if (!code || !codeAttemptAllowed(handle)) return linked ? { person: linked, restored: false } : null;

  const pending = store.byLinkCode(code);
  if (!pending) {
    if (!linked) {
      recordBadCode(handle);
      log.info("link", `unknown link code from ${mask(handle)}`);
    }
    return linked ? { person: linked, restored: false } : null;
  }
  const typed = pending.enteredPhone ?? pending.phone;

  if (linked) {
    // Reinstall: only when the pending account was made for this same person's number.
    const samePerson = pending.id !== linked.id && [linked.phone, linked.enteredPhone].includes(typed);
    if (!samePerson) return { person: linked, restored: false }; // a stray 6-digit number in conversation
    store.update(linked.id, (x) => {
      x.apiToken = pending.apiToken;
      x.linkCode = undefined;
    });
    const droppedSponsor = pending.sponsor;
    store.remove(pending.id);
    if (droppedSponsor) void releaseSponsorLine(pending.id, droppedSponsor);
    store.log(linked.id, { kind: "restored" });
    log.info("link", `restored ${linked.id} onto a new install (${mask(handle)})`);
    return { person: store.must(linked.id), restored: true };
  }

  // The code proves the sender saw this app's screen; the handle check proves it's their number.
  // An iMessage email handle can't match a typed number, so for those the code alone links.
  const handleOk = handle.includes("@") || handle === normalizeHandle(typed);
  if (!handleOk) {
    recordBadCode(handle);
    log.warn("link", `code for ${pending.id} sent from a different number (${mask(handle)}); ignored`);
    return null;
  }
  store.update(pending.id, (x) => {
    x.phone = handle;
  });
  return { person: store.must(pending.id), restored: false };
}

// Link every person who picked this handle as their person and hasn't heard from them yet.
async function linkSponsorships(m: PhotonMessage) {
  const handle = normalizeHandle(m.sentBy.handle);
  const fresh = store.allBySponsorPhone(handle).filter((p) => !p.sponsor!.photon.spaceId);
  for (const p of fresh) {
    store.update(p.id, (x) => {
      if (!x.sponsor) return;
      x.sponsor.photon.spaceId = m.space.id;
      x.sponsor.photon.agentUserId = m.receivedBy?.id ?? x.sponsor.photon.agentUserId;
      x.sponsor.photon.userId = m.sentBy.id;
      x.sponsor.photon.lastInboundAt = nowIso();
      if (m.receivedBy?.handle && !x.sponsor.photon.andiNumber) x.sponsor.photon.andiNumber = m.receivedBy.handle;
    });
    const linked = store.must(p.id);
    log.info("link", `sponsor linked for ${p.id}`);
    await textSponsor(
      linked,
      `hi ${linked.sponsor!.name.toLowerCase()}, i'm andi. ${linked.name} picked you as their person. ` +
        `i'll keep one short status message here and only reach out if they might need you. you'll never see their private messages.`,
    );
    await updateSponsorStatus(store.must(p.id));
  }
  return fresh.length;
}

// The safety reply for this text, if it needs one. Sent straight back on the same space.
async function safetyFirst(m: PhotonMessage, text: string | undefined) {
  if (!text) return null;
  const linked = store.linkedByPhone(m.sentBy.handle);
  const route = routeInbound(text, linked?.sponsor?.name);
  if (route.kind !== "crisis" && route.kind !== "withdrawal_emergency") return null;
  if (m.receivedBy) {
    await photon
      .text({ spaceId: m.space.id, senderId: m.receivedBy.id }, route.reply)
      .catch((err) => log.error("safety", "crisis reply failed to send", err));
  }
  const who = linked ?? store.allBySponsorPhone(m.sentBy.handle)[0];
  if (who) store.log(who.id, { kind: "crisis", detail: linked ? route.kind : `${route.kind} (from their person)` });
  log.warn("safety", `${route.kind} message from ${mask(m.sentBy.handle)}; safety reply sent`);
  return route;
}

export async function handlePhotonEvent(event: PhotonEvent) {
  if (event.type !== "message.received") return;
  const m = event.data?.object;
  if (!m || m.status !== "received" || m.sentBy?.kind === "agent" || m.platform !== "imessage") return;
  if (!m.sentBy?.handle || !m.space?.id) return;
  const text = m.content.type === "text" ? m.content.text?.trim() : undefined;

  const safety = await safetyFirst(m, text);
  await linkSponsorships(m);
  if (await handleSignIn(m, safety?.reply)) return;

  const resolved = resolvePerson(m);
  if (resolved) return handlePersonMessage(resolved.person, m, resolved.restored, safety?.reply);

  const sponsees = store.allBySponsorPhone(m.sentBy.handle);
  if (sponsees.length) return handleSponsorMessage(sponsees, m, Boolean(safety));

  // Someone we don't know: one friendly pointer a day, nothing else stored about them.
  if (safety || m.content.type !== "text" || !m.receivedBy) return;
  const last = store.unknownRepliedAt(m.sentBy.handle);
  if (last && clock.now().getTime() - new Date(last).getTime() < UNKNOWN_REPLY_GAP_MS) return;
  store.markUnknownReplied(m.sentBy.handle);
  await photon
    .text(
      { spaceId: m.space.id, senderId: m.receivedBy.id },
      "hi, i'm andi, a recovery companion. to get started, download the andi app and follow the steps there. if you're in crisis, call or text 988.",
    )
    .catch((err) => log.error("andi", "reply to unknown sender failed", err));
}

function remember(personId: string, turns: Turn[]) {
  store.update(personId, (x) => {
    x.chat.push(...turns);
    if (x.chat.length > MAX_CHAT_TURNS) x.chat.splice(0, x.chat.length - MAX_CHAT_TURNS);
  });
}

async function handlePersonMessage(p: Person, m: PhotonMessage, restored: boolean, safetyReply?: string) {
  const firstContact = !p.photon.spaceId;
  store.update(p.id, (x) => {
    x.photon.spaceId = m.space.id;
    x.photon.agentUserId = m.receivedBy?.id ?? x.photon.agentUserId;
    x.photon.userId = m.sentBy.id;
    if (m.receivedBy?.handle && !x.photon.andiNumber) x.photon.andiNumber = m.receivedBy.handle;
    if (m.content.type === "message.read") x.photon.lastReadAt = nowIso();
    else x.photon.lastInboundAt = nowIso();
    if (firstContact) x.linkCode = undefined;
  });

  const c = m.content;
  if (c.type === "message.read") return;
  store.log(p.id, { kind: "inbound", detail: c.type });
  await photon.markRead(m.id);
  if (firstContact) {
    store.log(p.id, { kind: "linked" });
    log.info("link", `linked ${p.id} (${mask(m.sentBy.handle)})`);
  }

  // A crisis message was already answered: keep the record and re-score, but never follow it
  // with a cheerful welcome or a model reply.
  if (safetyReply) {
    if (c.type === "text" && c.text) {
      remember(p.id, [
        { role: "user", content: c.text.trim().slice(0, 2000) },
        { role: "assistant", content: safetyReply },
      ]);
    }
    await evaluate(p.id, "crisis");
    return;
  }

  if (restored) {
    await textPerson(store.must(p.id), `welcome back, ${p.name.toLowerCase()}. everything's right where you left it. day ${daysSober(p)}.`);
    return;
  }
  if (firstContact) {
    await welcomeNewPerson(store.must(p.id));
    return;
  }

  // HALT check-in poll vote.
  if (c.type === "poll.vote") {
    const ids = (c.selectedOptions ?? []).map((o) => o.id);
    await onCheckin(p.id, {
      hungry: ids.includes("hungry"),
      angry: ids.includes("angry"),
      lonely: ids.includes("lonely"),
      tired: ids.includes("tired"),
      source: "imessage",
    });
    await textPerson(store.must(p.id), checkinReply(ids.filter((i) => i !== "none"), p.sponsor?.name));
    return;
  }

  // A tapback on one of Andi's messages reads as "i'm ok". It also clears the silence signal.
  if (c.type === "reaction") {
    await evaluate(p.id, "reaction");
    return;
  }

  if (c.type !== "text" || !c.text?.trim()) return;
  const text = c.text.trim().slice(0, 2000);

  // Bare keywords only ("CALL", "call sam", "breathe"), so "call me crazy but..." reaches the brain.
  const sponsorWord = p.sponsor?.name.toLowerCase().replace(/[^a-z0-9 ]/g, "") ?? "sam";
  const callRe = new RegExp(`^call( (${sponsorWord}|them|my person|my sponsor|him|her))?[.!]*$`, "i");
  if (callRe.test(text)) {
    const r = await callPerson(p.id, "imessage");
    if (r.via === "cooldown") await textPerson(store.must(p.id), "already on it. they should be calling you any second.");
    return;
  }
  if (/^breathe?[.!]*$/i.test(text)) {
    await startBreathing(p.id, "imessage");
    await textPerson(
      store.must(p.id),
      config.features.chip
        ? "ok. in for 4, hold 4, out for 6. if you have your chip, follow the light. i'm right here."
        : "ok. in for 4, hold 4, out for 6. tap breathe in the andi app (or its widget, or your action button) to follow the circle. i'm right here.",
    );
    return;
  }

  // "went for a walk", "heading to a meeting": only the kind is kept, for what-helped learning.
  for (const kind of copingMentions(text)) store.log(p.id, { kind: "coping", detail: kind });

  await evaluate(p.id, "inbound");
  const fresh = store.must(p.id);
  const result = await think(text, agentContext(fresh), fresh.chat);
  remember(p.id, [
    { role: "user", content: text },
    { role: "assistant", content: result.reply },
  ]);

  if (result.route === "crisis") store.log(p.id, { kind: "crisis" });
  if (result.halt) await onCheckin(p.id, { ...result.halt, source: "imessage" });
  if (result.intent === "slip") await onSlip(p.id, text.slice(0, 140));

  await textPerson(store.must(p.id), result.reply);

  // A win gets a heart on their own message, the way a friend would react.
  if (result.celebrate && (result.route === "model" || result.route === "fallback")) await heart(store.must(p.id), m.id);
  if (result.intent === "voice_note") await sendVoiceNote(store.must(p.id), result.reply, "asked");

  if (result.intent === "call_person") await callPerson(p.id, "imessage");
  if (result.intent === "breathe") await startBreathing(p.id, "imessage");
}

// A sponsor texting Andi. Encouragement is passed to their person, clearly attributed and
// checked by the same output guard as Andi's own replies. Someone who is the person for more
// than one Andi user starts the message with a name: "Ann: proud of you".
async function handleSponsorMessage(sponsees: Person[], m: PhotonMessage, safetyHandled: boolean) {
  for (const p of sponsees) {
    store.update(p.id, (x) => {
      if (x.sponsor) x.sponsor.photon.lastInboundAt = nowIso();
    });
  }
  if (m.content.type === "message.read") return;
  await photon.markRead(m.id);
  if (safetyHandled || m.content.type !== "text" || !m.content.text?.trim()) return;
  const raw = m.content.text.trim().slice(0, 1000);
  if (/^(hi|hey|hello) andi\b/i.test(raw) && raw.length < 24) return; // the intro already went out

  let target: Person | undefined;
  let body = raw;
  if (sponsees.length === 1) target = sponsees[0];
  else {
    const named = raw.match(/^([^:]{1,40}):\s*([\s\S]+)$/);
    target = named ? sponsees.find((p) => p.name.toLowerCase() === named[1].trim().toLowerCase()) : undefined;
    if (target && named) body = named[2].trim();
  }
  if (!target) {
    const names = sponsees.map((p) => p.name);
    await textSponsor(
      sponsees[0],
      `you're the person for ${names.join(" and ")} through andi. start with a name so i know who it's for, like "${names[0]}: proud of you".`,
    );
    return;
  }
  if (!personTarget(target) || !sponsorTarget(target)) return;
  if (violatesGuard(body)) {
    await textSponsor(target, `i didn't pass that one along. i keep messages to ${target.name} free of anything about drinking or medication. want to try different words?`);
    return;
  }
  await textPerson(target, `from ${target.sponsor!.name}: "${body}"`);
  await textSponsor(target, `passed that along to ${target.name}.`);
}

// Daily HALT check-in as a native iMessage poll.
export async function sendCheckinPoll(p: Person) {
  const t = personTarget(p);
  if (!t) return null;
  const sent = await photon.poll(t, "quick check-in: any of these tonight?", [
    { id: "hungry", text: "hungry" },
    { id: "angry", text: "angry" },
    { id: "lonely", text: "lonely" },
    { id: "tired", text: "tired" },
    { id: "none", text: "none, i'm good" },
  ]);
  store.update(p.id, (x) => {
    x.photon.lastCheckinPollId = sent.id;
  });
  return sent.id ?? null;
}
