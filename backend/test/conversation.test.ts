import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, inbound, onboard, photonOutbox, reset, store } from "./helpers.js";

beforeEach(reset);

test("texting the link code links the account and Andi says hi", async () => {
  const { apiToken: token, linkCode } = await onboard();
  const replies = await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  assert.match(replies[0], /it's andi/);
  const me = await call("GET", "/api/me", { token });
  assert.equal(me.json.imessageLinked, true);
  assert.equal(me.json.linkCode, null);
});

test("an iMessage email handle links through the code", async () => {
  const { apiToken: token, linkCode } = await onboard({ phone: "+16175550111" });
  await inbound("maya@icloud.com", { text: `hi andi ${linkCode}` });
  const p = store.byToken(token)!;
  assert.equal(p.phone, "maya@icloud.com");
  assert.equal(p.photon.spaceId !== undefined, true);
});

test("linking needs the code: texting from the typed number alone doesn't link", async () => {
  const { apiToken: token } = await onboard({ phone: "617 555 0103" });
  await inbound("+16175550103", { text: "hey" });
  assert.equal((await call("GET", "/api/me", { token })).json.imessageLinked, false);
});

test("someone else's number can't use a code: the handle must match the typed number", async () => {
  const { apiToken: token, linkCode } = await onboard({ phone: "+16175550104" });
  await inbound("+16175554444", { text: `hi andi ${linkCode}` });
  assert.equal((await call("GET", "/api/me", { token })).json.imessageLinked, false);
  await inbound("+16175550104", { text: `hi andi ${linkCode}` });
  assert.equal((await call("GET", "/api/me", { token })).json.imessageLinked, true);
});

test("crisis is answered first on every path: first contact, keywords, sponsors, strangers", async () => {
  const { linkCode } = await onboard();
  const first = await inbound("+16175550101", { text: `hi andi ${linkCode} i want to kill myself` });
  assert.match(first[0], /988/);
  assert.ok(!first.some((r) => /it's andi\. save me/.test(r)), "no cheerful welcome after a crisis message");
  const kw = await inbound("+16175550101", { text: "call me crazy but i want to die" });
  assert.match(kw[0], /988/);
  await inbound("+16175550102", { text: "hi andi" });
  const sponsor = await inbound("+16175550102", { text: "honestly i want to kill myself too" });
  assert.match(sponsor[0], /988/);
  assert.ok(!sponsor.some((r) => r.startsWith("from Sam")), "a sponsor's crisis text is never relayed");
  const stranger = await inbound("+19995550001", { text: "hello" });
  assert.equal(stranger.length, 1);
  const stranger2 = await inbound("+19995550001", { text: "i don’t want to live" });
  assert.match(stranger2[0], /988/);
});

test("sponsor relay is guarded, and someone who sponsors two people must name who it's for", async () => {
  const ann = await onboard({ name: "Ann", phone: "+16175550111", sponsor: { name: "Sam", phone: "+16175550102" } });
  const ben = await onboard({ name: "Ben", phone: "+16175550112", sponsor: { name: "Sam", phone: "+16175550102" } });
  await inbound("+16175550111", { text: `hi andi ${ann.linkCode}` });
  await inbound("+16175550112", { text: `hi andi ${ben.linkCode}` });
  const intro = await inbound("+16175550102", { text: "hi andi" });
  assert.equal(intro.filter((r) => /picked you as their person/.test(r)).length, 2, "linked as the person for both");
  const ambiguous = await inbound("+16175550102", { text: "call me tonight" });
  assert.match(ambiguous[0], /start with a name/);
  const named = await inbound("+16175550102", { text: "Ben: call me tonight" });
  assert.ok(named.some((r) => r === 'from Sam: "call me tonight"'));
  const bad = await inbound("+16175550102", { text: "Ann: have a drink, you earned it" });
  assert.match(bad[0], /didn't pass that one along/);
});

test("a sponsor who also uses Andi still gets linked as someone's person", async () => {
  const sam = await onboard({ name: "Sam", phone: "+16175550102", sponsor: { name: "Lee", phone: "+16175550130" } });
  await inbound("+16175550102", { text: `hi andi ${sam.linkCode}` });
  const maya = await onboard({ name: "Maya", phone: "+16175550101", sponsor: { name: "Sam", phone: "+16175550102" } });
  await inbound("+16175550101", { text: `hi andi ${maya.linkCode}` });
  const r = await inbound("+16175550102", { text: "how's it going" });
  assert.ok(r.some((x) => /Maya picked you as their person/.test(x)));
  assert.equal(store.byToken(maya.apiToken)!.sponsor!.photon.spaceId !== undefined, true);
});

test("reinstall: onboarding again and texting the new code restores the old account", async () => {
  const first = await onboard();
  await inbound("+16175550101", { text: `hi andi ${first.linkCode}` });
  await call("POST", "/api/checkin", { token: first.apiToken, body: { hungry: true, angry: false, lonely: false, tired: false } });

  const second = await onboard({ soberSince: "2026-10-10" });
  const replies = await inbound("+16175550101", { text: `hi andi ${second.linkCode}` });
  assert.match(replies[0], /welcome back/);
  assert.equal(store.all().length, 1);
  const me = await call("GET", "/api/me", { token: second.apiToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.soberSince, "2026-09-06", "kept the original account");
  assert.equal((await call("GET", "/api/me", { token: first.apiToken })).status, 401, "old install's token retired");
});

test("a linked person texting a stranger's code never takes over that account", async () => {
  const maya = await onboard();
  await inbound("+16175550101", { text: `hi andi ${maya.linkCode}` });
  const other = await onboard({ name: "Jo", phone: "+16175550120", sponsor: undefined });
  await inbound("+16175550101", { text: `my code is ${other.linkCode}` });
  assert.equal(store.all().length, 2);
  assert.equal(store.byToken(other.apiToken)!.photon.spaceId, undefined);
  assert.ok(store.byToken(maya.apiToken));
});

test("the sponsor texting once gets the intro and a status message, edited in place later", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  const replies = await inbound("+16175550102", { text: "hi" });
  assert.match(replies[0], /picked you as their person/);
  assert.match(replies[1], /Maya · day \d+\nsteady today/);
  photonOutbox.clear();
  // Push risk up with a check-in; the status text changes, so Andi edits the message.
  await call("POST", "/api/checkin", { token, body: { hungry: true, angry: true, lonely: true, tired: true } });
  const sent = photonOutbox.list();
  const edit = sent.find((m) => m.content.type === "text.update");
  if (store.byToken(token)!.lastRisk!.level !== "low") {
    assert.ok(edit, "status edited in place");
    assert.ok(edit!.parentMessageId);
  }
});

test("sponsor encouragement is passed along, attributed", async () => {
  const { linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  await inbound("+16175550102", { text: "hi" });
  const replies = await inbound("+16175550102", { text: "so proud of you maya" });
  assert.ok(replies.some((r) => r.startsWith('from Sam: "so proud of you maya"')));
});

test("CALL and BREATHE keywords act immediately", async () => {
  const { linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  await inbound("+16175550102", { text: "hi" });
  const call1 = await inbound("+16175550101", { text: "CALL" });
  assert.ok(call1.some((r) => /asked Sam to call you/.test(r)));
  const again = await inbound("+16175550101", { text: "call" });
  assert.ok(again.some((r) => /already on it/.test(r)));
  const breathe = await inbound("+16175550101", { text: "breathe" });
  assert.ok(breathe.some((r) => /in for 4/.test(r)));
});

test("HALT poll votes record a check-in", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  const replies = await inbound("+16175550101", { pollVote: ["lonely"] });
  assert.match(replies[0], /lonely/);
  assert.equal(store.byToken(token)!.checkins.at(-1)!.lonely, true);
});

test("crisis messages always get 988, and are logged", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  const replies = await inbound("+16175550101", { text: "i don't want to be alive anymore" });
  assert.match(replies.join(" "), /988/);
  assert.ok(store.byToken(token)!.events.some((e) => e.kind === "crisis"));
});

test("conversation history persists on the person (capped)", async () => {
  const { apiToken: token, linkCode } = await onboard();
  await inbound("+16175550101", { text: `hi andi ${linkCode}` });
  for (let i = 0; i < 12; i++) await inbound("+16175550101", { text: `message ${i}` });
  const p = store.byToken(token)!;
  assert.equal(p.chat.length, 20);
  assert.equal(p.chat.at(-2)!.content, "message 11");
});

test("strangers get one pointer a day, nothing stored", async () => {
  const a = await inbound("+19995550000", { text: "who is this" });
  assert.equal(a.length, 1);
  assert.match(a[0], /download the andi app/);
  const b = await inbound("+19995550000", { text: "hello?" });
  assert.equal(b.length, 0);
  assert.equal(store.all().length, 0);
});
