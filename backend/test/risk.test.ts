import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRisk, DEFAULT_THRESHOLDS, type RiskSignals } from "../src/risk/score.js";
import { buildSignals } from "../src/risk/signals.js";
import { daysSober } from "../src/store.js";

const base: RiskSignals = {
  hour: 14,
  weekday: 2,
  nearRiskPlace: false,
  minutesSincePlaceEnter: null,
  minutesSinceAlcoholPurchase: null,
  haltCount: 0,
  hoursSinceCheckin: 2,
  hoursSilent: null,
  daysSober: 200,
  daysSinceSlip: null,
};

test("a quiet Tuesday afternoon is low risk with no reasons", () => {
  const r = scoreRisk(base);
  assert.equal(r.level, "low");
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, []);
});

test("Friday 11pm near a marked bar, day 41, is elevated", () => {
  const r = scoreRisk({ ...base, hour: 23, weekday: 5, nearRiskPlace: true, minutesSincePlaceEnter: 2, daysSober: 41 });
  // 30 place + 10 late + 8 weekend + 4 first 90 days = 52
  assert.equal(r.score, 52);
  assert.equal(r.level, "elevated");
  assert.ok(r.reasons.includes("Near a place they marked as risky"));
});

test("adding a liquor-store purchase makes it high", () => {
  const r = scoreRisk({ ...base, hour: 23, weekday: 5, nearRiskPlace: true, minutesSincePlaceEnter: 10, minutesSinceAlcoholPurchase: 5, daysSober: 41 });
  assert.equal(r.level, "high");
  assert.ok(r.score >= DEFAULT_THRESHOLDS.high);
});

test("score is capped at 100", () => {
  const r = scoreRisk({
    ...base,
    hour: 1,
    weekday: 6,
    nearRiskPlace: true,
    minutesSincePlaceEnter: 1,
    minutesSinceAlcoholPurchase: 1,
    haltCount: 4,
    hoursSinceCheckin: 40,
    hoursSilent: 20,
    daysSober: 3,
    daysSinceSlip: 1,
  });
  assert.equal(r.score, 100);
  assert.equal(r.level, "high");
});

test("stale place enter (over 90 min) no longer counts", () => {
  const r = scoreRisk({ ...base, nearRiskPlace: true, minutesSincePlaceEnter: 120 });
  assert.equal(r.score, 0);
});

test("thresholds are configurable (Daytona tuning)", () => {
  const s = { ...base, hour: 23, weekday: 5, daysSober: 10 }; // 10 + 8 + 8 = 26
  assert.equal(scoreRisk(s).level, "low");
  assert.equal(scoreRisk(s, { elevated: 25, high: 50 }).level, "elevated");
});

test("daysSober counts calendar days in the app time zone", () => {
  // 11:30pm Friday Oct 16 in New York is already Oct 17 in UTC.
  const at = new Date("2026-10-16T23:30:00-04:00");
  assert.equal(daysSober({ soberSince: "2026-10-15" }, at), 1);
  assert.equal(daysSober({ soberSince: "2026-10-16" }, at), 0);
  assert.equal(daysSober({ soberSince: "2026-12-01" }, at), 0, "never negative");
});

test("buildSignals respects consent: no location or purchase signal when turned off", () => {
  const now = new Date("2026-10-16T23:05:00-04:00");
  const p: any = {
    soberSince: "2026-09-05",
    consents: { location: false, purchases: false, shareWithSponsor: "status", sponsorAlerts: true },
    lastPlaceEnter: { at: new Date(now.getTime() - 60_000).toISOString(), placeId: "x" },
    lastAlcoholPurchase: { at: new Date(now.getTime() - 60_000).toISOString(), merchant: "m", amount: 1 },
    events: [],
    checkins: [],
    slips: [],
    photon: {},
  };
  const s = buildSignals(p, now);
  assert.equal(s.nearRiskPlace, false);
  assert.equal(s.minutesSinceAlcoholPurchase, null);
  assert.equal(s.hour, 23);
  assert.equal(s.weekday, 5);
});
