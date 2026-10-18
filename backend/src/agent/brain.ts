// Andi's conversation brain. Safety routing first, then Claude, then the output guard.
// Without ANTHROPIC_API_KEY it uses simple rule-based replies so the demo still works.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, enabled } from "../config.js";
import { guardReply, routeInbound } from "./safety.js";
import { systemPrompt, type AgentContext } from "./prompt.js";

/** The prompt context plus what Andi has learned from this person's own history, if anything. */
export type BrainContext = AgentContext & { memory?: string };

// Appended to the system prompt so the fixed rules in prompt.ts stay untouched.
const memoryBlock = (memory?: string) =>
  memory
    ? `\n\nWhat you've learned from their own history (use it lightly, only when it fits, and never as if you're watching them): ${memory}.`
    : "";
import { log } from "../log.js";

export type Intent = "none" | "call_person" | "breathe" | "slip" | "craving" | "checkin" | "voice_note";

export interface BrainResult {
  reply: string;
  intent: Intent;
  halt: { hungry: boolean; angry: boolean; lonely: boolean; tired: boolean } | null;
  /** They shared a win: Andi hearts their message. Never set on crisis routes. */
  celebrate: boolean;
  route: "crisis" | "withdrawal_emergency" | "model" | "fallback";
  guarded: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

const Output = z.object({
  reply: z.string().min(1),
  intent: z.enum(["none", "call_person", "breathe", "slip", "craving", "checkin", "voice_note"]).catch("none"),
  halt: z
    .object({ hungry: z.boolean(), angry: z.boolean(), lonely: z.boolean(), tired: z.boolean() })
    .nullable()
    .catch(null),
  celebrate: z.boolean().catch(false),
});

let anthropic: Anthropic | null = null;
// One client, short timeout: a text reply that takes 30s is worse than a kind fallback.
const client = () => (anthropic ??= new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 20_000, maxRetries: 1 }));

// Structured output via output_config.format (JSON schema): the reply comes back as JSON that
// matches this schema, so we never have to fish it out of prose. Claude Sonnet 5.5 rejects a
// forced tool_choice ("tool"/"any"), so we use JSON outputs instead. Every object needs
// additionalProperties: false. Docs: platform.claude.com/docs/en/build-with-claude/structured-outputs
const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", description: "The text message to send. Short, warm, 1-3 sentences." },
    intent: {
      type: "string",
      enum: ["none", "call_person", "breathe", "slip", "craving", "checkin", "voice_note"],
      description:
        "call_person only if they clearly want their person now; breathe if they accept a breathing round; slip if they say they drank; voice_note only if they ask to hear your voice.",
    },
    celebrate: {
      type: "boolean",
      description: "True only when they share a clear win (got through a hard night, a good day). Never for cravings, sadness, slips or safety.",
    },
    halt: {
      description: "Only if they told you how they feel right now; otherwise null.",
      anyOf: [
        {
          type: "object",
          properties: { hungry: { type: "boolean" }, angry: { type: "boolean" }, lonely: { type: "boolean" }, tired: { type: "boolean" } },
          required: ["hungry", "angry", "lonely", "tired"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["reply", "intent", "halt", "celebrate"],
};

// The Messages API wants alternating turns that start with the user.
function cleanHistory(history: Turn[]) {
  const out: Turn[] = [];
  for (const t of history.slice(-12)) {
    if (!t.content?.trim()) continue;
    if (out.length === 0 && t.role !== "user") continue;
    if (out.at(-1)?.role === t.role) out[out.length - 1] = { role: t.role, content: `${out.at(-1)!.content}\n${t.content}` };
    else out.push({ role: t.role, content: t.content });
  }
  if (out.at(-1)?.role === "user") out.pop(); // the new message is appended by the caller
  return out;
}

export async function think(text: string, ctx: BrainContext, history: Turn[] = []): Promise<BrainResult> {
  const route = routeInbound(text, ctx.sponsorName);
  if (route.kind === "crisis" || route.kind === "withdrawal_emergency") {
    return { reply: route.reply, intent: "none", halt: null, celebrate: false, route: route.kind, guarded: false };
  }
  const safetyNote = route.kind === "withdrawal_warning" ? route.note : undefined;

  if (!enabled.anthropic()) return fallback(text, ctx, route.kind === "withdrawal_warning");

  try {
    const res = await client().messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      system: systemPrompt({ ...ctx, safetyNote }) + memoryBlock(ctx.memory),
      // Low effort keeps a text reply fast; the safety router above already ran deterministically.
      output_config: { effort: "low", format: { type: "json_schema", schema: REPLY_SCHEMA } },
      messages: [...cleanHistory(history), { role: "user", content: text }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error(`no JSON reply (stop_reason ${res.stop_reason})`);
    const parsed = Output.parse(JSON.parse(block.text));
    const guarded = guardReply(parsed.reply);
    // No hearts on a turn the safety layer had anything to say about.
    const celebrate = parsed.celebrate && !safetyNote && !["slip", "craving"].includes(parsed.intent) && guarded.ok;
    return { ...parsed, celebrate, reply: guarded.reply, route: "model", guarded: !guarded.ok };
  } catch (err) {
    log.warn("brain", "model call failed, using fallback", err);
    return fallback(text, ctx, route.kind === "withdrawal_warning");
  }
}

// Rule-based replies for when Claude isn't configured or a call fails. Kept deliberately
// conservative: every hard-moment reply offers a human, every symptom points to medical help.
function fallback(text: string, ctx: AgentContext, withdrawal = false): BrainResult {
  const t = text.toLowerCase();
  const who = ctx.sponsorName ?? "someone you trust";
  const base = { halt: null, celebrate: false, route: "fallback" as const, guarded: false };
  if (withdrawal || /\b(pills?|mg|medication|detox)\b/.test(t))
    return {
      ...base,
      reply: `please talk to a doctor about this today, or call SAMHSA at 1-800-662-4357 (free, 24/7). withdrawal can be dangerous, and if you have a seizure, confusion or see things, call 911. i'm here with you.`,
      intent: "none",
    };
  if (/^call\b|\bcall (sam|my|them|her|him)\b/.test(t) && ctx.sponsorName)
    return { ...base, reply: `calling ${ctx.sponsorName} now. stay right there with me.`, intent: "call_person" };
  if (/\bbreath/.test(t))
    return {
      ...base,
      reply: config.features.chip
        ? "ok. breathe with your chip: in for 4, hold 4, out for 6. i'm here."
        : "ok. in for 4, hold 4, out for 6. tap breathe in the andi app (or its widget, or your action button) to follow along. i'm here.",
      intent: "breathe",
    };
  if (/\b(drank|relapsed?|slipped|had a drink|got drunk)\b/.test(t))
    return {
      ...base,
      reply: `thank you for telling me. that took guts. one night doesn't erase your days, and you don't have to sort this out alone. want me to get ${who} on the phone?`,
      intent: "slip",
    };
  if (/\b(lonely|alone|nobody|no one)\b/.test(t))
    return { ...base, reply: `quiet nights are the hardest ones. i'm here. want me to ask ${who} to call you?`, intent: "craving" };
  if (/\b(angry|furious|fight|pissed)\b/.test(t))
    return { ...base, reply: `that sounds rough. a drink won't fix the fight, it'll just add to it. want to vent to me, or should i get ${who} on the phone?`, intent: "craving" };
  if (/\b(crav|want (a|one|to) drink|(just )?want one|one won'?t|drink|beer|wine|shots?|liquor|bar|tempted|just one|what do i do)\b/.test(t))
    return {
      ...base,
      reply: `that urge is real, and it passes, usually within half an hour. want to ride it out together, or should i get ${who} on the phone?`,
      intent: "craving",
    };
  if (/\bvoice (note|message|memo)\b|\bhear (your|ur) voice\b/.test(t))
    return { ...base, reply: "of course. i'm right here with you, and i'm really glad you reached out.", intent: "voice_note" };
  if (/\b(made it|got through|good day|went to a meeting|proud of myself|still sober)\b/.test(t) && !/\b(but|sad|awful|hard|struggl\w*|scared|alone|almost)\b/.test(t))
    return { ...base, celebrate: true, reply: "that's huge. you did that. how are you feeling about it?", intent: "none" };
  if (/\b(real person|human|a bot|an ai)\b/.test(t))
    return { ...base, reply: "i'm andi, an ai companion. not a person, but i'm here for you any time, and i can get your person on the phone.", intent: "none" };
  return { ...base, reply: "i'm here. how's tonight going, honestly?", intent: "none" };
}
