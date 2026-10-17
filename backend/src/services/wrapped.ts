// Andi Wrapped: the 90-day story, computed from the event log. The iOS app renders it.

import { moneySaved } from "../nessie/client.js";
import { daysSober } from "../store.js";
import type { Person } from "../types.js";
import { alcoholSpend } from "./engine.js";

const day = (iso: string) => iso.slice(0, 10);

export function wrapped(p: Person) {
  const ev = p.events;
  const slipDays = new Set(p.slips.map((s) => day(s.at)));
  const hardDays = new Set(
    ev.filter((e) => e.kind === "place_enter" || e.kind === "purchase" || (e.kind === "risk_change" && e.level === "high")).map((e) => day(e.at)),
  );
  const nightsProtected = [...hardDays].filter((d) => !slipDays.has(d)).length;

  const highs = ev.filter((e) => e.kind === "risk_change" && e.level === "high");
  const hardest = highs.find((h) => !slipDays.has(day(h.at))) ?? highs[0];

  const lonelyCheckins = p.checkins.filter((c) => c.lonely).length;

  return {
    name: p.name,
    days: daysSober(p),
    mornings: daysSober(p),
    moneySaved: moneySaved(p.weeklyDrinkSpend, daysSober(p), alcoholSpend(p)),
    nightsProtected,
    urgesRidden: ev.filter((e) => e.kind === "breathe").length,
    callsToYourPerson: ev.filter((e) => e.kind === "call").length,
    checkins: p.checkins.length,
    lonelyNightsYouReachedOut: lonelyCheckins,
    hardestNight: hardest ? { date: day(hardest.at), why: hardest.detail ?? null } : null,
    milestones: ev.filter((e) => e.kind === "milestone").map((e) => Number(e.detail)),
    slips: p.slips.length,
    sponsorName: p.sponsor?.name ?? null,
    why: p.whyText ?? null,
  };
}
