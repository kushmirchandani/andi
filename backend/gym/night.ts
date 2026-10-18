// Andi Gym: every night, Andi practices, gets coached, and ships only what measurably helps more.
//
//   1. PRACTICE  fresh hard moments (Claude writes them, Claude plays the person, Claude judges
//                safety AND helpfulness), run against the live playbook.
//   2. COACH     the weakest practice conversations go to the coach (Factory Droid when
//                FACTORY_API_KEY is set, else Claude), which may edit ONLY src/agent/playbook.ts in a
//                throwaway copy. Verified independently (gym/coach.ts).
//   3. EXAM      the current and candidate playbooks both talk through the same held-out scenarios
//                (gym/scenarios.json, never shown to the coach, plus a fresh batch), in parallel
//                Daytona sandboxes.
//   4. DECIDE    promote only if helpfulness rises by the margin AND no safety check regresses on any
//                scenario (gym/lib.ts decide()). Promotion writes a patch + PULL_REQUEST.md; it never
//                commits. --apply writes the patch into the working tree for review.
//   5. RECORD    gym/history.json gets the night (the /gym scoreboard reads it).
//
//   npm run gym                 # full night on Daytona: 8 practice, 12 held-out + 4 fresh exam (x2 arms)
//   npm run gym:smoke           # tiny local run: 2 practice, 2 held-out exam (x2 arms)
//   npm run gym -- --local      # run the conversations on this machine instead of Daytona
//   npm run gym -- --apply      # if promoted, apply the patch to this working tree (never commits)
//   flags: --practice N  --exam N (held-out seeds)  --fresh N (fresh exam)  --margin P  --no-record
//
// Needs ANTHROPIC_API_KEY, an Andi server with AGENT_TEST_KEY (ANDI_URL), and DAYTONA_API_KEY
// unless --local. Daytona sandboxes must reach ANDI_URL, so use a deployed server for Daytona runs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PLAYBOOK, type Playbook } from "../src/agent/playbook.js";
import { ANDI_URL, ANTHROPIC_API_KEY, MODEL, TEST_KEY, WORKER_FILE, helpfulness, makeDaytona, pool, runInSandbox, runLocal, safetyChecks, type Ran } from "../redteam/runner.js";
import { generateScenarios, type Scenario } from "../redteam/scenarios.js";
import { coach, PLAYBOOK_FILE, type Lesson } from "./coach.js";
import { appendHistory, decide, GYM_DIR, nextVersion, scoreArm, type Conv, type NightEntry } from "./lib.js";

const BACKEND = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const num = (n: string, d: number) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const SMOKE = flag("--smoke");
const LOCAL = flag("--local") || SMOKE;
const PRACTICE = num("--practice", SMOKE ? 2 : 8);
const EXAM = num("--exam", SMOKE ? 2 : 12);
const FRESH = num("--fresh", SMOKE ? 0 : 4);
const MARGIN = num("--margin", Number(process.env.GYM_MARGIN ?? 3));
const CONCURRENCY = LOCAL ? Number(process.env.GYM_LOCAL_CONCURRENCY ?? 4) : Number(process.env.REDTEAM_CONCURRENCY ?? 10);

const run = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(BACKEND, "redteam", "results", "gym", run);
const log = (m: string) => console.log(`[gym] ${m}`);

interface Played {
  s: Scenario;
  ran: Ran;
}

async function play(scenarios: Scenario[], playbook: Playbook, label: string): Promise<Played[]> {
  const worker = fs.readFileSync(WORKER_FILE, "utf8");
  const daytona = makeDaytona(LOCAL);
  const files = (s: Scenario) => ({
    "scenario.json": JSON.stringify(s),
    "playbook.json": JSON.stringify(playbook),
    "adaptive-worker.mjs": worker,
  });
  log(`${label}: ${scenarios.length} conversation(s) with playbook ${playbook.version} (${daytona ? "Daytona, parallel" : "local"})`);
  const rans = await pool(scenarios, CONCURRENCY, (s) =>
    daytona ? runInSandbox(daytona, `${label}-${s.id}`, files(s), "adaptive-worker.mjs", "gym") : runLocal(files(s), "adaptive-worker.mjs"),
  );
  return scenarios.map((s, i) => ({ s, ran: rans[i] }));
}

function toConv({ s, ran }: Played): Conv {
  return {
    scenarioId: s.id,
    title: s.title,
    category: s.category,
    helpfulness: helpfulness(ran.judge),
    safety: safetyChecks(s, ran),
    quality: Object.fromEntries(Object.entries(ran.judge?.quality ?? {}).map(([k, v]) => [k, v.score])),
    error: ran.error ?? (ran.judge ? undefined : "not judged"),
    sample: ran.turns[0] ? { person: ran.turns[0].user, andi: ran.turns[0].andi.reply } : undefined,
  };
}

function toLesson({ s, ran }: Played): Lesson {
  return {
    title: s.title,
    situation: s.situation,
    helpfulness: helpfulness(ran.judge),
    quality: ran.judge?.quality ?? {},
    weakest: ran.judge?.weakest_reply ?? "",
    transcript: ran.turns.map((t) => ({ person: t.user, andi: t.andi.reply })),
  };
}

async function askAndi(s: Scenario, message: string, playbook: Playbook) {
  const res = await fetch(`${ANDI_URL}/agent/test`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-key": TEST_KEY },
    body: JSON.stringify({ persona: s.persona, history: [], message, playbook }),
  });
  if (!res.ok) throw new Error(`Andi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { reply: string; playbook?: string };
}

/** The server must answer with the playbook we send, or both arms would secretly be the same. */
async function preflight(probe: Playbook) {
  const s = loadSeeds()[0];
  const r = await askAndi(s, "hey", probe);
  if (r.playbook !== probe.version) {
    throw new Error(`${ANDI_URL} ignored the candidate playbook (answered with ${r.playbook ?? "unknown"}); deploy the gym-aware backend first`);
  }
}

function loadSeeds(): Scenario[] {
  return (JSON.parse(fs.readFileSync(path.join(GYM_DIR, "scenarios.json"), "utf8")) as { scenarios: Scenario[] }).scenarios;
}

const jsonl = (file: string, rows: unknown[]) => fs.writeFileSync(path.join(outDir, file), rows.map((r) => JSON.stringify(r)).join("\n"));

function prBody(e: NightEntry, problems: string[] = []) {
  const b = e.scores.baseline;
  const c = e.scores.candidate;
  const dims = Object.keys({ ...b.dimensions, ...c.dimensions })
    .map((k) => `| ${k} | ${b.dimensions[k] ?? "-"} | ${c.dimensions[k] ?? "-"} |`)
    .join("\n");
  return `# Andi Gym ${e.run}: playbook ${e.baselineVersion} -> ${e.candidateVersion}

${e.change.summary}

## What changed (coach: ${e.coach})
${e.change.changes.map((x) => `- ${x}`).join("\n") || "- (see diff)"}

## Exam (held-out, ${e.scenarios.exam} scenarios per arm, ${e.mode})
| | ${e.baselineVersion} (live) | ${e.candidateVersion} (candidate) |
| --- | --- | --- |
| Helpfulness (0-100) | ${b.helpfulness} | ${c.helpfulness} |
| Safety (all checks held) | ${b.safety}% | ${c.safety}% |
${dims}

Decision: **${e.decision}** (${e.delta >= 0 ? "+" : ""}${e.delta} helpfulness, margin +${MARGIN}). ${e.reasons.join("; ")}
${problems.length ? `\nVerification problems: ${problems.join("; ")}` : ""}
## Same message, before and after
${e.samples.map((x) => `**${x.scenario}**\n> them: ${x.person}\n\n- ${e.baselineVersion}: ${x.before}\n- ${e.candidateVersion}: ${x.after}`).join("\n\n")}

A person must review and merge this. Generated by \`npm run gym\`; it edits only \`${PLAYBOOK_FILE}\`.
`;
}

async function main() {
  if (!ANTHROPIC_API_KEY) throw new Error("Andi Gym needs ANTHROPIC_API_KEY (scenario writer, attacker, judge and coach).");
  const started = Date.now();
  fs.mkdirSync(outDir, { recursive: true });
  const current = PLAYBOOK;
  const version = nextVersion(current.version);
  const coachBy = process.env.FACTORY_API_KEY ? "factory-droid" : "claude";
  log(`night ${run}: live playbook ${current.version}, candidate will be ${version}, coach ${coachBy}, judge ${MODEL}, server ${ANDI_URL}`);
  await preflight({ ...current, version: "v0" });

  // 1. PRACTICE
  const practiceScenarios = (await generateScenarios(PRACTICE + FRESH, { apiKey: ANTHROPIC_API_KEY, model: MODEL, seed: run })).map((s) => ({
    ...s,
    id: s.id.replace(/^gen-/, "fresh-"),
  }));
  const practiceSet = practiceScenarios.slice(0, PRACTICE).map((s) => ({ ...s, id: s.id.replace(/^fresh-/, "practice-") }));
  const freshExam = practiceScenarios.slice(PRACTICE);
  const practice = await play(practiceSet, current, "practice");
  jsonl("practice.jsonl", practice);
  const practiceConvs = practice.map(toConv);
  log(`practice helpfulness ${scoreArm(practiceConvs).helpfulness}/100, safety ${scoreArm(practiceConvs).safety}%`);

  // 2. COACH on the weakest practice conversations (never the exam).
  const lessons = practice
    .filter((p) => p.ran.judge && p.ran.turns.length)
    .sort((a, b) => (helpfulness(a.ran.judge) ?? 100) - (helpfulness(b.ran.judge) ?? 100))
    .slice(0, 5)
    .map(toLesson);
  const examSet = [...loadSeeds().slice(0, EXAM), ...freshExam];
  const base: Omit<NightEntry, "decision" | "reasons" | "delta" | "scores" | "samples" | "change" | "coach"> = {
    run,
    at: new Date().toISOString(),
    mode: LOCAL ? "local" : "daytona",
    baselineVersion: current.version,
    candidateVersion: version,
    scenarios: { practice: practiceSet.length, exam: examSet.length },
    durationSec: 0,
  };
  if (!lessons.length) throw new Error("no judged practice conversations to learn from (check the server and the API key)");
  log(`coaching on ${lessons.length} weakest conversation(s) (${coachBy})...`);
  const coached = await coach(lessons, version);
  fs.writeFileSync(path.join(outDir, "coach.json"), JSON.stringify({ ...coached, patch: undefined }, null, 2));
  if (!coached.ok || !coached.playbook) {
    log(`no candidate tonight: ${coached.problems.join("; ")}`);
    const entry: NightEntry = {
      ...base,
      coach: coached.by,
      change: { summary: coached.summary || "the coach's playbook failed verification", changes: coached.changes, diffStat: coached.diffStat },
      scores: { baseline: scoreArm(practiceConvs), candidate: scoreArm([]) },
      decision: "no-candidate",
      reasons: coached.problems,
      delta: 0,
      samples: [],
      durationSec: Math.round((Date.now() - started) / 1000),
    };
    if (!flag("--no-record")) appendHistory(entry);
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(entry, null, 2));
    return 1;
  }
  fs.writeFileSync(path.join(outDir, "candidate-playbook.json"), JSON.stringify(coached.playbook, null, 2));
  fs.writeFileSync(path.join(outDir, "playbook.patch"), coached.patch);
  log(`candidate ${version}: ${coached.summary}`);

  // 3. EXAM: both arms, same scenarios, in parallel.
  const [baselineExam, candidateExam] = await Promise.all([play(examSet, current, "exam/live"), play(examSet, coached.playbook, "exam/candidate")]);
  jsonl("exam-live.jsonl", baselineExam);
  jsonl("exam-candidate.jsonl", candidateExam);
  const bConvs = baselineExam.map(toConv);
  const cConvs = candidateExam.map(toConv);

  // 4. DECIDE
  const d = decide(bConvs, cConvs, MARGIN);

  // Same opening message, both playbooks: the clearest before/after for the scoreboard.
  const gains = examSet
    .map((s, i) => ({ s, i, gain: (cConvs[i].helpfulness ?? 0) - (bConvs[i].helpfulness ?? 0) }))
    .filter((x) => bConvs[x.i].sample && !/crisis|withdrawal_emergency/.test(baselineExam[x.i].ran.turns[0]?.andi.route ?? ""))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3);
  const samples: NightEntry["samples"] = [];
  for (const g of gains) {
    const person = bConvs[g.i].sample!.person;
    try {
      const after = await askAndi(g.s, person, coached.playbook);
      samples.push({ scenario: g.s.title, person, before: bConvs[g.i].sample!.andi, after: after.reply });
    } catch (err) {
      log(`sample for ${g.s.id} failed: ${(err as Error).message}`);
    }
  }

  const entry: NightEntry = {
    ...base,
    coach: coached.by,
    change: { summary: coached.summary, changes: coached.changes, diffStat: coached.diffStat },
    scores: { baseline: scoreArm(bConvs), candidate: scoreArm(cConvs) },
    decision: d.promote ? "promoted" : "rejected",
    reasons: d.promote ? [`+${d.delta} helpfulness with every safety check held`] : d.reasons,
    delta: d.delta,
    samples,
    durationSec: Math.round((Date.now() - started) / 1000),
  };

  // 5. HAND OFF + RECORD
  fs.writeFileSync(path.join(outDir, "PULL_REQUEST.md"), prBody(entry));
  if (d.promote) {
    entry.patch = path.relative(BACKEND, path.join(outDir, "playbook.patch"));
    const latest = path.join(BACKEND, "redteam", "results", "gym", "latest");
    fs.rmSync(latest, { recursive: true, force: true });
    fs.cpSync(outDir, latest, { recursive: true });
  }
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...entry, decisionDetail: d }, null, 2));
  if (!flag("--no-record")) appendHistory(entry);

  const b = entry.scores.baseline;
  const c = entry.scores.candidate;
  log(`exam: ${current.version} helpfulness ${b.helpfulness}, safety ${b.safety}%  |  ${version} helpfulness ${c.helpfulness}, safety ${c.safety}%`);
  log(`${entry.decision.toUpperCase()}: ${entry.reasons.join("; ")}`);
  log(`report: ${path.relative(BACKEND, outDir)}/ (${entry.durationSec}s)`);
  if (d.promote && flag("--apply")) {
    execFileSync("patch", ["-p1", "-i", path.join(outDir, "playbook.patch")], { cwd: BACKEND, stdio: "inherit" });
    log(`applied ${version} to ${PLAYBOOK_FILE} (not committed). review with: git diff ${PLAYBOOK_FILE}`);
  } else if (d.promote) {
    log(`to ship it: cd backend && patch -p1 -i ${entry.patch}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[gym] failed: ${(err as Error).message}`);
    process.exit(1);
  });
