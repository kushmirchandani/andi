import { config } from "../config.js";
import { clock } from "../clock.js";
import { daysSober } from "../store.js";
import type { Person } from "../types.js";
import type { RiskSignals } from "./score.js";

const minutesSince = (iso: string | undefined, now: Date) =>
  iso ? Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60_000) : null;

// Hour and weekday in the person's own time zone (falls back to APP_TIMEZONE).
export function localClockParts(now: Date, timezone?: string) {
  const timeZone = validTimezone(timezone) ?? config.timezone;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const label = now.toLocaleString("en-US", { timeZone, weekday: "long", hour: "numeric", minute: "2-digit" });
  return { hour, weekday, label };
}

export const localClock = (now: Date, timezone?: string) => localClockParts(now, timezone);

export function validTimezone(tz: string | undefined | null) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function buildSignals(p: Person, now = clock.now()): RiskSignals {
  const { hour, weekday } = localClock(now, p.timezone);

  const enterMin = minutesSince(p.lastPlaceEnter?.at, now);
  const lastExit = [...p.events].reverse().find((e) => e.kind === "place_exit");
  const exitedSinceEnter =
    lastExit && p.lastPlaceEnter && new Date(lastExit.at) > new Date(p.lastPlaceEnter.at);
  const nearRiskPlace = p.consents.location && enterMin !== null && !exitedSinceEnter && enterMin <= 90;

  const purchaseMin = p.consents.purchases ? minutesSince(p.lastAlcoholPurchase?.at, now) : null;

  const latest = p.checkins.at(-1);
  const checkinMin = minutesSince(latest?.at, now);
  const haltCount =
    latest && checkinMin !== null && checkinMin <= 24 * 60
      ? [latest.hungry, latest.angry, latest.lonely, latest.tired].filter(Boolean).length
      : 0;

  // "Silent" = we reached out and haven't heard back since.
  const outMin = minutesSince(p.lastOutreachAt, now);
  const lastIn = p.photon.lastInboundAt ? new Date(p.photon.lastInboundAt) : null;
  const unanswered = p.lastOutreachAt && (!lastIn || lastIn < new Date(p.lastOutreachAt));
  const hoursSilent = unanswered && outMin !== null ? outMin / 60 : null;

  const lastSlip = p.slips.at(-1);
  const slipMin = minutesSince(lastSlip?.at, now);

  return {
    hour,
    weekday,
    nearRiskPlace,
    minutesSincePlaceEnter: nearRiskPlace ? enterMin : null,
    minutesSinceAlcoholPurchase: purchaseMin,
    haltCount,
    hoursSinceCheckin: checkinMin === null ? null : checkinMin / 60,
    hoursSilent,
    daysSober: daysSober(p, now),
    daysSinceSlip: slipMin === null ? null : slipMin / 1440,
  };
}
