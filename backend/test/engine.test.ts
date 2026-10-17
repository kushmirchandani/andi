import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, clock, demoHeaders, inbound, photonOutbox, reset, store } from "./helpers.js";
import { inQuietHours, tick } from "../src/services/engine.js";

beforeEach(reset);

const demo = (path: string, body: unknown = {}) => call("POST", `/demo/${path}`, { body, headers: demoHeaders });

async function seedLinked() {
  const seed = await demo("seed", { phone: "+16175550101", sponsorPhone: "+16175550102", days: 41 });
  await inbound("+16175550101", { text: `hi andi ${seed.json.linkCode}` });
  await inbound("+16175550102", { text: "hi andi" });
  photonOutbox.clear();
  return seed.json as { personId: string; apiToken: string; portal: string };
}

test("the Friday-night story: bar -> elevated, liquor store -> high, sponsor alerted once", async () => {
  const { personId, portal } = await seedLinked();
  await demo("clock", { iso: "2026-10-16T23:05:00-04:00" });

  const enter = await demo("place-enter");
  assert.equal(enter.json.risk.level, "elevated");
  const texts = photonOutbox.list().map((m) => ("text" in m.content ? m.content.text : ""));
  assert.ok(texts.some((t) => /do you want to be here right now\?/.test(t)));
  assert.ok(texts.some((t) => /the diner on Mass Ave is open till 2/.test(t)));

  const buy = await demo("purchase");
  assert.equal(buy.json.risk.level, "high");
  const alerts = () => store.must(personId).events.filter((e) => e.kind === "sponsor_alert").length;
  assert.equal(alerts(), 1);
  const sponsorMsgs = photonOutbox.list().filter((m) => m.spaceId !== store.must(personId).photon.spaceId);
  assert.ok(sponsorMsgs.some((m) => "text" in m.content && /might need a call tonight/.test(m.content.text)));

  // A second high signal inside the cooldown doesn't alert again.
  await demo("purchase", { amount: 12 });
  assert.equal(alerts(), 1);

  // Money saved accounts for alcohol purchases.
  const me = await call("GET", "/api/me", { token: store.must(personId).apiToken });
  assert.equal(me.json.moneySaved, Math.round((240 / 7) * me.json.day - 46));

  // The portal shows only what she shares (status, no reason).
  const html = await call("GET", new URL(portal).pathname);
  assert.match(String(html.json), /might need a call tonight/);
  const status = await call("GET", `${new URL(portal).pathname}/status.json`);
  assert.equal(status.json.reason, null);
});

test("re-entering the same place within 30 minutes doesn't re-ask", async () => {
  await seedLinked();
  await demo("clock", { iso: "2026-10-16T23:05:00-04:00" });
  await demo("place-enter");
  const n = photonOutbox.list().length;
  await demo("clock", { iso: "2026-10-16T23:15:00-04:00" });
  await demo("place-enter");
  const asks = photonOutbox.list().slice(n).filter((m) => "text" in m.content && /want to be here/.test(m.content.text));
  assert.equal(asks.length, 0);
});

test("location consent off: geofence events are ignored", async () => {
  const { apiToken } = await seedLinked();
  await call("PUT", "/api/consents", { token: apiToken, body: { location: false, purchases: true, shareWithSponsor: "status", sponsorAlerts: true } });
  const r = await demo("place-enter");
  assert.equal(r.json.risk, null);
});

test("quiet hours: no proactive nudges at 4am, nudges stop after two unanswered", async () => {
  const { personId } = await seedLinked();
  clock.pin("2026-10-17T04:00:00-04:00");
  assert.equal(inQuietHours(), true);
  store.update(personId, (x) => {
    x.checkins.push({ at: clock.now().toISOString(), hungry: true, angry: true, lonely: true, tired: true, source: "app" });
  });
  await tick();
  assert.equal(photonOutbox.list().filter((m) => "text" in m.content && /thinking of you/.test(m.content.text)).length, 0);

  // Evening: nudges allowed, every 3h, at most two in a row without a reply.
  let t = new Date("2026-10-17T19:00:00-04:00").getTime();
  for (let i = 0; i < 4; i++) {
    clock.pin(new Date(t).toISOString());
    store.update(personId, (x) => {
      x.checkins.push({ at: clock.now().toISOString(), hungry: true, angry: true, lonely: true, tired: true, source: "app" });
    });
    await tick();
    t += 3.5 * 3600_000;
    if (new Date(t).getHours() >= 2 && new Date(t).getHours() < 9) t += 8 * 3600_000;
  }
  const nudges = photonOutbox.list().filter((m) => "text" in m.content && /thinking of you/.test(m.content.text));
  assert.equal(nudges.length, 2);
});

test("milestones are texted once", async () => {
  const { personId } = await seedLinked();
  clock.pin("2026-10-17T12:00:00-04:00");
  store.update(personId, (x) => {
    x.soberSince = "2026-09-17"; // day 30
  });
  await tick();
  await tick();
  const ms = photonOutbox.list().filter((m) => "text" in m.content && /^day 30\./.test(m.content.text));
  assert.equal(ms.length, 1);
});

test("signups that never text Andi expire after 48 hours", async () => {
  const r = await call("POST", "/api/onboard", { body: { name: "Gone", phone: "+16175550150", soberSince: "2026-09-01", screening: { drinksPerDay: 1, drinksDaily: false, morningDrinking: false, pastWithdrawal: false } } });
  assert.equal(r.status, 200);
  clock.pin(new Date(Date.now() + 49 * 3600_000).toISOString());
  await tick();
  assert.equal(store.byToken(r.json.apiToken), undefined);
});

test("turning sharing off replaces the sponsor's status with a neutral line", async () => {
  const { apiToken } = await seedLinked();
  photonOutbox.clear();
  await call("PUT", "/api/consents", { token: apiToken, body: { location: true, purchases: true, shareWithSponsor: "none", sponsorAlerts: true } });
  const edit = photonOutbox.list().find((m) => m.content.type === "text.update");
  assert.ok(edit && "text" in edit.content && /isn't sharing their status/.test(edit.content.text));
});
