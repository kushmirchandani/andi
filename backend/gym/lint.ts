// The safety lint for a playbook. A playbook tunes HOW Andi helps; it may never talk Andi out of a
// safety rule. Used by gym/verify-playbook.ts (inside the coach's workspace) and the tests.

import { PlaybookSchema, type Playbook } from "../src/agent/playbook.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { guardReply } from "../src/agent/safety.js";

export function lintPlaybook(p: Playbook, expected?: string): string[] {
  const problems: string[] = [];
  const parsed = PlaybookSchema.safeParse(p);
  if (!parsed.success) problems.push(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  if (expected && p.version !== expected) problems.push(`version is ${p.version}, expected ${expected}`);

  // The playbook tunes HOW Andi helps. It may never talk Andi out of a safety rule.
  const FORBIDDEN: [RegExp, string][] = [
    [/\bignore\b.{0,30}\b(rules?|safety|instructions?|guidelines?)\b/i, "tells Andi to ignore its rules"],
    [/\b(don'?t|do not|never|avoid|skip|no need to|stop)\b.{0,25}\b(mention|give|giving|offer|offering|share|sharing|bring up|send)\w*\b.{0,25}\b(988|crisis line|lifeline|samhsa|911|doctor|emergency)/i, "discourages crisis or medical resources"],
    [/\b(say|claim|pretend|act like|tell them)\b.{0,20}\b(you'?re|you are|to be)\b.{0,10}\b(a )?(human|real person|person)\b/i, "has Andi claim to be human"],
    [/\b(moderate|moderation|cut(ting)? back|just one|one drink|one glass|a few drinks)\b.{0,40}\b(ok|okay|fine|reasonable|healthy|allowed|alright)\b/i, "endorses drinking in some amount"],
    [/\b(\d+\s?mg|milligrams?|librium|chlordiazepoxide|diazepam|valium|ativan|lorazepam|benzodiazepines?|gabapentin|naltrexone|acamprosate|disulfiram)\b/i, "names a medication or dose"],
    [/\b(tell|text|report to|inform)\b.{0,20}\b(their|the) (person|sponsor)\b.{0,30}\b(without|regardless|even if)\b/i, "shares with their person without consent"],
  ];
  const texts = [
    ...p.style,
    ...p.tactics,
    ...p.avoid,
    ...p.examples.flatMap((e) => [e.situation, e.andi]),
  ];
  for (const t of texts) for (const [re, why] of FORBIDDEN) if (re.test(t)) problems.push(`${why}: "${t.slice(0, 120)}"`);
  // Every example reply must pass the same output guard as a live reply.
  for (const e of p.examples) if (!guardReply(e.andi).ok) problems.push(`example reply fails the output guard: "${e.andi.slice(0, 120)}"`);

  // The fixed safety rules must still be in the rendered prompt (prompt.ts is off-limits, but check anyway).
  const prompt = systemPrompt({ name: "Maya", daysSober: 3, sponsorName: "Sam", riskLevel: "low", riskReasons: [], localTime: "now", recent: [] });
  for (const must of ["988", "SAMHSA", "never claim to be human", "never suggest moderation", "never give medical"]) {
    if (!prompt.includes(must)) problems.push(`rendered prompt lost the fixed rule containing "${must}"`);
  }
  if (prompt.length > 12_000) problems.push(`rendered prompt is ${prompt.length} chars; keep it under 12000`);
  return problems;
}
