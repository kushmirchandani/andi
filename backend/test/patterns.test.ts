import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, clock, demoHeaders, inbound, photonOutbox, reset, store } from "./helpers.js";
import { tick } from "../src/services/engine.js";
import { agentContext } from "../src/services/conversation.js";
import {
  INTERVENTIONS,
  nudgeText,
  patternInputs,
  patternMemory,
  summarizePatterns,
  type PatternInputs,
} from "../src/risk/patterns.js";

beforeEach(reset);

const demo = (path: string, body: unknown = {}) => call("POST", `/demo/${path}`, { body, headers: demoHeaders });

async function seedLinked() {
  const seed = await demo("seed", { phone: "+16175550101", sponsorPhone: "+16175550102", days: 41 });
  await inbound("+16175550101", { text: `hi andi ${seed.json.linkCode}` });
  await inbound("+16175550102", { text: "hi andi" });
  photonOutbox.clear();
  return seed.json as { personId: string; apiToken: string };
}

const texts = () => photonOutbox.list().map((m) => ("text" in m.content ? m.content.text : ""));
const base: PatternInputs = { historyDays: 30, hardMoments: "", halt: "hungry:0|angry:0|lonely:0|tired:0", placeEnters: 0, interventions: "" };

test("patterns: nothing is said without enough history", () => {
  const few = summarizePatterns({ ...base, historyDays: 30, hardMoments: "5:20:2|5:21:1" });
  assert.equal(few.ready, false);
  const young = summarizePatterns({ ...base, historyDays: 5, hardMoments: "5:20:6|5:21:4" });
  assert.equal(young.ready, false);
  assert.equal(young.riskyWindow, null);
});

test("patterns: a weekly window, a top trigger and what helped", () => {
  const s = summarizePatterns({
    ...base,
    hardMoments: "5:20:4|5:21:3|5:22:1|2:18:1",
    halt: "hungry:1|angry:0|lonely:5|tired:2",
    interventions: "walk:5:5|breathe:3:1|call:1:1",
  });
  assert.equal(s.ready, true);
  assert.deepEqual(s.riskyWindow, { weekday: 5, startHour: 20, hours: 3 });
  assert.equal(s.topTrigger, "lonely");
  assert.equal(s.whatHelped, "walk"); // breathe helped 1 of 3; call was only tried once
  assert.ok(s.confidence > 0 && s.confidence <= 100);
});

test("patterns: hard most nights becomes a daily window", () => {
  const hard = [0, 1, 2, 3, 4, 5, 6].map((w) => `${w}:21:1|${w}:22:1`).join("|");
  const s = summarizePatterns({ ...base, hardMoments: hard });
  assert.deepEqual(s.riskyWindow, { weekday: null, startHour: 21, hours: 3 });
});

test("patterns: the inputs are counts only, and respect consents", async () => {
  const { personId } = await seedLinked();
  await demo("place-enter");
  await demo("purchase", { merchant: "Square Wine & Spirits", amount: 34 });
  store.update(personId, (x) => x.slips.push({ at: clock.now().toISOString(), note: "had two beers at the game" }));

  const withAll = JSON.stringify(patternInputs(store.must(personId)));
  assert.doesNotMatch(withAll, /Square|Wine|beers|game|Rusty|Anchor|34/);
  assert.ok(patternInputs(store.must(personId)).placeEnters >= 1);

  store.update(personId, (x) => {
    x.consents = { ...x.consents, location: false, purchases: false };
  });
  const without = patternInputs(store.must(personId));
  assert.equal(without.placeEnters, 0);
});

test("andi learns you: demo history -> friday window, a walk helps, and /api/me shows it", async () => {
  const { personId, apiToken } = await seedLinked();
  const r = await demo("seed-history", { personId, weeks: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.json.demoData, true);
  assert.equal(r.json.patterns.ready, true);
  assert.equal(r.json.patterns.riskyWindow.weekday, 5);
  assert.equal(r.json.patterns.riskyWindow.startHour, 20);
  assert.equal(r.json.patterns.riskyWindow.label, "friday 8pm–11pm");
  assert.equal(r.json.patterns.whatHelped.kind, "walk");
  assert.equal(r.json.patterns.topTrigger.kind, "lonely");
  assert.match(r.json.nudgePreview, /it's almost friday (evening|night)\. last time it got hard, the walk helped/);

  const me = await call("GET", "/api/me", { token: apiToken });
  assert.equal(me.json.patterns.ready, true);
  assert.equal(me.json.patterns.whatHelped.label, "a walk");

  // The brain gets a short memory line; it never names places or purchases.
  const memory = agentContext(store.must(personId)).memory!;
  assert.match(memory, /friday 8pm–11pm/);
  assert.match(memory, /a walk/);
  assert.doesNotMatch(memory, /Rusty|purchase|slip|bar/i);
});

test("andi learns you: one text 20-60 minutes before the window, once", async () => {
  const { personId } = await seedLinked();
  const r = await demo("seed-history", { personId });
  clock.pin(r.json.nudgeAt);
  await tick();
  const nudges = () => texts().filter((t) => /it's almost friday/.test(t));
  assert.equal(nudges().length, 1);
  assert.match(nudges()[0], /walk/);
  assert.ok(store.must(personId).events.some((e) => e.kind === "outreach" && e.detail === "pattern"));

  // Ten minutes later: still in the lead window, but it's already been sent.
  clock.pin(new Date(new Date(r.json.nudgeAt).getTime() + 10 * 60_000).toISOString());
  await tick();
  assert.equal(nudges().length, 1);
});

test("andi learns you: no pre-window text in quiet hours or after two unanswered texts", async () => {
  const { personId } = await seedLinked();
  const r = await demo("seed-history", { personId });

  store.update(personId, (x) => {
    x.quietHours = { enabled: true, start: 18, end: 23 };
  });
  clock.pin(r.json.nudgeAt);
  await tick();
  assert.equal(texts().filter((t) => /it's almost friday/.test(t)).length, 0);

  store.update(personId, (x) => {
    x.quietHours = undefined;
    x.events.push({ at: clock.now().toISOString(), kind: "outreach" }, { at: clock.now().toISOString(), kind: "outreach" });
  });
  clock.pin(new Date(new Date(r.json.nudgeAt).getTime() + 10 * 60_000).toISOString());
  await tick();
  assert.equal(texts().filter((t) => /it's almost friday/.test(t)).length, 0);
});

test("andi learns you: the pre-window text never mentions slips, drinks, purchases or places", () => {
  const windows = [{ weekday: 5, startHour: 20, hours: 3 }, { weekday: null, startHour: 21, hours: 3 }];
  for (const riskyWindow of windows) {
    for (const whatHelped of [...INTERVENTIONS, null]) {
      const t = nudgeText({ ready: true, riskyWindow, topTrigger: "places", whatHelped, confidence: 80 }, "Sam");
      assert.doesNotMatch(t, /slip|drink|alcohol|bought|purchase|bar|store|place/i, t);
      assert.equal(t, t.toLowerCase());
    }
  }
  assert.equal(patternMemory({ ready: false, riskyWindow: null, topTrigger: null, whatHelped: null, confidence: 0 }), undefined);
});

test("andi learns you: a coping mention is kept as a kind, never the words", async () => {
  const { personId } = await seedLinked();
  await inbound("+16175550101", { text: "went for a walk by the river, feeling a bit better" });
  const coping = store.must(personId).events.filter((e) => e.kind === "coping");
  assert.deepEqual(coping.map((e) => e.detail), ["walk"]);
  assert.doesNotMatch(JSON.stringify(store.must(personId).events), /river/);
});
