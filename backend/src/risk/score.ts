// The one risk function. It is used in three places, so the numbers mean the same thing everywhere:
//   1. live, as the local fallback when Chalk isn't configured
//   2. mirrored in chalk/features.py as the Chalk resolver
//   3. inside Daytona sandboxes for threshold tuning (redteam/tune.ts bundles this file)
// Keep it dependency-free and pure.

export type Level = "low" | "elevated" | "high";

export interface RiskSignals {
  hour: number; // 0-23, local time
  weekday: number; // 0 = Sunday
  nearRiskPlace: boolean; // inside a geofence the person marked
  minutesSincePlaceEnter: number | null;
  minutesSinceAlcoholPurchase: number | null;
  haltCount: number; // 0-4 from the latest check-in in the last 24h
  hoursSinceCheckin: number | null;
  hoursSilent: number | null; // hours since an outreach went unanswered
  daysSober: number;
  daysSinceSlip: number | null;
}

export interface RiskThresholds {
  elevated: number;
  high: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { elevated: 35, high: 65 };

export interface RiskResult {
  score: number;
  level: Level;
  reasons: string[];
}

export function scoreRisk(s: RiskSignals, t: RiskThresholds = DEFAULT_THRESHOLDS): RiskResult {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (s.nearRiskPlace && (s.minutesSincePlaceEnter ?? 0) <= 90) add(30, "Near a place they marked as risky");

  if (s.minutesSinceAlcoholPurchase !== null) {
    if (s.minutesSinceAlcoholPurchase <= 120) add(40, "Recent purchase at an alcohol seller");
    else if (s.minutesSinceAlcoholPurchase <= 24 * 60) add(15, "Alcohol-seller purchase in the last day");
  }

  const night = s.hour >= 21 || s.hour < 3;
  if (night) add(10, "Late night");
  const weekendNight =
    ((s.weekday === 5 || s.weekday === 6) && s.hour >= 20) || ((s.weekday === 6 || s.weekday === 0) && s.hour < 3);
  if (weekendNight) add(8, "Weekend night");

  if (s.haltCount > 0) add(7 * Math.min(4, s.haltCount), `Feeling ${s.haltCount} of hungry, angry, lonely, tired`);
  if (s.hoursSinceCheckin !== null && s.hoursSinceCheckin > 30) add(8, "No check-in for over a day");
  if (s.hoursSilent !== null && s.hoursSilent > 12) add(10, "Hasn't answered recent messages");

  if (s.daysSober < 30) add(8, "First 30 days");
  else if (s.daysSober < 90) add(4, "First 90 days");

  if (s.daysSinceSlip !== null && s.daysSinceSlip <= 3) add(12, "Slip in the last few days");

  score = Math.min(100, score);
  const level: Level = score >= t.high ? "high" : score >= t.elevated ? "elevated" : "low";
  return { score, level, reasons };
}
