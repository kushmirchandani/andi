// Alert tuning: simulate hundreds of weeks of signals and pick risk thresholds that catch
// hard nights without spamming the sponsor. The weeks are split across Daytona sandboxes,
// each running the exact production risk function (src/risk/score.ts, bundled with esbuild).
//
//   npm run tune                    # Daytona
//   npm run tune -- --local         # in-process
//   WEEKS=500 SANDBOXES=10 npm run tune
//
// Synthetic data, so this is calibration, not clinical validation.

import fs from "node:fs";
import path from "node:path";
import { transform } from "esbuild";
import { Daytona } from "@daytona/sdk";

const LOCAL = process.argv.includes("--local");
const WEEKS = Number(process.env.WEEKS ?? 500);
const SANDBOXES = Number(process.env.SANDBOXES ?? 10);

// Candidate thresholds.
const GRID: { elevated: number; high: number }[] = [];
for (let elevated = 20; elevated <= 50; elevated += 5)
  for (let high = elevated + 15; high <= 90; high += 5) GRID.push({ elevated, high });

// The simulation worker. `scoreRisk` is injected from the real source file.
const SIM = `
function rng(seed){ return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function simulate(batch){
  const r = rng(batch.seed);
  const p = (x) => r() < x;
  const nights = [];
  for (let w = 0; w < batch.weeks; w++) {
    const daysSober = Math.floor(5 + r() * 120);
    for (let d = 0; d < 7; d++) {
      const weekday = (d + 5) % 7;              // weeks start on Friday
      const weekend = weekday === 5 || weekday === 6;
      // Hidden truth: is tonight genuinely hard? More likely early on and on weekends.
      const hard = p(0.07 + (weekend ? 0.08 : 0) + (daysSober < 30 ? 0.06 : 0));
      const hour = [18, 19, 20, 21, 22, 23, 0, 1][Math.floor(r() * 8)];
      const near = hard ? p(0.55) : p(0.06);    // walking past the bar on the way home is noise
      const purchase = hard ? p(0.35) : p(0.03);
      const halt = hard ? Math.min(4, Math.floor(r() * 4) + 1) : (p(0.35) ? 1 : 0);
      const silent = hard ? p(0.35) : p(0.08);
      const slip = p(hard ? 0.12 : 0.03);
      const s = {
        hour, weekday, nearRiskPlace: near, minutesSincePlaceEnter: near ? r() * 60 : null,
        minutesSinceAlcoholPurchase: purchase ? r() * 180 : (p(0.04) ? 300 + r() * 900 : null),
        haltCount: halt, hoursSinceCheckin: p(0.2) ? 31 + r() * 20 : r() * 24,
        hoursSilent: silent ? 12 + r() * 12 : null, daysSober, daysSinceSlip: slip ? r() * 3 : null,
      };
      nights.push({ hard, s });
    }
  }
  return batch.grid.map((t) => {
    let caught = 0, escalated = 0, missed = 0, falseSponsor = 0, noisyOutreach = 0, hardTotal = 0;
    for (const n of nights) {
      const level = scoreRisk(n.s, t).level;
      if (n.hard) { hardTotal++; if (level === "low") missed++; else caught++; if (level === "high") escalated++; }
      else { if (level === "high") falseSponsor++; if (level !== "low") noisyOutreach++; }
    }
    return { ...t, caught, escalated, missed, falseSponsor, noisyOutreach, hardTotal, nights: nights.length };
  });
}
`;

async function workerSource() {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/risk/score.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", format: "cjs" });
  return `${code}\n${SIM}\nconst batch = JSON.parse(require("fs").readFileSync("batch.json","utf8"));\nconsole.log("__RESULT__" + JSON.stringify(simulate(batch)));\n`;
}

type Row = { elevated: number; high: number; caught: number; escalated: number; missed: number; falseSponsor: number; noisyOutreach: number; hardTotal: number; nights: number };

async function runBatch(code: string, batch: object, daytona?: Daytona): Promise<Row[]> {
  const parse = (out: string) => JSON.parse(out.slice(out.indexOf("__RESULT__") + 10).trim());
  if (!daytona) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "andi-tune-"));
    fs.writeFileSync(path.join(dir, "batch.json"), JSON.stringify(batch));
    fs.writeFileSync(path.join(dir, "sim.cjs"), code);
    const { execFileSync } = await import("node:child_process");
    return parse(execFileSync(process.execPath, ["sim.cjs"], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 }));
  }
  const sandbox = await daytona.create({ language: "javascript", labels: { app: "andi", job: "tune" }, autoStopInterval: 15, ephemeral: true });
  try {
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(batch)), "batch.json");
    await sandbox.fs.uploadFile(Buffer.from(code), "sim.cjs");
    const res = await sandbox.process.executeCommand("node sim.cjs", undefined, undefined, 300);
    return parse(res.result);
  } finally {
    await daytona.delete(sandbox).catch(() => {});
  }
}

async function main() {
  const code = await workerSource();
  const per = Math.ceil(WEEKS / SANDBOXES);
  const batches = Array.from({ length: SANDBOXES }, (_, i) => ({ seed: 1000 + i, weeks: per, grid: GRID }));
  const daytona = LOCAL ? undefined : new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  if (!LOCAL && !process.env.DAYTONA_API_KEY) throw new Error("Set DAYTONA_API_KEY, or run with --local");

  console.log(`Tuning on ${per * SANDBOXES} simulated weeks across ${SANDBOXES} ${LOCAL ? "local workers" : "Daytona sandboxes"}...`);
  const started = Date.now();
  const results = await Promise.all(batches.map((b) => runBatch(code, b, daytona)));

  // Merge the batches.
  const merged = new Map<string, Row>();
  for (const rows of results)
    for (const r of rows) {
      const k = `${r.elevated}/${r.high}`;
      const m = merged.get(k);
      if (!m) merged.set(k, { ...r });
      else for (const f of ["caught", "escalated", "missed", "falseSponsor", "noisyOutreach", "hardTotal", "nights"] as const) m[f] += r[f];
    }

  const weeks = per * SANDBOXES;
  const rows = [...merged.values()].map((r) => ({
    elevated: r.elevated,
    high: r.high,
    catchRate: r.caught / r.hardTotal, // hard nights where Andi reached out
    escalationRate: r.escalated / r.hardTotal, // hard nights the sponsor heard about
    sponsorPingsPerWeek: r.falseSponsor / weeks, // sponsor pinged on a fine night
    extraCheckinsPerWeek: r.noisyOutreach / weeks, // Andi checked in on a fine night
  }));

  // Pick: most hard nights caught, with sponsors pinged by mistake under once a month
  // and at most ~1.5 unneeded check-ins a week. Ties go to more escalation.
  const ok = rows.filter((r) => r.sponsorPingsPerWeek <= 0.25 && r.extraCheckinsPerWeek <= 1.5);
  const best = (ok.length ? ok : rows).sort((a, b) => b.catchRate - a.catchRate || b.escalationRate - a.escalationRate)[0];

  const dir = path.join(import.meta.dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tune.json"), JSON.stringify({ at: new Date().toISOString(), weeks, mode: LOCAL ? "local" : "daytona", best, rows }, null, 2));

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
  console.log(`Recommended thresholds: elevated ${best.elevated}, high ${best.high}`);
  console.log(`  catches ${pct(best.catchRate)} of hard nights, escalates ${pct(best.escalationRate)} to the sponsor`);
  console.log(`  ${best.sponsorPingsPerWeek.toFixed(2)} unneeded sponsor pings/week, ${best.extraCheckinsPerWeek.toFixed(2)} extra check-ins/week`);
  console.log(`\nUpdate DEFAULT_THRESHOLDS in src/risk/score.ts and ELEVATED/HIGH in chalk/features.py to match.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
