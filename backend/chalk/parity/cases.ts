// Generates random inputs and the TypeScript result for each (stdout JSON).
// Used by chalk/parity/check.py to prove the Chalk resolvers match src/risk/score.ts and
// src/risk/patterns.ts exactly.
import { scoreRisk } from "../../src/risk/score.js";
import { INTERVENTIONS, summarizePatterns } from "../../src/risk/patterns.js";
import { encodeWindow } from "../../src/chalk/client.js";

const rnd = (n: number) => Math.floor(Math.random() * n);
const maybe = (v: number) => (Math.random() < 0.4 ? null : v);

const risk = [];
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
  risk.push({ s, r: scoreRisk(s) });
}

const patterns = [];
for (let i = 0; i < 5000; i++) {
  // Clustered hard moments (a favourite evening) plus noise, so every branch gets exercised.
  const cells = new Map<string, number>();
  const favW = rnd(7);
  const favH = 17 + rnd(7);
  const n = rnd(30);
  for (let k = 0; k < n; k++) {
    const clustered = Math.random() < 0.6;
    const w = clustered ? (Math.random() < 0.5 ? favW : rnd(7)) : rnd(7);
    const h = clustered ? (favH + rnd(3)) % 24 : rnd(24);
    const key = `${w}:${h}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const inputs = {
    historyDays: rnd(60),
    hardMoments: [...cells.entries()].map(([k, v]) => `${k}:${v}`).join("|"),
    halt: `hungry:${rnd(8)}|angry:${rnd(8)}|lonely:${rnd(8)}|tired:${rnd(8)}`,
    placeEnters: rnd(8),
    interventions: INTERVENTIONS.filter(() => Math.random() < 0.5)
      .map((k) => {
        const t = rnd(8);
        return `${k}:${t}:${rnd(t + 1)}`;
      })
      .join("|"),
  };
  const out = summarizePatterns(inputs);
  patterns.push({
    i: inputs,
    r: [out.ready, encodeWindow(out.riskyWindow), out.topTrigger ?? "", out.whatHelped ?? "", out.confidence],
  });
}

console.log(JSON.stringify({ risk, patterns }));
