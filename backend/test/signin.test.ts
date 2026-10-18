import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, clock, inbound, onboard, onboardBody, reset, store } from "./helpers.js";
import { tick } from "../src/services/engine.js";

beforeEach(reset);

const start = async (phone: string) => {
  const r = await call("POST", "/api/signin", { body: { phone } });
  assert.equal(r.status, 200);
  return r.json as { signInToken: string; linkCode: string; firstText: string; agentHandle: string | null };
};
const status = async (token: string) => (await call("GET", "/api/signin", { token })).json?.state;

// An existing, linked account for +16175550101.
async function existingAccount() {
  const { apiToken, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  return apiToken;
}

test("starting a sign-in looks the same whether or not the number has an account", async () => {
  await existingAccount();
  const known = await start("+16175550101");
  const unknown = await start("+16175550199");
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
  assert.equal(known.agentHandle, unknown.agentHandle);
  assert.match(known.linkCode, /^\d{6}$/);
  assert.equal(await status(known.signInToken), "waiting");
  assert.equal(await status(unknown.signInToken), "waiting");
});

test("a new number: texting the code verifies it, and onboarding finishes a linked account", async () => {
  const s = await start("617-555-0199");
  const replies = await inbound("+16175550199", { text: `${s.firstText} ${s.linkCode}` });
  assert.match(replies[0], /glad you're here/);
  assert.equal(await status(s.signInToken), "verified");

  const r = await call("POST", "/api/onboard", { body: { ...onboardBody({ phone: undefined }), signInToken: s.signInToken } });
  assert.equal(r.status, 200);
  assert.equal(r.json.apiToken, s.signInToken);
  assert.equal(r.json.linkCode, null);
  assert.equal(r.json.me.imessageLinked, true);
  assert.equal(store.signIns().length, 0);
  assert.equal(await status(s.signInToken), "signed_in");

  // Andi can text them straight away, and their next text is a normal conversation.
  const p = store.byToken(s.signInToken)!;
  assert.equal(p.phone, "+16175550199");
  assert.ok(p.events.some((e) => e.kind === "linked"));
});

test("an existing account: texting the code signs this phone in and signs the old one out", async () => {
  const oldToken = await existingAccount();
  const s = await start("+16175550101");
  const replies = await inbound("+16175550101", { text: `hi andi ${s.linkCode}` });
  assert.match(replies[0], /welcome back, maya/);
  assert.equal(await status(s.signInToken), "signed_in");
  assert.equal((await call("GET", "/api/me", { token: s.signInToken })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: oldToken })).status, 401);
  assert.equal(store.all().length, 1);
  assert.equal(store.signIns().length, 0);
});

test("a sign-in code only works from the number it was started for", async () => {
  await existingAccount();
  const s = await start("+16175550101");
  await inbound("+16175554444", { text: `hi andi ${s.linkCode}` });
  assert.equal(await status(s.signInToken), "waiting");
  // The account's owner texting someone else's code doesn't sign anyone in either.
  const other = await start("+16175550199");
  await inbound("+16175550101", { text: `hi andi ${other.linkCode}` });
  assert.equal(await status(other.signInToken), "waiting");
});

test("skipping the text: onboarding keeps the same code, and texting it later links the account", async () => {
  const s = await start("+16175550199");
  const r = await call("POST", "/api/onboard", { body: { ...onboardBody({ phone: undefined }), signInToken: s.signInToken } });
  assert.equal(r.status, 200);
  assert.equal(r.json.me.imessageLinked, false);
  assert.equal(r.json.linkCode, s.linkCode);
  await inbound("+16175550199", { text: `hi andi ${s.linkCode}` });
  assert.equal((await call("GET", "/api/me", { token: s.signInToken })).json.imessageLinked, true);
});

test("skipping with a number that already has an account: the later text restores that account", async () => {
  const oldToken = await existingAccount();
  const s = await start("+16175550101");
  await call("POST", "/api/onboard", { body: { ...onboardBody({ phone: undefined, sponsor: null }), signInToken: s.signInToken } });
  assert.equal(store.all().length, 2);
  const replies = await inbound("+16175550101", { text: `hi andi ${s.linkCode}` });
  assert.match(replies[0], /welcome back/);
  assert.equal(store.all().length, 1);
  assert.equal((await call("GET", "/api/me", { token: s.signInToken })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: oldToken })).status, 401);
});

test("onboarding with an unknown sign-in token is refused; your person can't be your own number", async () => {
  const bad = await call("POST", "/api/onboard", { body: { ...onboardBody({ phone: undefined }), signInToken: "nope" } });
  assert.equal(bad.status, 401);
  const s = await start("+16175550102");
  const self = await call("POST", "/api/onboard", { body: { ...onboardBody({ phone: undefined }), signInToken: s.signInToken } });
  assert.equal(self.status, 400);
  assert.match(self.json.message, /someone else/);
  const none = await call("POST", "/api/onboard", { body: onboardBody({ phone: undefined }) });
  assert.equal(none.status, 400);
});

test("signing out retires the token on the server", async () => {
  const token = await existingAccount();
  assert.equal((await call("POST", "/api/signout", { token })).status, 204);
  assert.equal((await call("GET", "/api/me", { token })).status, 401);
  assert.equal(store.all().length, 1);
});

test("unfinished sign-ins expire after 48 hours", async () => {
  const s = await start("+16175550199");
  clock.pin(new Date(Date.now() + 49 * 3600_000).toISOString());
  await tick();
  assert.equal(store.signIns().length, 0);
  assert.equal((await call("GET", "/api/signin", { token: s.signInToken })).status, 401);
});
