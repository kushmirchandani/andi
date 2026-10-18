import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { call, clock, demoHeaders, inbound, photonOutbox, reset, store } from "./helpers.js";
import { tick } from "../src/services/engine.js";
import { config } from "../src/config.js";
import { milestoneCard, avatarPng } from "../src/cards/render.js";
import { photon } from "../src/photon/client.js";

const demo = (path: string, body: unknown = {}) => call("POST", `/demo/${path}`, { body, headers: demoHeaders });

async function seedLinked() {
  const seed = await demo("seed", { phone: "+16175550101", sponsorPhone: "+16175550102", days: 41 });
  await inbound("+16175550101", { text: `hi andi ${seed.json.linkCode}` });
  photonOutbox.clear();
  return seed.json as { personId: string };
}

const sent = () => photonOutbox.list();
const ofType = (t: string) => sent().filter((m) => m.content.type === t);

// Real fetch is never used: ElevenLabs and Photon are stubbed per test.
const realFetch = globalThis.fetch;
const saved = { ...config.elevenlabs, photonKey: config.photon.apiKey, photonProject: config.photon.projectId };
function enableTts(onTts?: (body: any) => void) {
  config.elevenlabs.apiKey = "test-el";
  config.elevenlabs.voiceId = "voice123";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.elevenlabs.io/v1/text-to-speech/voice123")) {
      onTts?.(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

beforeEach(reset);
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(config.elevenlabs, { apiKey: saved.apiKey, voiceId: saved.voiceId });
  config.photon.apiKey = saved.photonKey;
  config.photon.projectId = saved.photonProject;
});

test("cards render as real PNGs", () => {
  const png = milestoneCard(30)!;
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1350);
  assert.equal(avatarPng().readUInt32BE(16), 1024);
});

test("a milestone sends the text, then the image card, once; no voice note without a voice", async () => {
  const { personId } = await seedLinked();
  clock.pin("2026-10-17T12:00:00-04:00");
  store.update(personId, (x) => {
    x.soberSince = "2026-09-17"; // day 30
  });
  await tick();
  await tick();
  const out = sent();
  const textIdx = out.findIndex((m) => "text" in m.content && /^day 30\./.test(m.content.text));
  const cardIdx = out.findIndex((m) => m.content.type === "attachment");
  assert.ok(textIdx >= 0 && cardIdx > textIdx, "card follows the text");
  assert.equal(ofType("attachment").length, 1);
  assert.equal(out[cardIdx].file?.contentType, "image/png");
  assert.ok((out[cardIdx].file?.sizeBytes ?? 0) > 10_000);
  assert.equal(ofType("voice").length, 0);
});

test("day 90 also gets the recap card", async () => {
  const { personId } = await seedLinked();
  clock.pin("2026-10-17T12:00:00-04:00");
  store.update(personId, (x) => {
    x.soberSince = "2026-07-19"; // day 90
  });
  await tick();
  assert.deepEqual(ofType("attachment").map((m) => m.file?.filename), ["andi-day-90.png", "andi-90-days.png"]);
});

test("milestone voice note: andi's voice says the milestone; text still goes first", async () => {
  let spoken = "";
  enableTts((b) => (spoken = b.text));
  const { personId } = await seedLinked();
  clock.pin("2026-10-17T12:00:00-04:00");
  store.update(personId, (x) => {
    x.soberSince = "2026-10-10"; // day 7
  });
  await tick();
  assert.match(spoken, /day 7\. 7 mornings you remember/);
  const voice = ofType("voice");
  assert.equal(voice.length, 1);
  assert.equal(voice[0].file?.contentType, "audio/mpeg");
  assert.ok(store.must(personId).events.some((e) => e.kind === "voice_note" && e.detail === "milestone 7"));
});

test("asking for a voice note gets one; three a day, then text only", async () => {
  enableTts();
  await seedLinked();
  for (let i = 0; i < 4; i++) await inbound("+16175550101", { text: "can you send me a voice note" });
  assert.equal(ofType("voice").length, 3);
  assert.equal(ofType("text").length, 4); // every reply still went as text
});

test("a win gets a heart tapback on their message; cravings and crises don't", async () => {
  await seedLinked();
  const r = await call("POST", "/demo/inbound", {
    body: { from: "+16175550101", text: "i made it through the night" },
    headers: demoHeaders,
  });
  const reactions = (r.json.replies as any[]).filter((m) => m.content.type === "reaction");
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].content.reaction, "❤️");
  assert.match(reactions[0].parentMessageId, /^msg_sim_/);

  photonOutbox.clear();
  await inbound("+16175550101", { text: "i made it to the bar and i want a drink" });
  await inbound("+16175550101", { text: "i made it through but i want to kill myself" });
  await inbound("+16175550101", { text: "made it through today but it was so hard" });
  assert.equal(ofType("reaction").length, 0);
});

test("photon attachment upload: multipart/related JSON part then bytes, then an attachment message", async () => {
  config.photon.apiKey = "pho_sk_test";
  config.photon.projectId = "pho_prj_test";
  const calls: { url: string; headers: Record<string, string>; body: Buffer | string }[] = [];
  let notReady = 1;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: u, headers, body: Buffer.isBuffer(init?.body) ? (init!.body as Buffer) : String(init?.body) });
    if (u.endsWith("/attachments")) return Response.json({ id: "pho_att_0000000000000000000000000a" }, { status: 201 });
    if (u.endsWith("/messages")) {
      if (notReady-- > 0) return Response.json({ code: "ATTACHMENT_NOT_READY", status: 409 }, { status: 409 });
      return Response.json({ id: "pho_msg_0000000000000000000000000b" }, { status: 202 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const res = await photon.image({ spaceId: "pho_spc_x", senderId: "pho_usr_y" }, png, "card.png");
  assert.equal(res.id, "pho_msg_0000000000000000000000000b");

  const up = calls.find((c) => c.url.endsWith("/attachments"))!;
  assert.match(up.headers["content-type"], /^multipart\/related; boundary=/);
  assert.ok(up.headers["idempotency-key"]);
  const body = up.body as Buffer;
  const text = body.toString("latin1");
  const meta = JSON.parse(text.slice(text.indexOf("{"), text.indexOf("}") + 1));
  assert.deepEqual(meta, { contentType: "image/png", sizeBytes: png.length, filename: "card.png" });
  assert.ok(body.includes(png), "the file bytes are the second part");

  const msgs = calls.filter((c) => c.url.endsWith("/messages"));
  assert.equal(msgs.length, 2, "retried once after ATTACHMENT_NOT_READY");
  assert.equal(msgs[0].headers["idempotency-key"], msgs[1].headers["idempotency-key"]);
  assert.deepEqual(JSON.parse(String(msgs[1].body)).content, { type: "attachment", attachmentId: "pho_att_0000000000000000000000000a" });
});

test("card preview route needs the demo key", async () => {
  const ok = await call("GET", "/demo/card/milestone?day=7", { headers: demoHeaders });
  assert.equal(ok.status, 200);
  assert.equal((await call("GET", "/demo/card/milestone")).status, 401);
  assert.equal((await call("GET", "/demo/card/nope", { headers: demoHeaders })).status, 404);
});
