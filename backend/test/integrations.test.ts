// Sponsor clients in "live" mode against a mocked fetch: checks the exact requests we send
// (URLs, headers, bodies, idempotency, retries) and how we read responses.
import "./setup.js";
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.PHOTON_API_KEY = "pho_sk_test";
process.env.PHOTON_PROJECT_ID = "pho_prj_test";
process.env.CHALK_CLIENT_ID = "cid";
process.env.CHALK_CLIENT_SECRET = "csecret";
process.env.NESSIE_API_KEY = "nkey";
process.env.ELEVENLABS_API_KEY = "xi";
process.env.ELEVENLABS_AGENT_ID = "agent_1";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_1";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let responder: (c: Call) => Response = () => new Response("{}", { status: 200 });

before(() => {
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const c: Call = { url: String(url), method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return responder(c);
  }) as typeof fetch;
});
beforeEach(() => {
  calls = [];
  responder = () => new Response("{}", { status: 200 });
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("photon: text sends the V2 message shape with an idempotency key", async () => {
  const { photon } = await import("../src/photon/client.js");
  responder = () => json({ id: "msg_1" }, 202);
  const r = await photon.text({ spaceId: "spc_1", senderId: "usr_agent" }, "hey");
  assert.equal(r.id, "msg_1");
  const c = calls[0];
  assert.equal(c.url, "https://api.photon.codes/v1/projects/pho_prj_test/messages");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.authorization, "Bearer pho_sk_test");
  assert.match(c.headers["idempotency-key"], /^andi:/);
  assert.deepEqual(c.body, { spaceId: "spc_1", senderId: "usr_agent", content: { type: "text", format: "plain", text: "hey" } });
});

test("photon: edit uses text.update with parentMessageId; retries 5xx with the same key", async () => {
  const { photon } = await import("../src/photon/client.js");
  let n = 0;
  responder = () => (++n === 1 ? new Response("oops", { status: 503 }) : json({ id: "msg_2" }, 202));
  await photon.edit({ spaceId: "spc_1", senderId: "usr_agent" }, "msg_status", "new status");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["idempotency-key"], calls[1].headers["idempotency-key"]);
  assert.deepEqual(calls[1].body.content, { type: "text.update", format: "plain", text: "new status" });
  assert.equal(calls[1].body.parentMessageId, "msg_status");
});

test("photon: markRead posts with no body and a stable idempotency key", async () => {
  const { photon } = await import("../src/photon/client.js");
  await photon.markRead("msg_9");
  assert.equal(calls[0].url, "https://api.photon.codes/v1/projects/pho_prj_test/messages/msg_9/read");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers["idempotency-key"], "read:msg_9");
});

test("photon: a 4xx surfaces as an error (no retry)", async () => {
  const { photon } = await import("../src/photon/client.js");
  responder = () => new Response('{"error":"bad"}', { status: 400 });
  await assert.rejects(photon.text({ spaceId: "s", senderId: "u" }, "x"), /Photon \/messages 400/);
  assert.equal(calls.length, 1);
});

test("chalk: token exchange, engine discovery, online query, response parsing", async () => {
  const { getRisk } = await import("../src/chalk/client.js");
  responder = (c) =>
    c.url.endsWith("/v1/oauth/token")
      ? json({ access_token: "tok", expires_in: 3600, primary_environment: "env_1", engines: { env_1: "https://engine.chalk.test" } })
      : json({
          data: [
            { field: "person.risk_score", value: 70 },
            { field: "person.risk_level", value: "high" },
            { field: "person.risk_reasons", value: "Late night|Near a place they marked as risky" },
          ],
        });
  const signals = { hour: 23, weekday: 5, nearRiskPlace: true, minutesSincePlaceEnter: 1, minutesSinceAlcoholPurchase: null, haltCount: 0, hoursSinceCheckin: null, hoursSilent: null, daysSober: 41, daysSinceSlip: null };
  const r = await getRisk("per_1", signals);
  assert.deepEqual(r, { score: 70, level: "high", reasons: ["Late night", "Near a place they marked as risky"], source: "chalk" });
  assert.equal(calls[0].url, "https://api.chalk.ai/v1/oauth/token");
  assert.deepEqual(calls[0].body, { client_id: "cid", client_secret: "csecret", grant_type: "client_credentials" });
  const q = calls[1];
  assert.equal(q.url, "https://engine.chalk.test/v1/query/online");
  assert.equal(q.headers.authorization, "Bearer tok");
  assert.equal(q.headers["x-chalk-deployment-type"], "engine");
  assert.equal(q.headers["x-chalk-env-id"], "env_1");
  assert.equal(q.body.inputs["person.id"], "per_1");
  assert.equal(q.body.inputs["person.minutes_since_alcohol_purchase"], -1);
  assert.deepEqual(q.body.outputs, ["person.risk_score", "person.risk_level", "person.risk_reasons"]);
});

test("chalk: failure falls back to the local score and opens the breaker", async () => {
  const mod = await import("../src/chalk/client.js");
  mod.chalkStatus.openUntil = 0;
  responder = (c) => (c.url.endsWith("/v1/oauth/token") ? json({ access_token: "tok2", expires_in: 1 }) : new Response("down", { status: 500 }));
  const signals = { hour: 14, weekday: 2, nearRiskPlace: false, minutesSincePlaceEnter: null, minutesSinceAlcoholPurchase: null, haltCount: 0, hoursSinceCheckin: 1, hoursSilent: null, daysSober: 200, daysSinceSlip: null };
  const r = await mod.getRisk("per_1", signals);
  assert.equal(r.source, "local");
  assert.ok(mod.chalkStatus.openUntil > Date.now());
  const before = calls.length;
  await mod.getRisk("per_1", signals);
  assert.equal(calls.length, before, "breaker skips Chalk while open");
});

test("nessie: create ids come from objectCreated, or from a lookup when the API returns a string", async () => {
  const { nessie } = await import("../src/nessie/client.js");
  responder = (c) => (c.method === "POST" ? json({ code: 201, objectCreated: { _id: "cust_1" } }, 201) : json([]));
  assert.equal(await nessie.createCustomer("Maya"), "cust_1");
  assert.match(calls[0].url, /^https:\/\/api\.nessieisreal\.com\/customers\?key=nkey$/);

  calls = [];
  responder = (c) =>
    c.method === "POST" ? json("Account created", 201) : json([{ _id: "acct_old", nickname: "Old" }, { _id: "acct_9", nickname: "Everyday" }]);
  assert.equal(await nessie.createAccount("cust_1"), "acct_9");
  assert.equal(calls[1].url, "https://api.nessieisreal.com/customers/cust_1/accounts?key=nkey");
});

test("nessie: merchants are reused by name; purchases send the required fields", async () => {
  const { nessie, isAlcoholSeller } = await import("../src/nessie/client.js");
  responder = (c) => (c.url.includes("/merchants") ? json([{ _id: "m_1", name: "Square Wine & Spirits", category: "liquor store" }]) : json("Created purchase", 201));
  const id = await nessie.getOrCreateMerchant("Square Wine & Spirits", "liquor store");
  assert.equal(id, "m_1");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  const p = await nessie.createPurchase("acct_9", "m_1", 34, "demo");
  assert.equal(p.merchant_id, "m_1");
  const post = calls.at(-1)!;
  assert.deepEqual(Object.keys(post.body).sort(), ["amount", "description", "medium", "merchant_id", "purchase_date"]);
  assert.equal(isAlcoholSeller({ name: "Square Wine & Spirits", category: "liquor store" }), true);
  assert.equal(isAlcoholSeller({ name: "Tatte Bakery", category: ["food"] }), false);
  // The API key never leaks into error messages.
  responder = () => new Response("nope", { status: 500 });
  await assert.rejects(nessie.getMerchant("x"), (e: Error) => !e.message.includes("nkey"));
});

test("elevenlabs: outbound call request shape and success:false handling", async () => {
  const { store } = await import("../src/store.js");
  const { callPerson } = await import("../src/services/calls.js");
  store.put({
    id: "per_v",
    name: "Maya",
    phone: "+16175550101",
    soberSince: "2026-09-06",
    createdAt: new Date().toISOString(),
    apiToken: "t_v",
    screening: { drinksPerDay: 1, drinksDaily: false, morningDrinking: false, pastWithdrawal: false, medicalFirst: false },
    consents: { location: true, purchases: true, shareWithSponsor: "status", sponsorAlerts: true },
    places: [],
    checkins: [],
    slips: [],
    events: [],
    purchases: [],
    chat: [],
    photon: { spaceId: "spc_p", agentUserId: "usr_a" },
    weeklyDrinkSpend: 0,
    sponsor: { name: "Sam", phone: "+16175550102", portalToken: "pt", photon: { spaceId: "spc_s", agentUserId: "usr_a" } },
  });
  responder = (c) => (c.url.includes("elevenlabs") ? json({ success: true, conversation_id: "conv_1", sip_call_id: "sip_1" }) : json({ id: "m" }, 202));
  const r = await callPerson("per_v", "app");
  assert.deepEqual(r, { ok: true, via: "voice" });
  const el = calls.find((c) => c.url.includes("elevenlabs"))!;
  assert.equal(el.url, "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
  assert.equal(el.headers["xi-api-key"], "xi");
  assert.equal(el.body.agent_id, "agent_1");
  assert.equal(el.body.agent_phone_number_id, "phnum_1");
  assert.equal(el.body.to_number, "+16175550102");
  assert.equal(el.body.conversation_initiation_client_data.dynamic_variables.person_name, "Maya");
  assert.equal(el.body.conversation_initiation_client_data.dynamic_variables.call_mode, "outbound_to_sponsor");

  // success:false (HTTP 200) falls back to texting the sponsor.
  store.update("per_v", (x) => {
    x.lastCallAt = undefined;
  });
  calls = [];
  responder = (c) => (c.url.includes("elevenlabs") ? json({ success: false, message: "busy" }) : json({ id: "m" }, 202));
  const r2 = await callPerson("per_v", "app");
  assert.deepEqual(r2, { ok: true, via: "text" });
});

test("photon lines: onboarding assigns the person and sponsor; existing assignments are reused; delete releases", async () => {
  const { app } = await import("../src/app.js");
  const assigned: Record<string, string> = {};
  responder = (c) => {
    if (c.url.endsWith("/platforms/imessage/assignments") && c.method === "POST") {
      if (c.body.handle === "+16175550202") return json({ code: "ASSIGNMENT_EXISTS", status: 409, title: "Assignment Exists", type: "x" }, 409);
      assigned[c.body.handle] = "asg_p";
      return json({ assignmentId: "asg_p", assignedPhoneNumber: "+13055550001", handle: c.body.handle, platform: "imessage", projectId: "p", createdAt: "x", updatedAt: "x" }, 201);
    }
    if (c.url.includes("/platforms/imessage/assignments?") && c.method === "GET")
      return json({ assignments: [{ assignmentId: "asg_s", assignedPhoneNumber: "+13055550002", handle: "+16175550202" }] });
    if (c.method === "DELETE") return json({ assignmentId: "x", releasedAt: "now" });
    return json({ id: "m" }, 202);
  };
  const res = await app.request("/api/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Lines",
      phone: "+16175550201",
      soberSince: "2026-09-06",
      screening: { drinksPerDay: 1, drinksDaily: false, morningDrinking: false, pastWithdrawal: false },
      sponsor: { name: "Sam", phone: "+16175550202" },
    }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.agentHandle, "+13055550001", "the person texts their own assigned number");
  assert.equal(body.me.sponsor.andiNumber, "+13055550002", "the sponsor's existing assignment is found and reused");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/assignments"))!;
  assert.equal(post.body.firstName, "Lines");
  assert.match(post.headers["idempotency-key"], /^andi-assign:/);

  calls = [];
  const del = await app.request("/api/me", { method: "DELETE", headers: { authorization: `Bearer ${body.apiToken}` } });
  assert.equal(del.status, 204);
  await new Promise((r) => setTimeout(r, 20));
  const released = calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").at(-1));
  assert.deepEqual(released.sort(), ["asg_p", "asg_s"]);
  // A handle still used by another account is never released (per_v above still uses +16175550101).
});
