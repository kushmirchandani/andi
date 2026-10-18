// The risk engine: every signal (geofence, purchase, check-in, silence, time) flows through
// evaluate(), which asks Chalk for the risk level and then updates the chip, the sponsor's
// status, and (on high risk, with consent) alerts the sponsor.

import { getPatterns, getRisk } from "../chalk/client.js";
import { chipHub, type ChipGlow, type ChipMode } from "../chip/hub.js";
import { clock } from "../clock.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { moneySaved } from "../nessie/client.js";
import { buildSignals, localClock } from "../risk/signals.js";
import { localParts, nudgeText, patternInputs, type RiskyWindow } from "../risk/patterns.js";
import { daysSober, nowIso, store, withLock } from "../store.js";
import type { CheckIn, LearnedPatterns, Person, QuietHours, RiskLevel } from "../types.js";
import { maybeAlertSponsor, updateSponsorStatus } from "./sponsor.js";
import { textPerson } from "./targets.js";
import { sendMilestoneCard, sendVoiceNote } from "./rich.js";
import { releasePersonLines, releaseSignInLine } from "./lines.js";

const GLOW: Record<RiskLevel, ChipGlow> = { low: "steady", elevated: "warm", high: "alert" };
export const MILESTONES = [1, 3, 7, 14, 30, 60, 90, 180, 365];
const PLACE_REPEAT_MS = 30 * 60_000; // don't re-ask "do you want to be here?" for the same place within 30 min
const NUDGE_GAP_MS = 3 * 3600_000; // at most one proactive nudge every 3 hours
const MAX_UNANSWERED_NUDGES = 2; // then stop until they text back
const BREATHE_MS = 2 * 60_000;

export function alcoholSpend(p: Person) {
  return p.purchases.reduce((sum, x) => sum + x.amount, 0);
}

export function saved(p: Person) {
  return moneySaved(p.weeklyDrinkSpend, daysSober(p), alcoholSpend(p));
}

export function pushChip(p: Person, mode: ChipMode = "idle", line?: string) {
  if (!config.features.chip) return; // paused: nothing to light up
  chipHub.push(p.id, {
    type: "state",
    day: daysSober(p),
    glow: GLOW[p.lastRisk?.level ?? "low"],
    mode,
    saved: saved(p),
    line,
  });
}

// A chip that connects before anything was pushed gets the current state right away.
chipHub.onChipConnect((personId) => {
  const p = store.get(personId);
  if (p) pushChip(p);
});

// The person's own quiet hours from the app, or the server default.
export function quietHoursFor(p?: Pick<Person, "quietHours">): QuietHours {
  return p?.quietHours ?? { enabled: true, start: config.quietStartHour, end: config.quietEndHour };
}

export function inQuietHours(now = clock.now(), timezone?: string, quiet = quietHoursFor()) {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const { hour } = localClock(now, timezone);
  const { start: s, end: e } = quiet;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export function evaluate(personId: string, trigger: string) {
  return withLock(personId, async () => {
    const p = store.must(personId);
    const risk = await getRisk(p.id, buildSignals(p));
    const prev = p.lastRisk?.level;
    store.update(p.id, (x) => {
      x.lastRisk = { ...risk, at: nowIso() };
    });
    if (prev !== risk.level) {
      store.log(p.id, { kind: "risk_change", level: risk.level, detail: `${trigger}: ${risk.reasons.join("; ")}` });
      log.info("risk", `${p.id} ${prev ?? "none"} -> ${risk.level} (${risk.score}, ${risk.source}) on ${trigger}`);
    }
    const fresh = store.must(personId);
    pushChip(fresh);
    await updateSponsorStatus(fresh);
    if (risk.level === "high") await maybeAlertSponsor(store.must(personId));
    return { ...risk, at: store.must(personId).lastRisk!.at };
  });
}

function markOutreach(p: Person, detail?: string) {
  store.update(p.id, (x) => {
    x.lastOutreachAt = nowIso();
  });
  store.log(p.id, { kind: "outreach", detail });
}

// MARK: "Andi learns you"

const PATTERN_REFRESH_MS = 6 * 3600_000; // patterns move slowly
const PATTERN_LEAD_MIN = 20; // nudge 20-60 minutes before their usual hard stretch
const PATTERN_LEAD_MAX = 60;
const PATTERN_NUDGE_GAP_MS = 20 * 3600_000; // at most one pattern nudge a day

/** Re-learns a person's patterns from their history (Chalk when available, else locally). */
export async function refreshPatterns(personId: string, force = false): Promise<LearnedPatterns | undefined> {
  const p = store.get(personId);
  if (!p) return undefined;
  if (!force && p.patterns && clock.now().getTime() - new Date(p.patterns.at).getTime() < PATTERN_REFRESH_MS) return p.patterns;
  const summary = await getPatterns(p.id, patternInputs(p));
  const learned: LearnedPatterns = { ...summary, at: nowIso() };
  store.update(p.id, (x) => {
    x.patterns = learned;
  });
  return learned;
}

/** Minutes from now until the next start of the window, in the person's time zone. */
export function minutesUntilWindow(now: Date, timezone: string | undefined, w: RiskyWindow) {
  const l = localParts(now, timezone);
  const nowMin = l.hour * 60 + l.minute;
  const startMin = w.startHour * 60;
  if (w.weekday === null) {
    const d = startMin - nowMin;
    return d < 0 ? d + 1440 : d;
  }
  const d = ((w.weekday - l.weekday + 7) % 7) * 1440 + startMin - nowMin;
  return d < 0 ? d + 7 * 1440 : d;
}

// One warm, specific text before their usual hard stretch: "it's almost friday night. last time
// it got hard, the walk helped. want to plan one?" Same limits as every proactive text (quiet
// hours, the 3-hour gap, stop after two unanswered), plus once a day.
async function maybePatternNudge(p: Person) {
  const s = p.patterns;
  if (!s?.ready || !s.riskyWindow || !p.photon.spaceId) return;
  if (p.lastPatternNudgeAt && clock.now().getTime() - new Date(p.lastPatternNudgeAt).getTime() < PATTERN_NUDGE_GAP_MS) return;
  const until = minutesUntilWindow(clock.now(), p.timezone, s.riskyWindow);
  if (until < PATTERN_LEAD_MIN || until > PATTERN_LEAD_MAX) return;
  const sinceOutreach = p.lastOutreachAt ? clock.now().getTime() - new Date(p.lastOutreachAt).getTime() : Infinity;
  if (sinceOutreach <= NUDGE_GAP_MS || unansweredNudges(p) >= MAX_UNANSWERED_NUDGES) return;
  await textPerson(p, nudgeText(s, p.sponsor?.name));
  store.update(p.id, (x) => {
    x.lastPatternNudgeAt = nowIso();
  });
  markOutreach(p, "pattern");
}

// "Do you want to be here?" (the A-CHESS mechanic), triggered by an iOS geofence or Find My.
export async function onPlaceEnter(personId: string, placeId: string) {
  const p = store.must(personId);
  const place = p.places.find((x) => x.id === placeId);
  if (!place || !p.consents.location) return null;

  const recent =
    p.lastPlaceEnter?.placeId === placeId && clock.now().getTime() - new Date(p.lastPlaceEnter.at).getTime() < PLACE_REPEAT_MS;
  store.update(p.id, (x) => {
    x.lastPlaceEnter = { at: nowIso(), placeId };
  });
  store.log(p.id, { kind: "place_enter", detail: place.name });
  const risk = await evaluate(p.id, "place_enter");
  if (recent) return risk;

  const person = store.must(personId);
  const who = person.sponsor?.name ?? "someone";
  await textPerson(
    person,
    `hey ${person.name.toLowerCase()}. looks like you're near ${place.name}. do you want to be here right now?`,
    `${place.alternative ? `${place.alternative}. ` : ""}reply CALL and i'll get ${who} on the phone, or BREATHE and we'll ride it out together.`,
  );
  markOutreach(person);
  return risk;
}

export async function onPlaceExit(personId: string, placeId: string) {
  const p = store.must(personId);
  const place = p.places.find((x) => x.id === placeId);
  if (!place) return null;
  store.log(p.id, { kind: "place_exit", detail: place.name });
  return evaluate(p.id, "place_exit");
}

// txId: the Nessie transaction, when there is one. A purchase already seen is ignored (returns null).
export async function onAlcoholPurchase(personId: string, merchant: string, amount: number, txId?: string) {
  const p = store.must(personId);
  if (!p.consents.purchases) return null;
  if (txId && p.purchases.some((x) => x.txId === txId)) return null;
  const purchase = { at: nowIso(), merchant, amount, ...(txId ? { txId } : {}) };
  store.update(p.id, (x) => {
    x.lastAlcoholPurchase = purchase;
    x.purchases.push(purchase);
    if (x.purchases.length > 500) x.purchases.splice(0, x.purchases.length - 500);
  });
  store.log(p.id, { kind: "purchase", detail: `${merchant} $${amount}` });
  const risk = await evaluate(p.id, "purchase");
  const fresh = store.must(personId);
  await textPerson(fresh, `saw a stop at ${merchant}. no judgment at all. how's tonight going?`);
  markOutreach(fresh);
  return risk;
}

export async function onCheckin(personId: string, c: Omit<CheckIn, "at">) {
  store.update(personId, (x) => {
    x.checkins.push({ at: nowIso(), ...c });
    if (x.checkins.length > 1000) x.checkins.splice(0, x.checkins.length - 1000);
  });
  const flags = (["hungry", "angry", "lonely", "tired"] as const).filter((k) => c[k]);
  store.log(personId, { kind: "checkin", detail: flags.join(",") || "none" });
  return evaluate(personId, "checkin");
}

export function checkinReply(flags: string[], sponsorName?: string) {
  if (flags.length === 0) return "love that. thanks for checking in.";
  if (flags.includes("lonely"))
    return `thanks for being honest. lonely nights are the hard ones. want me to nudge ${sponsorName ?? "someone"} to call?`;
  if (flags.includes("hungry")) return "thanks for telling me. eat something real first, it genuinely helps. then tell me how you feel.";
  if (flags.includes("tired")) return "thanks for telling me. tired makes everything louder. could tonight be an early night?";
  return "thanks for telling me. want to talk about what's got you wound up?";
}

const breathingTimers = new Map<string, NodeJS.Timeout>();

export async function startBreathing(personId: string, from: "chip" | "imessage" | "app" | "voice") {
  const p = store.must(personId);
  store.log(p.id, { kind: "breathe", detail: from });
  pushChip(p, "breathing", "in 4 · hold 4 · out 6");
  clearTimeout(breathingTimers.get(personId));
  breathingTimers.set(
    personId,
    setTimeout(() => {
      breathingTimers.delete(personId);
      const fresh = store.get(personId);
      if (fresh) pushChip(fresh);
    }, BREATHE_MS).unref(),
  );
  if (from === "chip" || from === "app") await textPerson(p, "breathing with you. in for 4, hold for 4, out for 6. the urge will pass.");
  // Without the chip, a round started from iMessage or a call points to the app's breathing screen.
  if (!config.features.chip && from === "voice")
    await textPerson(p, "breathe along with me: in for 4, hold for 4, out for 6. tap breathe in the andi app (or its widget, or your action button) to follow the circle.");
}

export async function onSlip(personId: string, note?: string) {
  store.update(personId, (x) => {
    x.slips.push({ at: nowIso(), note });
  });
  store.log(personId, { kind: "slip", detail: note });
  return evaluate(personId, "slip");
}

// How many proactive nudges in a row have gone unanswered.
function unansweredNudges(p: Person) {
  const lastIn = p.photon.lastInboundAt ? new Date(p.photon.lastInboundAt).getTime() : 0;
  return p.events.filter((e) => e.kind === "outreach" && new Date(e.at).getTime() > lastIn).length;
}

// Runs every 10 minutes: re-scores everyone, nudges when risk is up, and sends milestones.
// Proactive texts respect quiet hours and stop after two unanswered nudges.
const PENDING_TTL_MS = 48 * 3600_000;

// Signups that never texted Andi within 48 hours are removed, and their Photon seats freed.
// Sign-ins that never finished (no text, or verified but never onboarded) go the same way.
async function expirePending() {
  const now = clock.now().getTime();
  for (const p of store.all()) {
    if (p.photon.spaceId || now - new Date(p.createdAt).getTime() < PENDING_TTL_MS) continue;
    store.remove(p.id);
    log.info("tick", `expired pending signup ${p.id}`);
    await releasePersonLines(p);
  }
  for (const s of store.signIns()) {
    if (now - new Date(s.createdAt).getTime() < PENDING_TTL_MS) continue;
    store.removeSignIn(s.id);
    await releaseSignInLine(s);
  }
}

export async function tick() {
  await expirePending().catch((err) => log.error("tick", "expiring pending signups failed", err));
  for (const p of store.all()) {
    try {
      const risk = await evaluate(p.id, "tick");
      await refreshPatterns(p.id).catch((err) => log.warn("tick", `patterns for ${p.id}`, err));
      const fresh = store.get(p.id);
      if (!fresh || inQuietHours(clock.now(), fresh.timezone, quietHoursFor(fresh))) continue;
      const sinceOutreach = fresh.lastOutreachAt ? clock.now().getTime() - new Date(fresh.lastOutreachAt).getTime() : Infinity;
      if (risk.level !== "low" && sinceOutreach > NUDGE_GAP_MS && unansweredNudges(fresh) < MAX_UNANSWERED_NUDGES) {
        await textPerson(fresh, "thinking of you tonight. how are you doing, honestly?");
        markOutreach(fresh);
      }
      await maybePatternNudge(store.must(p.id));
      const day = daysSober(fresh);
      const already = fresh.events.some((e) => e.kind === "milestone" && e.detail === String(day));
      if (MILESTONES.includes(day) && !already) {
        store.log(fresh.id, { kind: "milestone", detail: String(day) });
        pushChip(fresh, "milestone", `${day} days`);
        const words = `day ${day}. ${day === 1 ? "one morning" : `${day} mornings`} you remember. i'm really proud of you.`;
        await textPerson(fresh, words);
        // The card and a voice note make the day feel like an occasion; the text above stands alone.
        await sendMilestoneCard(store.must(fresh.id), day);
        await sendVoiceNote(store.must(fresh.id), `${fresh.name.toLowerCase()}, ${words}`, `milestone ${day}`);
      }
    } catch (err) {
      log.error("tick", `person ${p.id}`, err);
    }
  }
}
