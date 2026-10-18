// Nightly safety autofix: Andi's safety layer gets safer every night, and a human approves
// every change. This is where the Factory Droid SDK does real work in the running product.
//
//   1. FIND   gaps: red-team failures (Daytona) + a read-only Droid gap hunter, each re-checked
//             against the real router (droid/gaps.ts).
//   2. FIX    in a throwaway copy of the backend, a Droid session edits ONLY the safety router and
//             its corpus: it adds each gap to src/agent/safety-corpus.ts (the regression test) and
//             changes the patterns in src/agent/safety.ts until the corpus passes. Its permission
//             handler lets it run only the test commands and touch only those two files.
//   3. VERIFY independently (the Droid never grades itself): droid/verify.ts re-routes every gap
//             and the whole corpus, then the typecheck and the full test suite run in the copy.
//   4. HAND OFF a patch, a report and a pull-request body in redteam/results/autofix/<run>/.
//             Nothing reaches the live code until a person applies it (--apply writes it into
//             the working tree for review; it never commits).
//
//   npm run autofix                      # hunt + red-team failures -> fix -> verify -> patch
//   npm run autofix -- --gaps gaps.json  # fix a given list: [{ "text": "...", "expect": "crisis" }]
//   npm run autofix -- --no-hunt         # red-team failures only
//   npm run autofix -- --dry-run         # find gaps and print the fix prompt; no Droid fix session
//   npm run autofix -- --apply           # after a verified fix, apply the patch to this working tree
//
// Needs FACTORY_API_KEY (app.factory.ai/settings/api-keys) and the droid CLI on PATH
// (curl -fsSL https://app.factory.ai/cli | sh).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutonomyLevel,
  OutputFormatType,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  run,
} from "@factory/droid-sdk/node";
import { dedupe, gapsFromRedteam, huntGaps, type Gap } from "./gaps.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(BACKEND, "redteam", "results");
const ALLOWED_FILES = ["src/agent/safety.ts", "src/agent/safety-corpus.ts"];
// Commands the fixer may run, matched against the start of the full command line.
const ALLOWED_COMMANDS = [
  /^npx tsx droid\/verify\.ts\b/,
  /^npx tsx --test test\/safety\.test\.ts\b/,
  /^npx tsc --noEmit\b/,
  /^npm (run )?test\b/,
  /^cat |^sed -n |^grep |^ls\b|^head |^tail /,
];
const MAX_GAPS = 15;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(RESULTS, "autofix", runId);
const log = (msg: string) => console.log(`[autofix] ${msg}`);

function sh(cmd: string, argv: string[], cwd: string) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", env: { ...process.env, LOG_LEVEL: "error", TYPING_DELAY: "0" } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A throwaway copy of the backend with its own git baseline, so the Droid's diff is exact.
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "andi-autofix-"));
  for (const entry of ["src", "test", "droid", "package.json", "tsconfig.json"]) {
    fs.cpSync(path.join(BACKEND, entry), path.join(ws, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(BACKEND, "node_modules"), path.join(ws, "node_modules"), "dir");
  fs.writeFileSync(path.join(ws, ".gitignore"), "node_modules\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=autofix@andi.local", "-c", "user.name=andi-autofix", "commit", "-qm", "baseline"], { cwd: ws });
  return ws;
}

function fixPrompt(gaps: Gap[]) {
  const list = gaps.map((g, i) => `${i + 1}. "${g.text}"  -> must be "${g.expect}" (today: "${g.got}"). ${g.why}`).join("\n");
  return `You are fixing the deterministic safety router of Andi, an iMessage companion for people in early recovery from alcohol. A missed crisis message means someone who said they want to die gets a casual reply instead of the 988 line, so precision matters, and so does not over-triggering on ordinary messages.

These messages are misrouted today:
${list}

Do exactly this:
1. Append each message above to SAFETY_CORPUS in src/agent/safety-corpus.ts with its expected route and source "droid-${runId}". Do not remove or change existing entries.
2. Edit the patterns in src/agent/safety.ts (CRISIS, WITHDRAWAL_EMERGENCY, NEVER, or normalizeForSafety) so that every corpus entry routes as expected. Prefer small, specific patterns over broad ones. Never delete an existing pattern unless it causes one of the listed false positives, and then narrow it rather than delete it.
3. Check your work with: npx tsx droid/verify.ts gaps.json   (must print stillWrong: [] and corpusFailures: [])
   and: npx tsx --test test/safety.test.ts
4. Touch no other files. Do not change tests or the scoring code.

When done, report what you changed.`;
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences for the pull request." },
    patternChanges: {
      type: "array",
      items: {
        type: "object",
        properties: { pattern: { type: "string" }, why: { type: "string" } },
        required: ["pattern", "why"],
      },
    },
    risks: { type: "string", description: "Any message the new patterns might now over-trigger on." },
  },
  required: ["summary", "patternChanges", "risks"],
};

async function droidFix(ws: string, gaps: Gap[]) {
  let blocked = 0;
  const result = await run(fixPrompt(gaps), {
    cwd: ws,
    apiKey: process.env.FACTORY_API_KEY,
    // Low = file edits and read-only commands; anything else comes to the handler below.
    autonomyLevel: AutonomyLevel.Low,
    outputFormat: { type: OutputFormatType.JsonSchema, schema: REPORT_SCHEMA },
    permissionHandler({ toolUses, options }) {
      const allowed = toolUses.every((use) => {
        const d = use.details as { type: string; filePath?: string; fullCommand?: string };
        if (d.type === ToolConfirmationType.Edit || d.type === ToolConfirmationType.Create || d.type === ToolConfirmationType.ApplyPatch) {
          const rel = d.filePath ? path.relative(ws, path.resolve(ws, d.filePath)) : "";
          return ALLOWED_FILES.includes(rel);
        }
        if (d.type === ToolConfirmationType.Execute) {
          const cmd = (d.fullCommand ?? "").trim();
          return ALLOWED_COMMANDS.some((re) => re.test(cmd)) && !/[;&|`$><\n]/.test(cmd);
        }
        return false;
      });
      if (!allowed) blocked++;
      const want = allowed ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
      return options.some((o) => o.value === want) ? want : ToolConfirmationOutcome.Cancel;
    },
  });
  return { result, blocked };
}

function verify(ws: string) {
  const v = sh("npx", ["tsx", "droid/verify.ts", "gaps.json"], ws);
  const routing = v.ok ? (JSON.parse(v.out.trim().split("\n").at(-1) ?? "{}") as {
    fixed: string[];
    stillWrong: unknown[];
    corpusFailures: unknown[];
    corpusHasGaps: boolean;
    corpusSize: number;
  }) : null;
  const typecheck = sh("npx", ["tsc", "--noEmit"], ws);
  const tests = sh("npx", ["tsx", "--test", ...fs.readdirSync(path.join(ws, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`)], ws);
  const touched = execFileSync("git", ["diff", "--name-only"], { cwd: ws, encoding: "utf8" }).split("\n").filter(Boolean);
  const outside = touched.filter((f) => !ALLOWED_FILES.includes(f));
  const testSummary = tests.out.match(/# pass (\d+)[\s\S]*?# fail (\d+)/);
  return {
    routing,
    typecheckOk: typecheck.ok,
    testsOk: tests.ok,
    tests: testSummary ? { pass: Number(testSummary[1]), fail: Number(testSummary[2]) } : null,
    touched,
    outside,
    ok: Boolean(routing && routing.stillWrong.length === 0 && routing.corpusFailures.length === 0 && routing.corpusHasGaps) &&
      typecheck.ok && tests.ok && outside.length === 0 && touched.length > 0,
    logs: { typecheck: typecheck.out.slice(-2000), tests: tests.out.slice(-3000) },
  };
}

function prBody(gaps: Gap[], report: { summary?: string; patternChanges?: { pattern: string; why: string }[]; risks?: string } | undefined, v: ReturnType<typeof verify>) {
  const rows = gaps.map((g) => `| ${g.text.replace(/\|/g, "\\|")} | ${g.got} | ${g.expect} | ${g.source} |`).join("\n");
  const changes = (report?.patternChanges ?? []).map((c) => `- \`${c.pattern}\`: ${c.why}`).join("\n") || "- (see diff)";
  return `# Safety autofix ${runId}

${report?.summary ?? "The Droid patched the safety router to close the gaps below."}

## Gaps closed
| Message | Routed as | Should be | Found by |
| --- | --- | --- | --- |
${rows}

## Pattern changes (from the Droid)
${changes}

**Possible over-triggering (Droid's own note):** ${report?.risks ?? "none noted"}

## Independent verification (not the Droid's)
- Gaps now routed correctly: ${v.routing?.fixed.length ?? 0}/${gaps.length}
- Safety corpus: ${v.routing ? `${v.routing.corpusSize} entries, ${v.routing.corpusFailures.length} failures` : "verify failed"}
- Typecheck: ${v.typecheckOk ? "pass" : "FAIL"}
- Test suite: ${v.tests ? `${v.tests.pass} pass, ${v.tests.fail} fail` : v.testsOk ? "pass" : "FAIL"}
- Files touched: ${v.touched.join(", ") || "none"}${v.outside.length ? ` (OUTSIDE ALLOWED: ${v.outside.join(", ")})` : ""}

A person must review and merge this. Generated by \`npm run autofix\` with the Factory Droid SDK.
`;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // 1. FIND
  let gaps: Gap[] = [];
  let proposed = 0;
  const gapsFile = option("--gaps");
  if (gapsFile) {
    const given = JSON.parse(fs.readFileSync(gapsFile, "utf8")) as { text: string; expect: Gap["expect"]; why?: string }[];
    const { routeOf } = await import("./gaps.js");
    gaps = given.map((g) => ({ text: g.text, expect: g.expect, got: routeOf(g.text), why: g.why ?? "given", source: "file" as const })).filter((g) => g.got !== g.expect);
  } else {
    gaps = gapsFromRedteam(RESULTS);
    log(`${gaps.length} gap(s) from the latest red-team run`);
    if (!flag("--no-hunt") && !flag("--dry-run")) {
      log("Droid gap hunt (read-only)...");
      const hunt = await huntGaps(BACKEND);
      proposed = hunt.proposed;
      log(`Droid proposed ${hunt.proposed} message(s); ${hunt.gaps.length} are real misses`);
      gaps.push(...hunt.gaps);
    }
  }
  gaps = dedupe(gaps).slice(0, MAX_GAPS);
  fs.writeFileSync(path.join(outDir, "gaps.json"), JSON.stringify(gaps, null, 2));
  if (gaps.length === 0) {
    log("no gaps found. the router handles everything we threw at it tonight.");
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ runId, gaps: 0, proposed, result: "clean" }, null, 2));
    return 0;
  }
  for (const g of gaps) log(`gap: "${g.text}" routed ${g.got}, should be ${g.expect}`);

  if (flag("--dry-run")) {
    fs.writeFileSync(path.join(outDir, "fix-prompt.txt"), fixPrompt(gaps));
    log(`dry run: prompt written to ${path.relative(BACKEND, outDir)}/fix-prompt.txt`);
    return 0;
  }

  // 2. FIX in a throwaway workspace
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, "gaps.json"), JSON.stringify(gaps.map(({ text, expect }) => ({ text, expect }))));
  execFileSync("git", ["add", "gaps.json"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=autofix@andi.local", "-c", "user.name=andi-autofix", "commit", "-qm", "gaps"], { cwd: ws });
  log(`Droid fix session in ${ws} ...`);
  const started = Date.now();
  // AUTOFIX_STUB_FIXER=<module> swaps the Droid for a local function (tests of this pipeline only).
  const stub = process.env.AUTOFIX_STUB_FIXER;
  const { result, blocked } = stub
    ? { result: await (await import(path.resolve(stub))).default(ws, gaps, runId), blocked: 0 }
    : await droidFix(ws, gaps);
  log(`Droid finished (${result.subtype}) in ${Math.round((Date.now() - started) / 1000)}s; ${blocked} action(s) blocked by the permission handler`);

  // 3. VERIFY
  const v = verify(ws);
  const patch = execFileSync("git", ["diff"], { cwd: ws, encoding: "utf8" });
  fs.writeFileSync(path.join(outDir, "fix.patch"), patch);
  const report = result.structuredOutput as Parameters<typeof prBody>[1];
  fs.writeFileSync(path.join(outDir, "PULL_REQUEST.md"), prBody(gaps, report, v));
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify(
      {
        runId,
        gaps: gaps.length,
        proposed,
        droid: { subtype: result.subtype, success: result.success, durationMs: result.durationMs, tokenUsage: result.tokenUsage, blocked, report },
        verification: { ...v, logs: undefined },
        result: v.ok ? "verified" : "rejected",
      },
      null,
      2,
    ),
  );
  if (!v.ok) {
    fs.writeFileSync(path.join(outDir, "verify.log"), `${v.logs.typecheck}\n\n${v.logs.tests}`);
    log(`REJECTED: the fix didn't pass independent verification. see ${path.relative(BACKEND, outDir)}/`);
    return 1;
  }
  // A stable path for CI to find the newest verified run.
  const latest = path.join(RESULTS, "autofix", "latest");
  fs.rmSync(latest, { recursive: true, force: true });
  fs.cpSync(outDir, latest, { recursive: true });
  log(`VERIFIED: ${gaps.length} gap(s) closed, ${v.tests?.pass ?? "all"} tests pass. patch + PR body in ${path.relative(BACKEND, outDir)}/`);

  // 4. HAND OFF
  if (flag("--apply")) {
    execFileSync("patch", ["-p1", "-i", path.join(outDir, "fix.patch")], { cwd: BACKEND, stdio: "inherit" });
    log("applied to your working tree (not committed). review with: git diff src/agent/");
  } else {
    log("review it, then from backend/: patch -p1 -i " + path.relative(BACKEND, path.join(outDir, "fix.patch")));
  }
  fs.rmSync(ws, { recursive: true, force: true });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[autofix] failed: ${(err as Error).message}`);
    process.exit(1);
  });
