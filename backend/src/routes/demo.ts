// Demo and test controls. Protected by `x-demo-key: $DEMO_KEY`; disabled when DEMO_KEY is unset
// in production. Typical stage run:
//   POST /demo/seed -> /demo/clock (Friday 11pm) -> /demo/place-enter -> /demo/purchase
// Testing without Photon keys:
//   POST /demo/inbound  simulates an iMessage arriving (links accounts, talks to Andi)
//   GET  /demo/outbox   shows what Andi would have sent

import { Hono } from "hono";
import crypto from "node:crypto";
import { z } from "zod";
import { clock } from "../clock.js";
import { config } from "../config.js";
import { errorBody } from "../http.js";
import { log } from "../log.js";
import { isAlcoholSeller, nessie } from "../nessie/client.js";
import { photonOutbox } from "../photon/client.js";
import type { PhotonEvent } from "../photon/events.js";
import { chipHub } from "../chip/hub.js";
import { handlePhotonEvent, sendCheckinPoll } from "../services/conversation.js";
import { onAlcoholPurchase, onPlaceEnter, evaluate, tick } from "../services/engine.js";
import { wrapped } from "../services/wrapped.js";
import { andiNumber, ensurePersonLine, ensureSponsorLine } from "../services/lines.js";
import { id, localDate, normalizeHandle, nowIso, safeEqual, store, token } from "../store.js";
import type { Person } from "../types.js";

export const demo = new Hono();

demo.use("/*", async (c, next) => {
  if (!config.demoKey || !safeEqual(c.req.header("x-demo-key") ?? "", config.demoKey))
    return c.json(errorBody("unauthorized", "Bad or missing x-demo-key."), 401);
  await next();
});

const body = async (c: { req: { json: () => Promise<unknown> } }) => (await c.req.json().catch(() => ({}))) ?? {};
const findPerson = (personId?: string) => (personId ? store.get(personId) : store.all().at(-1));
const notFound = (what = "person") => errorBody("not_found", `No ${what}. Seed or onboard first.`);

demo.post("/seed", async (c) => {
  const b = z
    .object({
      name: z.string().default("Maya"),
      phone: z.string().default("+16175550101"),
      sponsorName: z.string().default("Sam"),
      sponsorPhone: z.string().default("+16175550102"),
      days: z.number().int().min(0).default(41),
    })
    .parse(await body(c));

  const soberSince = localDate(new Date(clock.now().getTime() - b.days * 86_400_000));
  const phone = normalizeHandle(b.phone);
  const p: Person = {
    id: id("per"),
    name: b.name,
    phone,
    enteredPhone: phone,
    soberSince,
    createdAt: nowIso(),
    apiToken: token(),
    linkCode: String(100_000 + Math.floor(Math.random() * 900_000)),
    screening: { drinksPerDay: 4, drinksDaily: false, morningDrinking: false, pastWithdrawal: false, medicalFirst: false },
    consents: { location: true, purchases: true, shareWithSponsor: "status", sponsorAlerts: true },
    places: [
      {
        id: id("plc"),
        name: "The Rusty Anchor",
        lat: 42.3732,
        lng: -71.1189,
        radiusM: 150,
        kind: "bar",
        alternative: "the diner on Mass Ave is open till 2",
      },
    ],
    checkins: [],
    slips: [],
    events: [],
    purchases: [],
    chat: [],
    photon: {},
    weeklyDrinkSpend: 240,
    whyText: "I want to remember my mornings. I want my sister to trust me again.",
    sponsor: { name: b.sponsorName, phone: normalizeHandle(b.sponsorPhone), portalToken: token(), photon: {} },
  };

  if (nessie.enabled()) {
    try {
      const customerId = await nessie.createCustomer(p.name);
      const accountId = await nessie.createAccount(customerId);
      p.nessie = { customerId, accountId };
    } catch (err) {
      log.warn("demo", "Nessie seed failed", err);
    }
  }

  store.put(p);
  store.log(p.id, { kind: "onboarded" });
  await Promise.all([ensurePersonLine(p.id), ensureSponsorLine(p.id)]);
  await evaluate(p.id, "seed");
  const seeded = store.must(p.id);
  return c.json({
    personId: p.id,
    apiToken: p.apiToken,
    linkCode: p.linkCode,
    // What Maya and Sam each text first (their Photon line assignments).
    textFrom: { person: `${seeded.phone} -> ${andiNumber(seeded.photon) ?? "(no number configured)"}`, sponsor: `${seeded.sponsor!.phone} -> ${andiNumber(seeded.sponsor!.photon) ?? "(no number configured)"}` },
    portal: `${config.publicUrl}/s/${p.sponsor!.portalToken}`,
    nessie: Boolean(p.nessie),
  });
});

// Pin the clock, e.g. {"iso":"2026-10-16T23:05:00-04:00"} for Friday 11:05pm. {"iso":null} to unpin.
demo.post("/clock", async (c) => {
  const { iso } = z.object({ iso: z.string().nullable() }).parse(await body(c));
  if (iso && Number.isNaN(Date.parse(iso))) return c.json(errorBody("invalid_request", "Not a date."), 400);
  clock.pin(iso);
  return c.json({ now: clock.now().toISOString(), pinned: clock.isPinned() });
});

// Simulate an inbound iMessage, exactly as Photon would deliver it.
//   {"from":"+16175550101","text":"hi andi 123456"}       person (or sponsor) texting Andi
//   {"from":"...","pollVote":["lonely"]}                   voting on the HALT poll
//   {"from":"...","reaction":"❤️"}                         tapback
demo.post("/inbound", async (c) => {
  const b = z
    .object({
      from: z.string(),
      text: z.string().optional(),
      pollVote: z.array(z.string()).optional(),
      reaction: z.string().optional(),
    })
    .parse(await body(c));
  const handle = normalizeHandle(b.from);
  const hash = crypto.createHash("sha256").update(handle).digest("hex").slice(0, 12);
  const content = b.pollVote
    ? { type: "poll.vote", selectedOptions: b.pollVote.map((x) => ({ id: x, text: x })) }
    : b.reaction
      ? { type: "reaction", reaction: b.reaction, action: "add" }
      : { type: "text", text: b.text ?? "" };
  const event: PhotonEvent = {
    id: `evt_sim_${crypto.randomUUID()}`,
    type: "message.received",
    data: {
      object: {
        id: `msg_sim_${crypto.randomUUID()}`,
        platform: "imessage",
        status: "received",
        space: { id: `spc_sim_${hash}`, kind: "direct" },
        sentBy: { id: `usr_sim_${hash}`, handle, kind: "human" },
        receivedBy: { id: "usr_sim_andi", handle: config.photon.agentHandle || "+10000000000", kind: "agent" },
        content,
        createdAt: nowIso(),
      },
    },
  };
  const before = photonOutbox.list().length;
  await handlePhotonEvent(event);
  return c.json({ ok: true, replies: photonOutbox.list().slice(before) });
});

demo.get("/outbox", (c) => c.json(photonOutbox.list()));
demo.delete("/outbox", (c) => {
  photonOutbox.clear();
  return c.json({ ok: true });
});

demo.post("/place-enter", async (c) => {
  const { personId } = z.object({ personId: z.string().optional() }).parse(await body(c));
  const p = findPerson(personId);
  if (!p?.places[0]) return c.json(notFound("person or place"), 404);
  return c.json({ risk: await onPlaceEnter(p.id, p.places[0].id) });
});

// Makes a real Nessie purchase at an alcohol seller (when Nessie is configured), then feeds the signal.
demo.post("/purchase", async (c) => {
  const b = z
    .object({ personId: z.string().optional(), amount: z.number().positive().default(34), merchant: z.string().default("Square Wine & Spirits") })
    .parse(await body(c));
  const p = findPerson(b.personId);
  if (!p) return c.json(notFound(), 404);

  let source = "local";
  if (nessie.enabled() && p.nessie?.accountId) {
    try {
      const merchantId = await nessie.getOrCreateMerchant(b.merchant, "liquor store");
      const purchase = await nessie.createPurchase(p.nessie.accountId, merchantId, b.amount, "demo purchase");
      const merchant = await nessie.getMerchant(purchase.merchant_id ?? merchantId);
      if (!isAlcoholSeller(merchant)) return c.json({ ok: true, alcohol: false });
      source = "nessie";
    } catch (err) {
      log.warn("demo", "Nessie purchase failed, using local signal", err);
    }
  }
  return c.json({ source, risk: await onAlcoholPurchase(p.id, b.merchant, b.amount) });
});

demo.post("/checkin-poll", async (c) => {
  const p = findPerson();
  if (!p) return c.json(notFound(), 404);
  return c.json({ pollId: await sendCheckinPoll(p) });
});

demo.post("/advance", async (c) => {
  const { days, personId } = z.object({ days: z.number().int(), personId: z.string().optional() }).parse(await body(c));
  const p = findPerson(personId);
  if (!p) return c.json(notFound(), 404);
  store.update(p.id, (x) => {
    x.soberSince = new Date(new Date(x.soberSince).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  });
  await tick();
  return c.json({ wrapped: wrapped(store.must(p.id)) });
});

demo.post("/tick", async (c) => {
  await tick();
  return c.json({ ok: true });
});

demo.get("/state", (c) => {
  const p = findPerson(c.req.query("personId"));
  return c.json(p ?? null);
});

demo.get("/chip", (c) => {
  const p = findPerson(c.req.query("personId"));
  if (!p) return c.json(notFound(), 404);
  return c.json({ online: chipHub.connected(p.id), last: chipHub.last(p.id) ?? null });
});

demo.post("/reset", (c) => {
  for (const p of store.all()) store.remove(p.id);
  photonOutbox.clear();
  clock.pin(null);
  return c.json({ ok: true });
});
