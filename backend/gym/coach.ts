// Andi Gym's coach: reads the night's weakest practice conversations and proposes ONE improved
// playbook (src/agent/playbook.ts). Nothing else can change.
//
//   - With FACTORY_API_KEY, a Factory Droid edits the playbook in a throwaway copy of the backend.
//     Its permission handler allows edits to that one file and only the verify/typecheck commands.
//   - Without it, Claude proposes the new playbook as structured JSON and the gym writes it into the
//     same throwaway copy. Same file allowlist, same verification.
//   - Either way, verification runs outside the coach's control: gym/verify-playbook.ts (schema,
//     safety lint, output guard on every example), the typecheck, and the safety + gym tests. Any
//     file touched besides the playbook is a rejection.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAYBOOK, type Playbook } from "../src/agent/playbook.js";

const BACKEND = path.resolve(import.meta.dirname, "..");
export const PLAYBOOK_FILE = "src/agent/playbook.ts";
const ALLOWED_COMMANDS = [/^npx tsx gym\/verify-playbook\.ts\b/, /^npx tsc --noEmit\b/, /^cat |^sed -n |^grep |^ls\b|^head |^tail /];
const COACH_MODEL = process.env.GYM_COACH_MODEL ?? "claude-opus-5-5";

/** What the coach sees about one weak practice conversation. */
export interface Lesson {
  title: string;
  situation: string;
  helpfulness: number | null;
  quality: Record<string, { score: number; reason: string }>;
  weakest: string;
  transcript: { person: string; andi: string }[];
}

export interface CoachResult {
  ok: boolean;
  by: "factory-droid" | "claude";
  playbook?: Playbook;
  summary: string;
  changes: string[];
  patch: string;
  diffStat: string;
  problems: string[];
}

function sh(cmd: string, argv: string[], cwd: string) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", env: { ...process.env, LOG_LEVEL: "error", TYPING_DELAY: "0" } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "andi-gym-"));
  // Everything tsc and the tests read; never the red-team results or gym run output.
  const skip = (src: string) => !/[/\\](results|runs)([/\\]|$)/.test(path.relative(BACKEND, src));
  for (const entry of ["src", "test", "gym", "redteam", "droid", "scripts", "package.json", "tsconfig.json"]) {
    if (fs.existsSync(path.join(BACKEND, entry))) fs.cpSync(path.join(BACKEND, entry), path.join(ws, entry), { recursive: true, filter: skip });
  }
  fs.symlinkSync(path.join(BACKEND, "node_modules"), path.join(ws, "node_modules"), "dir");
  fs.writeFileSync(path.join(ws, ".gitignore"), "node_modules\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=gym@andi.local", "-c", "user.name=andi-gym", "commit", "-qm", "baseline"], { cwd: ws });
  return ws;
}

function brief(lessons: Lesson[], current: Playbook, version: string) {
  const lessonText = lessons
    .map(
      (l, i) =>
        `### ${i + 1}. ${l.title} (helpfulness ${l.helpfulness ?? "?"}/100)\nSituation: ${l.situation}\n` +
        `Judge: ${Object.entries(l.quality).map(([k, q]) => `${k} ${q.score}/5 (${q.reason})`).join("; ")}\n` +
        `Weakest reply: ${l.weakest}\n` +
        l.transcript.map((t) => `PERSON: ${t.person}\nANDI: ${t.andi}`).join("\n"),
    )
    .join("\n\n");
  return `You coach Andi, an AI that texts with people in early recovery from alcohol. Tonight Andi practiced on simulated hard moments; an expert judge scored how HELPFUL each reply was (warmth, de-escalating the urge, one concrete next step, keeping the person engaged, not preachy, iMessage-short). Below are the weakest conversations.

Your job: improve Andi's playbook so tomorrow's replies are more helpful. The playbook is only HOW Andi helps (style, tactics, habits to avoid, a few example exchanges). Andi's safety rules (988 for crisis, 911/doctor/SAMHSA for withdrawal, never encourage or allow any drinking or moderation, no medical advice, honest about being an AI, privacy) live elsewhere and are not yours to change. Never write anything that weakens or contradicts them.

Rules for the new playbook:
- Make specific, targeted changes that fix the patterns you see, not generic advice. Keep what works.
- At most 10 style lines, 12 tactics, 10 avoid lines, 8 examples. Every example reply must be something Andi could really text: short, warm, lowercase, one idea, under 320 characters, no drink amounts, no medication names.
- Don't write rules about when to give or hold back 988, 911, SAMHSA or a doctor; the safety layer decides that, and the gym rejects any playbook that touches it.
- Use {person} for their person's name and {breathing} for where a breathing round happens.
- Set version to "${version}".

Current playbook (${current.version}):
${JSON.stringify(current, null, 2)}

Weakest practice conversations tonight:
${lessonText}`;
}

const PLAYBOOK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "Two sentences for the pull request: what you changed and why." },
    changes: { type: "array", items: { type: "string" }, description: "Each change in one line, tied to what the judge saw." },
    playbook: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "string" },
        style: { type: "array", items: { type: "string" } },
        tactics: { type: "array", items: { type: "string" } },
        avoid: { type: "array", items: { type: "string" } },
        examples: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { situation: { type: "string" }, person: { type: "string" }, andi: { type: "string" } },
            required: ["situation", "person", "andi"],
          },
        },
      },
      required: ["version", "style", "tactics", "avoid", "examples"],
    },
  },
  required: ["summary", "changes", "playbook"],
};

/** Replace the PLAYBOOK literal in a copy of playbook.ts, keeping the rest of the file as is. */
export function writePlaybookLiteral(source: string, p: Playbook) {
  const start = source.indexOf("export const PLAYBOOK: Playbook = ");
  const end = source.indexOf("\n};\n", start);
  if (start < 0 || end < 0) throw new Error("couldn't find the PLAYBOOK literal in playbook.ts");
  return `${source.slice(0, start)}export const PLAYBOOK: Playbook = ${JSON.stringify(p, null, 2)};\n${source.slice(end + 4)}`;
}

async function claudeCoach(ws: string, prompt: string) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 180_000, maxRetries: 2 });
  const res = await client.messages.create({
    model: COACH_MODEL,
    max_tokens: 16000, // thinking counts against this; above ~21k the SDK wants streaming
    system: "You are a careful, expert coach for a recovery-support texting companion. You answer only with the requested JSON.",
    output_config: { format: { type: "json_schema", schema: PLAYBOOK_JSON_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error(`coach returned no JSON (stop_reason ${res.stop_reason})`);
  const out = JSON.parse(block.text) as { summary: string; changes: string[]; playbook: Playbook };
  const file = path.join(ws, PLAYBOOK_FILE);
  fs.writeFileSync(file, writePlaybookLiteral(fs.readFileSync(file, "utf8"), out.playbook));
  return { summary: out.summary, changes: out.changes };
}

async function droidCoach(ws: string, prompt: string, version: string) {
  // Loaded only when a Factory key is set, so a missing droid CLI never breaks the Claude path.
  const sdk = await import("@factory/droid-sdk/node");
  const task = `${prompt}

Do exactly this:
1. Edit ONLY ${PLAYBOOK_FILE}: change the PLAYBOOK object (style, tactics, avoid, examples) and set version to "${version}". Don't change the schema, the types or renderPlaybook.
2. Check your work with: npx tsx gym/verify-playbook.ts ${version}   (must print "ok":true)
   and: npx tsc --noEmit
3. Touch no other file.

When done, report what you changed.`;
  const result = await sdk.run(task, {
    cwd: ws,
    apiKey: process.env.FACTORY_API_KEY,
    autonomyLevel: sdk.AutonomyLevel.Low,
    outputFormat: {
      type: sdk.OutputFormatType.JsonSchema,
      schema: {
        type: "object",
        properties: { summary: { type: "string" }, changes: { type: "array", items: { type: "string" } } },
        required: ["summary", "changes"],
      },
    },
    permissionHandler({ toolUses, options }) {
      const allowed = toolUses.every((use) => {
        const d = use.details as { type: string; filePath?: string; fullCommand?: string };
        if (d.type === sdk.ToolConfirmationType.Edit || d.type === sdk.ToolConfirmationType.Create || d.type === sdk.ToolConfirmationType.ApplyPatch) {
          return d.filePath ? path.relative(ws, path.resolve(ws, d.filePath)) === PLAYBOOK_FILE : false;
        }
        if (d.type === sdk.ToolConfirmationType.Execute) {
          const cmd = (d.fullCommand ?? "").trim();
          return ALLOWED_COMMANDS.some((re) => re.test(cmd)) && !/[;&|`$><\n]/.test(cmd);
        }
        return false;
      });
      const want = allowed ? sdk.ToolConfirmationOutcome.ProceedOnce : sdk.ToolConfirmationOutcome.Cancel;
      return options.some((o) => o.value === want) ? want : sdk.ToolConfirmationOutcome.Cancel;
    },
  });
  const report = (result.structuredOutput ?? {}) as { summary?: string; changes?: string[] };
  return { summary: report.summary ?? "The Droid revised the playbook.", changes: report.changes ?? [] };
}

/** Independent verification of the coach's work in the workspace. */
function verify(ws: string, version: string) {
  const problems: string[] = [];
  const touched = execFileSync("git", ["diff", "--name-only"], { cwd: ws, encoding: "utf8" }).split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ws, encoding: "utf8" }).split("\n").filter(Boolean);
  const outside = [...touched, ...untracked].filter((f) => f !== PLAYBOOK_FILE);
  if (outside.length) problems.push(`touched files outside the playbook: ${outside.join(", ")}`);
  if (!touched.includes(PLAYBOOK_FILE)) problems.push("the playbook didn't change");

  const v = sh("npx", ["tsx", "gym/verify-playbook.ts", version], ws);
  let playbook: Playbook | undefined;
  try {
    const out = JSON.parse(v.out.trim().split("\n").at(-1) ?? "{}") as { ok: boolean; problems: string[]; playbook: Playbook };
    problems.push(...out.problems);
    playbook = out.playbook;
  } catch {
    problems.push(`verify-playbook crashed: ${v.out.slice(-500)}`);
  }
  const tsc = sh("npx", ["tsc", "--noEmit"], ws);
  if (!tsc.ok) problems.push(`typecheck failed: ${tsc.out.slice(-600)}`);
  const tests = sh("npx", ["tsx", "--test", "test/safety.test.ts", "test/gym.test.ts"], ws);
  if (!tests.ok) problems.push(`safety/gym tests failed: ${tests.out.slice(-600)}`);
  return { problems, playbook };
}

export async function coach(lessons: Lesson[], version: string): Promise<CoachResult> {
  const by = process.env.FACTORY_API_KEY ? "factory-droid" : "claude";
  const ws = makeWorkspace();
  try {
    const prompt = brief(lessons, PLAYBOOK, version);
    const { summary, changes } = by === "factory-droid" ? await droidCoach(ws, prompt, version) : await claudeCoach(ws, prompt);
    const { problems, playbook } = verify(ws, version);
    const patch = execFileSync("git", ["diff"], { cwd: ws, encoding: "utf8" });
    const diffStat = execFileSync("git", ["diff", "--shortstat"], { cwd: ws, encoding: "utf8" }).trim();
    return { ok: problems.length === 0 && Boolean(playbook), by, playbook, summary, changes, patch, diffStat, problems };
  } catch (err) {
    return { ok: false, by, summary: "", changes: [], patch: "", diffStat: "", problems: [`coach failed: ${(err as Error).message}`] };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
