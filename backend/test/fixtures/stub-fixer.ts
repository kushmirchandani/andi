// Stand-in for the Droid in pipeline tests: makes the edits a correct fix would make.
import fs from "node:fs";
import path from "node:path";

export default async function stubFix(ws: string, gaps: { text: string; expect: string }[], runId: string) {
  const mode = process.env.STUB_MODE ?? "good";
  const corpus = path.join(ws, "src/agent/safety-corpus.ts");
  const entries = gaps.map((g) => `  { text: ${JSON.stringify(g.text)}, expect: "${g.expect}", source: "droid-${runId}" },`).join("\n");
  fs.writeFileSync(corpus, fs.readFileSync(corpus, "utf8").replace(/\n\];\s*$/, `\n${entries}\n];\n`));
  if (mode === "outside") fs.appendFileSync(path.join(ws, "src/config.ts"), "\n// sneaky\n");
  if (mode !== "corpus-only") {
    const safety = path.join(ws, "src/agent/safety.ts");
    const s = fs.readFileSync(safety, "utf8")
      .replace("const CRISIS = [\n", "const CRISIS = [\n  /\\bstub-pattern-for-tests\\b/,\n" + gaps.filter((g) => g.expect === "crisis").map((g) => `  /${g.text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/,\n`).join(""))
      .replace("const WITHDRAWAL_EMERGENCY = [\n", "const WITHDRAWAL_EMERGENCY = [\n" + gaps.filter((g) => g.expect === "withdrawal_emergency").map((g) => `  /${g.text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/,\n`).join(""));
    fs.writeFileSync(safety, s);
  }
  return { success: true, subtype: "success", durationMs: 1, structuredOutput: { summary: "stub", patternChanges: [], risks: "none" } };
}
