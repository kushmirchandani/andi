// Andi's conversation brain. Safety routing first, then Claude, then the output guard.
// Without ANTHROPIC_API_KEY it uses simple rule-based replies so the demo still works.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, enabled } from "../config.js";
import { guardReply, routeInbound } from "./safety.js";
import { systemPrompt, type AgentContext } from "./prompt.js";
import { log } from "../log.js";

export type Intent = "none" | "call_person" | "breathe" | "slip" | "craving" | "checkin";

export interface BrainResult {
  reply: string;
  intent: Intent;
  halt: { hungry: boolean; angry: boolean; lonely: boolean; tired: boolean } | null;
  route: "crisis" | "withdrawal_emergency" | "model" | "fallback";
  guarded: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

const Output = z.object({
  reply: z.string().min(1),
  intent: z.enum(["none", "call_person", "breathe", "slip", "craving", "checkin"]).catch("none"),
  halt: z
    .object({ hungry: z.boolean(), angry: z.boolean(), lonely: z.boolean(), tired: z.boolean() })
    .nullable()
    .catch(null),
});

let anthropic: Anthropic | null = null;
// One client, short timeout: a text reply that takes 30s is worse than a kind fallback.
const client = () => (anthropic ??= new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 20_000, maxRetries: 1 }));

// Structured output via a forced tool call: the model must fill this schema, so we never
// have to fish JSON out of prose.
const REPLY_TOOL = {
  name: "send_reply",
  description: "Send Andi's text message back to the person, with what you understood from their message.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply: { type: "string", description: "The text message to send. Short, warm, 1-3 sentences." },
      intent: {
        type: "string",
        enum: ["none", "call_person", "breathe", "slip", "craving", "checkin"],
        description: "call_person only if they clearly want their person now; breathe if they accept a breathing round; slip if they say they drank.",
      },
      halt: {
        description: "Only if they told you how they feel right now; otherwise null.",
        anyOf: [
          {
            type: "object",
            properties: { hungry: { type: "boolean" }, angry: { type: "boolean" }, lonely: { type: "boolean" }, tired: { type: "boolean" } },
            required: ["hungry", "angry", "lonely", "tired"],
          },
          { type: "null" },
        ],
      },
    },
    required: ["reply", "intent", "halt"],
  },
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

export async function think(text: string, ctx: AgentContext, history: Turn[] = []): Promise<BrainResult> {
  const route = routeInbound(text, ctx.sponsorName);
  if (route.kind === "crisis" || route.kind === "withdrawal_emergency") {
    return { reply: route.reply, intent: "none", halt: null, route: route.kind, guarded: false };
  }
  const safetyNote = route.kind === "withdrawal_warning" ? route.note : undefined;

  if (!enabled.anthropic()) return fallback(text, ctx, route.kind === "withdrawal_warning");

  try {
    const res = await client().messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      system: systemPrompt({ ...ctx, safetyNote }),
      tools: [REPLY_TOOL],
      tool_choice: { type: "tool", name: REPLY_TOOL.name },
      messages: [...cleanHistory(history), { role: "user", content: text }],
    });
    const call = res.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error(`no tool call (stop_reason ${res.stop_reason})`);
    const parsed = Output.parse(call.input);
    const guarded = guardReply(parsed.reply);
    return { ...parsed, reply: guarded.reply, route: "model", guarded: !guarded.ok };
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
  const base = { halt: null, route: "fallback" as const, guarded: false };
  if (withdrawal || /\b(pills?|mg|medication|detox)\b/.test(t))
    return {
      ...base,
      reply: `please talk to a doctor about this today, or call SAMHSA at 1-800-662-4357 (free, 24/7). withdrawal can be dangerous, and if you have a seizure, confusion or see things, call 911. i'm here with you.`,
      intent: "none",
    };
  if (/^call\b|\bcall (sam|my|them|her|him)\b/.test(t) && ctx.sponsorName)
    return { ...base, reply: `calling ${ctx.sponsorName} now. stay right there with me.`, intent: "call_person" };
  if (/\bbreath/.test(t)) return { ...base, reply: "ok. breathe with your chip: in for 4, hold 4, out for 6. i'm here.", intent: "breathe" };
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
  if (/\b(crav|want (a|one|to) drink|drink|beer|wine|shots?|liquor|bar|tempted|just one)\b/.test(t))
    return {
      ...base,
      reply: `that urge is real, and it passes, usually within half an hour. want to ride it out together, or should i get ${who} on the phone?`,
      intent: "craving",
    };
  if (/\b(real person|human|a bot|an ai)\b/.test(t))
    return { ...base, reply: "i'm andi, an ai companion. not a person, but i'm here for you any time, and i can get your person on the phone.", intent: "none" };
  return { ...base, reply: "i'm here. how's tonight going, honestly?", intent: "none" };
}
