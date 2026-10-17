import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, inbound, onboard, onboardBody, reset, store } from "./helpers.js";

beforeEach(reset);

test("onboard creates a pending account with a 6-digit link code", async () => {
  const r = await onboard();
  assert.match(r.apiToken, /^[\w-]{20,}$/);
  assert.match(r.linkCode, /^\d{6}$/);
  assert.equal(r.me.imessageLinked, false);
  assert.equal(r.me.day, r.me.day | 0);
  assert.equal(r.me.sponsor.linked, false);
  assert.equal(r.screening.medicalFirst, false);
});

test("onboard validates input with readable messages", async () => {
  const bad = await call("POST", "/api/onboard", { body: onboardBody({ phone: "123", soberSince: "2999-01-01" }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_request");
  assert.match(bad.json.message, /phone number|future/);
  const self = await call("POST", "/api/onboard", { body: onboardBody({ sponsor: { name: "Me", phone: "+16175550101" } }) });
  assert.equal(self.status, 400);
  assert.match(self.json.message, /someone else/);
  const notJson = await (await import("./helpers.js")).app.request("/api/onboard", { method: "POST", body: "nope", headers: { "content-type": "application/json" } });
  assert.equal(notJson.status, 400);
});

test("onboarding never deletes someone else's pending signup (anyone can type any number)", async () => {
  const first = await onboard();
  await onboard();
  assert.equal(store.all().length, 2);
  assert.equal((await call("GET", "/api/me", { token: first.apiToken })).status, 200);
});

test("a sober date that's 'today' in the person's zone is accepted", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const r = await call("POST", "/api/onboard", { body: onboardBody({ soberSince: today, timezone: "Asia/Tokyo" }) });
  assert.equal(r.status, 200);
});

test("authenticated routes reject missing or wrong tokens", async () => {
  assert.equal((await call("GET", "/api/me")).status, 401);
  const r = await call("GET", "/api/me", { token: "wrong" });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "unauthorized");
});

test("consents, sponsor and places round-trip through /api/me", async () => {
  const { apiToken: token } = await onboard();
  const c = await call("PUT", "/api/consents", { token, body: { location: false, purchases: true, shareWithSponsor: "none", sponsorAlerts: false } });
  assert.equal(c.status, 200);
  assert.equal(c.json.consents.shareWithSponsor, "none");

  const place = await call("POST", "/api/places", { token, body: { name: "The Rusty Anchor", lat: 42.37, lng: -71.11, radiusM: 150, kind: "bar" } });
  assert.equal(place.status, 201);
  assert.match(place.json.id, /^plc_/);
  const me = await call("GET", "/api/me", { token });
  assert.equal(me.json.places.length, 1);

  assert.equal((await call("DELETE", `/api/places/${place.json.id}`, { token })).status, 204);
  assert.equal((await call("DELETE", `/api/places/${place.json.id}`, { token })).status, 404);
});

test("places are capped at 20 (CLMonitor's limit)", async () => {
  const { apiToken: token } = await onboard();
  for (let i = 0; i < 20; i++) {
    const r = await call("POST", "/api/places", { token, body: { name: `p${i}`, lat: 42, lng: -71 } });
    assert.equal(r.status, 201);
  }
  const over = await call("POST", "/api/places", { token, body: { name: "one more", lat: 42, lng: -71 } });
  assert.equal(over.status, 409);
});

test("renaming the sponsor keeps their iMessage link; changing the number resets it", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  await inbound("+16175550102", { text: "hi andi" });
  let me = await call("GET", "/api/me", { token });
  assert.equal(me.json.sponsor.linked, true);

  me = await call("PUT", "/api/sponsor", { token, body: { name: "Samantha", phone: "(617) 555-0102" } });
  assert.equal(me.json.sponsor.name, "Samantha");
  assert.equal(me.json.sponsor.linked, true);

  me = await call("PUT", "/api/sponsor", { token, body: { name: "Jo", phone: "+16175550199" } });
  assert.equal(me.json.sponsor.linked, false);

  me = await call("DELETE", "/api/sponsor", { token });
  assert.equal(me.json.sponsor, null);
});

test("check-in, slip and risk return a risk object", async () => {
  const { apiToken: token } = await onboard();
  const ci = await call("POST", "/api/checkin", { token, body: { hungry: false, angry: false, lonely: true, tired: true, mood: 2 } });
  assert.equal(ci.status, 200);
  assert.ok(["low", "elevated", "high"].includes(ci.json.risk.level));
  assert.ok(ci.json.risk.reasons.some((r: string) => /hungry, angry, lonely, tired/.test(r)));
  const slip = await call("POST", "/api/slip", { token, body: {} });
  assert.equal(slip.status, 200);
  assert.match(slip.json.message, /doesn't erase/);
  const risk = await call("GET", "/api/risk", { token });
  assert.ok(risk.json.reasons.includes("Slip in the last few days"));
});

test("call my person: none without a linked sponsor, text when linked, cooldown on repeat", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  let r = await call("POST", "/api/call", { token });
  assert.deepEqual(r.json, { ok: false, via: "none" });

  store.update(store.all()[0].id, (x) => {
    x.lastCallAt = undefined;
  });
  await inbound("+16175550102", { text: "hi andi" });
  r = await call("POST", "/api/call", { token });
  assert.deepEqual(r.json, { ok: true, via: "text" });
  r = await call("POST", "/api/call", { token });
  assert.equal(r.json.via, "cooldown");
});

test("chip pairing returns a pending token and a websocket url; unpair clears it", async () => {
  const { apiToken: token } = await onboard();
  const r = await call("POST", "/api/chip/pair", { token });
  assert.match(r.json.wsUrl, /^ws:\/\/.+\/chip\?token=/);
  // Not paired until the chip actually connects with the new token (see chip.test.ts).
  assert.equal((await call("GET", "/api/me", { token })).json.chipPaired, false);
  assert.ok(store.byToken(token)!.chipPendingToken);
  assert.equal((await call("DELETE", "/api/chip", { token })).json.chipPaired, false);
  assert.equal(store.byToken(token)!.chipPendingToken, undefined);
});

test("check-in and slip notes get crisis routing too", async () => {
  const { apiToken: token } = await onboard();
  const ci = await call("POST", "/api/checkin", { token, body: { hungry: false, angry: false, lonely: true, tired: false, note: "honestly i don’t want to be alive" } });
  assert.equal(ci.json.safety.kind, "crisis");
  assert.match(ci.json.safety.message, /988/);
  const slip = await call("POST", "/api/slip", { token, body: { note: "i drank and i want to kill myself" } });
  assert.match(slip.json.message, /988/);
  assert.ok(store.byToken(token)!.events.filter((e) => e.kind === "crisis").length >= 2);
});

test("changing the sponsor's number retires the old portal link", async () => {
  const { apiToken: token, me } = await onboard();
  const oldPortal = new URL(me.portalUrl).pathname;
  assert.equal((await call("GET", `${oldPortal}/status.json`)).status, 200);
  await call("PUT", "/api/sponsor", { token, body: { name: "Jo", phone: "+16175550199" } });
  assert.equal((await call("GET", `${oldPortal}/status.json`)).status, 404);
});

test("why accepts text; delete account removes everything", async () => {
  const { apiToken: token } = await onboard();
  assert.equal((await call("POST", "/api/why", { token, body: { text: "my mornings" } })).status, 200);
  assert.equal((await call("DELETE", "/api/me", { token })).status, 204);
  assert.equal((await call("GET", "/api/me", { token })).status, 401);
  assert.equal(store.all().length, 0);
});

test("errors always have { error, message }", async () => {
  const r = await call("GET", "/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "not_found");
  assert.equal(typeof r.json.message, "string");
});

test("health reports dry-run sponsors", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sponsors.photon, "dry-run");
  assert.equal(r.json.sponsors.chalk, "local");
});

test("demo and agent-test routes need their keys", async () => {
  assert.equal((await call("POST", "/demo/seed", { body: {} })).status, 401);
  assert.equal((await call("POST", "/agent/test", { body: {} })).status, 401);
  const ok = await call("POST", "/agent/test", {
    headers: { "x-test-key": "test-agent" },
    body: { persona: { name: "A", daysSober: 3 }, message: "i want to kill myself" },
  });
  assert.equal(ok.json.route, "crisis");
});
