// The hardware chip is paused (FEATURE_CHIP off in production). Its code stays in place; these
// tests pin down what "paused" means, and that everything the chip did still works without it.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { app, call, inbound, onboard, photonOutbox, reset } from "./helpers.js";
import { config } from "../src/config.js";
import { systemPrompt } from "../src/agent/prompt.js";

const H = { "content-type": "application/json", "x-andi-secret": "test-11" };

beforeEach(() => {
  reset();
  config.features.chip = false;
});
afterEach(() => {
  config.features.chip = true;
});

async function linked() {
  const { apiToken, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  await inbound("+16175550102", { text: "hi andi" }); // their person texts Andi too
  photonOutbox.clear();
  return apiToken;
}

test("chip paused: /health and /api/me report it off", async () => {
  const token = await linked();
  const health = await (await app.request("/health")).json();
  assert.deepEqual(health.features, { chip: false });
  const me = await call("GET", "/api/me", { token });
  assert.deepEqual(me.json.features, { chip: false });
  assert.equal(me.json.chipPaired, false);
});

test("chip paused: pairing routes are gone", async () => {
  const token = await linked();
  const pair = await call("POST", "/api/chip/pair", { token });
  assert.equal(pair.status, 404);
  assert.equal(pair.json.error, "feature_off");
  assert.equal((await call("DELETE", "/api/chip", { token })).status, 404);
});

test("chip paused: calling your person still works from the app and iMessage", async () => {
  const token = await linked();
  const r = await call("POST", "/api/call", { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true); // no voice in tests, so Andi texts Sam a tap-to-call link
  const toSponsor = () => photonOutbox.list().filter((m) => "text" in m.content && /asked me to reach you/.test(m.content.text));
  assert.equal(toSponsor().length, 1);
});

test("chip paused: BREATHE points to the app, not the chip", async () => {
  await linked();
  const replies = await inbound("+16175550101", { text: "breathe" });
  assert.ok(replies.some((t) => /andi app/.test(t) && /in for 4/.test(t)));
  assert.ok(!replies.some((t) => /chip/.test(t)));
  const prompt = systemPrompt({ name: "Maya", daysSober: 3, sponsorName: "Sam", riskLevel: "low", riskReasons: [], localTime: "now", recent: [] });
  assert.doesNotMatch(prompt, /on their chip/);
  assert.match(prompt, /offer to call Sam/);
});

test("chip paused: the voice breathe tool texts the steps for the app", async () => {
  await linked();
  const breathe = await (await app.request("/elevenlabs/tools/breathe", { method: "POST", headers: H, body: JSON.stringify({ caller_id: "+16175550101" }) })).json();
  assert.equal(breathe.ok, true);
  assert.doesNotMatch(breathe.result, /chip/);
  const texts = photonOutbox.list().map((m) => ("text" in m.content ? m.content.text : ""));
  assert.ok(texts.some((t) => /tap breathe/.test(t)));
});
