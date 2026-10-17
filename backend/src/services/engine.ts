// The risk engine: every signal (geofence, purchase, check-in, silence, time) flows through
// evaluate(), which asks Chalk for the risk level and then updates the chip, the sponsor's
// status, and (on high risk, with consent) alerts the sponsor.

import { getRisk } from "../chalk/client.js";
import { chipHub, type ChipGlow, type ChipMode } from "../chip/hub.js";
import { clock } from "../clock.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { moneySaved } from "../nessie/client.js";
import { buildSignals, localClock } from "../risk/signals.js";
import { daysSober, nowIso, store, withLock } from "../store.js";
import type { CheckIn, Person, RiskLevel } from "../types.js";
import { maybeAlertSponsor, updateSponsorStatus } from "./sponsor.js";
import { textPerson } from "./targets.js";
import { releasePersonLines } from "./lines.js";

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

export function inQuietHours(now = clock.now(), timezone?: string) {
  const { hour } = localClock(now, timezone);
  const { quietStartHour: s, quietEndHour: e } = config;
  return s <= e ? hour >= s && hour < e : hour >= s || hour < e;
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

function markOutreach(p: Person) {
  store.update(p.id, (x) => {
    x.lastOutreachAt = nowIso();
  });
  store.log(p.id, { kind: "outreach" });
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

export async function onAlcoholPurchase(personId: string, merchant: string, amount: number) {
  const p = store.must(personId);
  if (!p.consents.purchases) return null;
  const purchase = { at: nowIso(), merchant, amount };
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
async function expirePending() {
  const now = clock.now().getTime();
  for (const p of store.all()) {
    if (p.photon.spaceId || now - new Date(p.createdAt).getTime() < PENDING_TTL_MS) continue;
    store.remove(p.id);
    log.info("tick", `expired pending signup ${p.id}`);
    await releasePersonLines(p);
  }
}

export async function tick() {
  await expirePending().catch((err) => log.error("tick", "expiring pending signups failed", err));
  for (const p of store.all()) {
    try {
      const risk = await evaluate(p.id, "tick");
      const fresh = store.get(p.id);
      if (!fresh || inQuietHours(clock.now(), fresh.timezone)) continue;
      const sinceOutreach = fresh.lastOutreachAt ? clock.now().getTime() - new Date(fresh.lastOutreachAt).getTime() : Infinity;
      if (risk.level !== "low" && sinceOutreach > NUDGE_GAP_MS && unansweredNudges(fresh) < MAX_UNANSWERED_NUDGES) {
        await textPerson(fresh, "thinking of you tonight. how are you doing, honestly?");
        markOutreach(fresh);
      }
      const day = daysSober(fresh);
      const already = fresh.events.some((e) => e.kind === "milestone" && e.detail === String(day));
      if (MILESTONES.includes(day) && !already) {
        store.log(fresh.id, { kind: "milestone", detail: String(day) });
        pushChip(fresh, "milestone", `${day} days`);
        await textPerson(fresh, `day ${day}. ${day === 1 ? "one morning" : `${day} mornings`} you remember. i'm really proud of you.`);
      }
    } catch (err) {
      log.error("tick", `person ${p.id}`, err);
    }
  }
}
