// Red team: run every hard-night persona against Andi in parallel, one Daytona sandbox each.
//
//   npm run redteam                 # Daytona (needs DAYTONA_API_KEY, ANDI_URL reachable from the internet)
//   npm run redteam -- --local      # same personas, run from this machine (no Daytona)
//
// Each sandbox runs a tiny Node worker that plays the persona's scripted turns against
// POST {ANDI_URL}/agent/test and prints the transcript. Results are scored with the same
// rules as the Chalk evals and written to redteam/results/ (JSONL = the Chalk eval dataset).

import fs from "node:fs";
import path from "node:path";
import { Daytona } from "@daytona/sdk";
import { personas, type Persona } from "./personas.js";
import { score, type Transcript } from "./scorers.js";

const ANDI_URL = process.env.ANDI_URL ?? "http://localhost:8080";
const TEST_KEY = process.env.AGENT_TEST_KEY ?? "dev-test-key";
const LOCAL = process.argv.includes("--local");
const CONCURRENCY = Number(process.env.REDTEAM_CONCURRENCY ?? 10);

// Runs inside each sandbox (and locally in --local mode). Plain JS, Node 18+ fetch.
const WORKER = `
const persona = JSON.parse(require("fs").readFileSync("persona.json", "utf8"));
(async () => {
  const history = []; const turns = [];
  try {
    for (const user of persona.turns) {
      const res = await fetch(process.env.ANDI_URL + "/agent/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-key": process.env.AGENT_TEST_KEY },
        body: JSON.stringify({ persona: persona.persona, history, message: user }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
      const andi = await res.json();
      turns.push({ user, andi });
      history.push({ role: "user", content: user }, { role: "assistant", content: andi.reply });
    }
    console.log("__TRANSCRIPT__" + JSON.stringify({ turns }));
  } catch (e) {
    console.log("__TRANSCRIPT__" + JSON.stringify({ turns, error: String(e && e.message || e) }));
  }
})();
`;

function parse(stdout: string, persona: Persona): Transcript {
  const line = stdout.split("\n").find((l) => l.includes("__TRANSCRIPT__"));
  if (!line) return { persona, turns: [], error: `no transcript: ${stdout.slice(0, 200)}` };
  return { persona, ...JSON.parse(line.slice(line.indexOf("__TRANSCRIPT__") + 14)) };
}

async function runLocal(persona: Persona): Promise<Transcript> {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "andi-rt-"));
  fs.writeFileSync(path.join(dir, "persona.json"), JSON.stringify(persona));
  fs.writeFileSync(path.join(dir, "worker.cjs"), WORKER);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["worker.cjs"], {
    cwd: dir,
    env: { ...process.env, ANDI_URL, AGENT_TEST_KEY: TEST_KEY },
    encoding: "utf8",
  });
  return parse(out, persona);
}

async function runInSandbox(daytona: Daytona, persona: Persona): Promise<Transcript> {
  const sandbox = await daytona.create({
    language: "javascript",
    envVars: { ANDI_URL, AGENT_TEST_KEY: TEST_KEY },
    labels: { app: "andi", job: "redteam", persona: persona.id },
    autoStopInterval: 15,
    ephemeral: true,
  });
  try {
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(persona)), "persona.json");
    await sandbox.fs.uploadFile(Buffer.from(WORKER), "worker.cjs");
    const res = await sandbox.process.executeCommand("node worker.cjs", undefined, { ANDI_URL, AGENT_TEST_KEY: TEST_KEY }, 180);
    return parse(res.result, persona);
  } catch (err) {
    return { persona, turns: [], error: (err as Error).message };
  } finally {
    await daytona.delete(sandbox).catch(() => {});
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
        process.stdout.write(".");
      }
    }),
  );
  process.stdout.write("\n");
  return out;
}

async function main() {
  console.log(`Red team: ${personas.length} hard nights against ${ANDI_URL} (${LOCAL ? "local" : "Daytona, parallel"})`);
  const started = Date.now();
  let transcripts: Transcript[];
  if (LOCAL) transcripts = await pool(personas, 4, runLocal);
  else {
    if (!process.env.DAYTONA_API_KEY) throw new Error("Set DAYTONA_API_KEY, or run with --local");
    const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    transcripts = await pool(personas, CONCURRENCY, (p) => runInSandbox(daytona, p));
  }

  const scores = transcripts.map(score);
  const passed = scores.filter((s) => s.pass).length;
  const dir = path.join(import.meta.dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(dir, `redteam-${stamp}.jsonl`),
    transcripts.map((t, i) => JSON.stringify({ ...t, score: scores[i] })).join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "latest-scorecard.json"),
    JSON.stringify({ at: new Date().toISOString(), mode: LOCAL ? "local" : "daytona", passed, total: scores.length, scores }, null, 2),
  );

  console.log(`\n${passed}/${scores.length} hard nights handled safely in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  for (const s of scores) {
    const failed = Object.entries(s.checks).filter(([, v]) => !v).map(([k]) => k);
    console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.title}${failed.length ? `  <- ${failed.join(", ")}` : ""}`);
  }
  for (const t of transcripts.filter((t) => t.error)) console.log(`error in ${t.persona.id}: ${t.error}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
