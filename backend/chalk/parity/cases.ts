// Generates random signal sets and the TypeScript score for each (stdout JSON).
// Used by chalk/parity/check.py to prove the Chalk resolver matches src/risk/score.ts.
import { scoreRisk } from "../../src/risk/score.js";

const rnd = (n: number) => Math.floor(Math.random() * n);
const maybe = (v: number) => (Math.random() < 0.4 ? null : v);
const out = [];
for (let i = 0; i < 5000; i++) {
  const s = {
    hour: rnd(24),
    weekday: rnd(7),
    nearRiskPlace: Math.random() < 0.5,
    minutesSincePlaceEnter: maybe(rnd(200)),
    minutesSinceAlcoholPurchase: maybe(rnd(3000)),
    haltCount: rnd(5),
    hoursSinceCheckin: maybe(rnd(60)),
    hoursSilent: maybe(rnd(30)),
    daysSober: rnd(400),
    daysSinceSlip: maybe(rnd(10)),
  };
  out.push({ s, r: scoreRisk(s) });
}
console.log(JSON.stringify(out));
