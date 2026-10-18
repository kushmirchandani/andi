// Andi's playbook: the part of the system prompt that Andi Gym tunes every night (gym/).
//
// Only HOW Andi helps lives here: writing style, tactics for hard moments, habits to avoid, and a
// few example exchanges. The safety rules (988, withdrawal, no moderation, no medical advice, honesty
// about being an AI) are fixed in prompt.ts and are never edited by the gym. The gym's coach may edit
// only this file; a candidate is promoted only if it helps more and every safety check holds.
//
// Placeholders filled in by prompt.ts: {person} = their person's name, {breathing} = where the
// breathing round happens (chip or app).

import { z } from "zod";

const Line = z.string().min(3).max(400);

export const PlaybookSchema = z.object({
  version: z.string().regex(/^v\d+$/),
  /** How Andi writes. */
  style: z.array(Line).min(1).max(10),
  /** What helps on a hard moment. Andi picks one; it doesn't run through the list. */
  tactics: z.array(Line).min(1).max(12),
  /** Habits that make a reply worse. */
  avoid: z.array(Line).max(10),
  /** Few-shot examples: what the person said and a reply in Andi's voice. */
  examples: z
    .array(
      z.object({
        situation: z.string().min(3).max(200),
        person: z.string().min(1).max(300),
        andi: z.string().min(1).max(320),
      }),
    )
    .max(8),
});

export type Playbook = z.infer<typeof PlaybookSchema>;

export const PLAYBOOK: Playbook = {
  version: "v1",
  style: [
    "write like a caring friend texting: short, warm, plain, lowercase is fine",
    "one idea per message, usually 1 to 3 sentences",
    "no lists, no headers, no emoji spam",
  ],
  tactics: [
    "ask what's going on, then really listen",
    "HALT: hungry, angry, lonely, tired. ask which ones fit tonight",
    "ride the urge: cravings rise and fall in about 15 to 30 minutes. offer to sit with them by text or start a breathing round {breathing}",
    "reach a human: offer to call {person}",
    "remind them of their own why, in their words, only when it would land",
    "suggest a concrete next step: leave, eat something, text someone, go to a meeting, sleep",
  ],
  avoid: ["lecturing or listing several tactics at once"],
  examples: [],
};

/** The playbook as prompt text. Placeholders are filled in by the caller. */
export function renderPlaybook(p: Playbook, fill: { person: string; breathing: string }) {
  const sub = (s: string) => s.replaceAll("{person}", fill.person).replaceAll("{breathing}", fill.breathing);
  const bullets = (xs: string[]) => xs.map((x) => `- ${sub(x)}`).join("\n");
  const examples = p.examples.length
    ? `\n\nExamples of your voice (match the spirit, never copy them word for word):\n${p.examples
        .map((e) => `- ${sub(e.situation)}\n  them: "${sub(e.person)}"\n  you: "${sub(e.andi)}"`)
        .join("\n")}`
    : "";
  return {
    style: p.style.map(sub).join("; "),
    body: `What helps on a hard moment (pick one, don't lecture):\n${bullets(p.tactics)}${
      p.avoid.length ? `\n\nAvoid:\n${bullets(p.avoid)}` : ""
    }${examples}`,
  };
}
