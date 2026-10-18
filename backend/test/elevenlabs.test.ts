import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, inbound, onboard, reset } from "./helpers.js";

beforeEach(reset);
const H = { "x-andi-secret": "test-11" };

test("voice webhooks require the shared secret", async () => {
  assert.equal((await call("POST", "/elevenlabs/init", { body: {} })).status, 401);
});

test("inbound call from a known person returns their context as dynamic variables", async () => {
  const { linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  const r = await call("POST", "/elevenlabs/init", { headers: H, body: { caller_id: "+16175550101", called_number: "+13058108482" } });
  assert.equal(r.json.type, "conversation_initiation_client_data");
  assert.equal(r.json.dynamic_variables.known_caller, true);
  assert.equal(r.json.dynamic_variables.person_name, "Maya");
  assert.equal(r.json.dynamic_variables.sponsor_name, "Sam");
});

test("unknown callers get neutral variables", async () => {
  const r = await call("POST", "/elevenlabs/init", { headers: H, body: { caller_id: "+19995550000" } });
  assert.equal(r.json.dynamic_variables.known_caller, false);
});

test("call-person tool texts their person instead of dialing over the live call", async () => {
  const { linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  await inbound("+16175550102", { text: "hi" });
  const r = await call("POST", "/elevenlabs/tools/call-person", { headers: H, body: { caller_id: "+16175550101" } });
  assert.equal(r.json.ok, true);
  assert.match(r.json.result, /Sam/);
});
