// Webhooks for the ElevenLabs voice agent behind Andi's Photon voice number.
//
//  POST /elevenlabs/init          conversation-initiation webhook for INBOUND calls: ElevenLabs sends
//                                 the caller's number; we return dynamic variables so Andi greets a
//                                 known person by name and knows their day count and their person.
//  POST /elevenlabs/tools/call-person   server tool: "get my person on the phone"
//  POST /elevenlabs/tools/breathe       server tool: start a breathing round on the chip
//
// Auth: ElevenLabs sends static secret headers (no signing for these webhooks). Set
// ELEVENLABS_WEBHOOK_SECRET and add it in ElevenLabs as the `x-andi-secret` request header on the
// initiation webhook (Agents settings) and on each server tool. Without a secret these routes are off.
// Caller ID can be spoofed, so inbound calls never get the person's "why" or risk details.
// Tools should pass caller_id from the system variable {{system__caller_id}}.
// Docs: elevenlabs.io/docs/eleven-agents/customization/personalization, .../tools/webhook-tools

import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { errorBody } from "../http.js";
import { log, mask } from "../log.js";
import { callPerson } from "../services/calls.js";
import { startBreathing } from "../services/engine.js";
import { safeEqual, store } from "../store.js";
import { varsForPerson, varsForSponsor, varsForUnknown } from "../services/voice.js";

export const elevenlabsRoutes = new Hono();

elevenlabsRoutes.use("/*", async (c, next) => {
  const secret = config.elevenlabs.webhookSecret;
  const given = c.req.header("x-andi-secret") ?? ""; // header only: query strings end up in logs
  if (!secret || !safeEqual(given, secret)) return c.json(errorBody("unauthorized", "Bad webhook secret."), 401);
  await next();
});

elevenlabsRoutes.post("/init", async (c) => {
  const b = z
    .object({
      caller_id: z.string().optional(),
      called_number: z.string().optional(),
      agent_id: z.string().optional(),
      call_sid: z.string().optional(),
      call_id: z.string().optional(),
      conversation_id: z.string().optional(),
    })
    .passthrough()
    .parse(await c.req.json().catch(() => ({})));
  // Only answer for our own agent when ELEVENLABS_AGENT_ID is set.
  if (config.elevenlabs.agentId && b.agent_id && b.agent_id !== config.elevenlabs.agentId)
    return c.json(errorBody("unauthorized", "Unknown agent."), 401);
  const p = b.caller_id ? store.linkedByPhone(b.caller_id) : undefined;
  const sponsorOf = !p && b.caller_id ? store.bySponsorPhone(b.caller_id) : undefined;
  log.info("voice", `inbound call from ${mask(b.caller_id)} (${p ? "person" : sponsorOf ? "sponsor" : "unknown"})`);

  const vars = p ? varsForPerson(p) : sponsorOf ? varsForSponsor(sponsorOf, "inbound") : varsForUnknown();

  return c.json({ type: "conversation_initiation_client_data", dynamic_variables: vars });
});

const ToolBody = z.object({ caller_id: z.string().optional() }).passthrough();

elevenlabsRoutes.post("/tools/call-person", async (c) => {
  const b = ToolBody.parse(await c.req.json().catch(() => ({})));
  const p = b.caller_id ? store.linkedByPhone(b.caller_id) : undefined;
  if (!p) return c.json({ ok: false, result: "I don't know this caller, so I can't reach their person." });
  // While they're on the phone with Andi, text their person (a voice call would collide with this one).
  const r = await callPerson(p.id, "voice", { preferText: true });
  return c.json({
    ok: r.ok,
    result: r.ok ? `${p.sponsor?.name ?? "their person"} has been asked to call them right now.` : "Their person isn't set up yet.",
  });
});

elevenlabsRoutes.post("/tools/breathe", async (c) => {
  const b = ToolBody.parse(await c.req.json().catch(() => ({})));
  const p = b.caller_id ? store.linkedByPhone(b.caller_id) : undefined;
  if (p) await startBreathing(p.id, "voice");
  return c.json({ ok: Boolean(p), result: p ? "Breathing round started on their chip." : "Unknown caller." });
});
