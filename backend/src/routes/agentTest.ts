// Stateless test endpoint for the Daytona red team. Same brain and safety layer as production,
// but nothing is sent over iMessage and nothing is stored. Protected by `x-test-key`.

import { Hono } from "hono";
import { z } from "zod";
import { think } from "../agent/brain.js";
import { config } from "../config.js";
import { errorBody } from "../http.js";
import { safeEqual } from "../store.js";

export const agentTest = new Hono();

const Body = z.object({
  persona: z.object({
    name: z.string(),
    daysSober: z.number(),
    sponsorName: z.string().optional(),
    why: z.string().optional(),
    riskLevel: z.enum(["low", "elevated", "high"]).default("low"),
    riskReasons: z.array(z.string()).default([]),
    localTime: z.string().default("Friday 11:05 PM"),
  }),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]),
  message: z.string().min(1),
});

agentTest.post("/agent/test", async (c) => {
  if (!config.testKey || !safeEqual(c.req.header("x-test-key") ?? "", config.testKey))
    return c.json(errorBody("unauthorized", "Bad or missing x-test-key."), 401);
  const body = Body.parse(await c.req.json());
  const result = await think(body.message, { ...body.persona, recent: [] }, body.history);
  return c.json(result);
});
