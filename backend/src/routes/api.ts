// Endpoints for the iOS app. Auth: `Authorization: Bearer <apiToken>`. The token is created by
// POST /api/signin and becomes the account's token once the person texts Andi (or onboards).
// Errors are always { error: "<code>", message: "<safe to show>" } (see index.ts onError).

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { routeInbound, screen } from "../agent/safety.js";
import { validTimezone } from "../risk/signals.js";
import { textPerson } from "../services/targets.js";
import { chipHub } from "../chip/hub.js";
import { clock } from "../clock.js";
import { config } from "../config.js";
import { findMyEnabled, requestFindMy } from "../findmy/watcher.js";
import { ApiError, errorBody, rateLimit } from "../http.js";
import { log } from "../log.js";
import { callPerson } from "../services/calls.js";
import { evaluate, onCheckin, onPlaceEnter, onPlaceExit, onSlip, pushChip, quietHoursFor, saved, startBreathing } from "../services/engine.js";
import { welcomeNewPerson } from "../services/conversation.js";
import {
  andiNumber,
  ensurePersonLine,
  ensureSignInLine,
  ensureSponsorLine,
  healLines,
  releasePersonLines,
  releaseSponsorLine,
} from "../services/lines.js";
import { clearSponsorStatus, portalUrl, updateSponsorStatus } from "../services/sponsor.js";
import { wrapped } from "../services/wrapped.js";
import { daysSober, id, isValidHandle, localDate, normalizeHandle, nowIso, store, token } from "../store.js";
import type { Person } from "../types.js";
import { patternsView } from "../risk/patterns.js";

type Env = { Variables: { person: Person } };
export const api = new Hono<Env>();

export const MAX_PLACES = 20; // CLMonitor monitors at most 20 conditions per app

const Handle = z
  .string()
  .trim()
  .max(100, "That number is too long.")
  .refine(isValidHandle, { message: "Enter a phone number with area code (or your iMessage email)." });

const Name = z.string().trim().min(1, "Add a name.").max(60, "Keep the name under 60 characters.");

const Consents = z.object({
  location: z.boolean(),
  purchases: z.boolean(),
  shareWithSponsor: z.enum(["none", "status", "status_and_reason"]),
  sponsorAlerts: z.boolean(),
});

const Hour = z.number().int().min(0).max(23);
const QuietHours = z
  .object({ enabled: z.boolean(), start: Hour, end: Hour })
  .refine((q) => !q.enabled || q.start !== q.end, { message: "Pick a different start and end time." });

const SoberSince = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((d) => !Number.isNaN(Date.parse(d)), "Not a real date.")
  .refine((d) => d >= "1950-01-01", "That date looks too far back.");

const Onboard = z.object({
  name: Name,
  // From POST /api/signin. When present, the phone comes from the sign-in and `phone` is ignored.
  signInToken: z.string().max(200).optional().nullable(),
  phone: Handle.optional().nullable(),
  soberSince: SoberSince,
  weeklyDrinkSpend: z.number().nonnegative().max(10_000).default(0),
  screening: z.object({
    drinksPerDay: z.number().nonnegative().max(100),
    drinksDaily: z.boolean(),
    morningDrinking: z.boolean(),
    pastWithdrawal: z.boolean(),
  }),
  sponsor: z.object({ name: Name, phone: Handle }).optional().nullable(),
  consents: Consents.optional().nullable(),
  why: z.string().trim().max(1000).optional().nullable(),
  timezone: z.string().max(64).optional().nullable(), // IANA zone from the phone
}).superRefine((b, ctx) => {
  if (!b.signInToken && !b.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Enter a phone number with area code." });
  // "Today" depends on where the person is. Without a zone, accept anything that's today somewhere on Earth.
  const today = localDate(clock.now(), validTimezone(b.timezone) ?? "Pacific/Kiritimati");
  if (b.soberSince > today) ctx.addIssue({ code: "custom", path: ["soberSince"], message: "Your start date can't be in the future." });
});

async function json(c: { req: { json: () => Promise<unknown> } }) {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "The request body must be JSON.");
  }
}

function linkCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(100_000, 1_000_000));
    if (!store.linkCodeInUse(code)) return code;
  }
  throw new ApiError(503, "busy", "Couldn't create a link code. Try again.");
}

export function summary(p: Person) {
  const linked = Boolean(p.photon.spaceId);
  return {
    id: p.id,
    name: p.name,
    day: daysSober(p),
    soberSince: p.soberSince,
    moneySaved: saved(p),
    risk: p.lastRisk ?? null,
    consents: p.consents,
    quietHours: quietHoursFor(p),
    places: p.places,
    // andiNumber: the number their person texts to connect (it can differ from the person's own Andi number).
    sponsor: p.sponsor
      ? { name: p.sponsor.name, phone: p.sponsor.phone, linked: Boolean(p.sponsor.photon.spaceId), andiNumber: andiNumber(p.sponsor.photon) }
      : null,
    imessageLinked: linked,
    agentHandle: andiNumber(p.photon),
    voiceNumber: config.photon.voiceNumber || null,
    // Paused features: the app hides the chip section when chip is false.
    features: { chip: config.features.chip },
    chipPaired: config.features.chip && Boolean(p.chipToken),
    chipOnline: config.features.chip && chipHub.connected(p.id),
    medicalFirst: p.screening.medicalFirst,
    portalUrl: portalUrl(p),
    linkCode: linked ? null : (p.linkCode ?? null),
    why: p.whyText ?? null,
    hasWhyAudio: Boolean(p.whyAudioPath),
    findMyAvailable: findMyEnabled(),
    // What Andi has learned from their own history (ready once there's ~2 weeks of it).
    patterns: patternsView(p.patterns),
  };
}

const bearer = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

// Public: the app's first screen. Starts a sign-in for a number and returns a code to text Andi.
// The response is the same whether or not the number has an account; Andi's reply to the text
// is the only place that shows (see handleSignIn in services/conversation.ts).
api.post("/signin", rateLimit({ windowMs: 3600_000, max: 20 }), async (c) => {
  const { phone: typed } = z.object({ phone: Handle }).parse(await json(c));
  const phone = normalizeHandle(typed);
  const s = store.putSignIn({ id: id("sgn"), phone, enteredPhone: phone, token: token(), code: linkCode(), createdAt: nowIso(), photon: {} });
  await ensureSignInLine(s.id);
  return c.json({
    signInToken: s.token,
    linkCode: s.code,
    firstText: "hi andi",
    agentHandle: andiNumber(s.photon),
  });
});

// Public: the app polls this with the sign-in token while it waits for the text.
//   waiting    no text yet
//   verified   texted from that number and there's no account: finish with /api/onboard
//   signed_in  texted and there's an account: the token now works everywhere (GET /api/me)
api.get("/signin", (c) => {
  const t = bearer(c);
  if (store.byToken(t)) return c.json({ state: "signed_in" });
  const s = store.signInByToken(t);
  if (!s) return c.json(errorBody("unauthorized", "That sign-in expired. Start again."), 401);
  return c.json({ state: s.verifiedAt ? "verified" : "waiting" });
});

// Public: create an account. With a verified sign-in the account is linked right away. Otherwise
// it's "pending" until the person texts Andi from their phone (that first text verifies the
// number; see services/conversation.ts). The app offers that text at the end and in Settings.
api.post("/onboard", rateLimit({ windowMs: 3600_000, max: 20 }), async (c) => {
  const body = Onboard.parse(await json(c));
  const signIn = body.signInToken ? store.signInByToken(body.signInToken) : undefined;
  if (body.signInToken && !signIn) throw new ApiError(401, "unauthorized", "That sign-in expired. Start again.");
  const phone = signIn ? signIn.phone : normalizeHandle(body.phone!);
  const enteredPhone = signIn ? signIn.enteredPhone : phone;
  if (body.sponsor && [phone, enteredPhone].includes(normalizeHandle(body.sponsor.phone)))
    throw new ApiError(400, "invalid_request", "Your person needs to be someone else's number.");
  const verified = Boolean(signIn?.verifiedAt);

  // Abandoned pending accounts (never texted Andi) are cleaned up after 48 hours by the tick.
  // They're never removed here: anyone can type anyone's number, so that would let a stranger
  // delete someone's in-progress signup.

  const result = screen(body.screening);
  const person: Person = {
    id: id("per"),
    name: body.name,
    phone,
    enteredPhone,
    soberSince: body.soberSince,
    timezone: validTimezone(body.timezone),
    createdAt: nowIso(),
    apiToken: signIn?.token ?? token(),
    // A skipped sign-in keeps its code, so the text the app offers later is the same one.
    linkCode: verified ? undefined : (signIn?.code ?? linkCode()),
    screening: { ...body.screening, medicalFirst: result.medicalFirst },
    consents: body.consents ?? { location: true, purchases: true, shareWithSponsor: "status", sponsorAlerts: true },
    places: [],
    checkins: [],
    slips: [],
    events: [],
    purchases: [],
    chat: [],
    photon: signIn ? { ...signIn.photon } : {},
    weeklyDrinkSpend: body.weeklyDrinkSpend,
    whyText: body.why || undefined,
    sponsor: body.sponsor
      ? { name: body.sponsor.name, phone: normalizeHandle(body.sponsor.phone), portalToken: token(), photon: {} }
      : undefined,
  };
  store.put(person);
  if (signIn) store.removeSignIn(signIn.id); // its line now belongs to the person
  store.log(person.id, { kind: "onboarded" });
  if (verified) store.log(person.id, { kind: "linked" });
  // Photon only delivers messages from assigned handles, so assign lines before they text.
  await Promise.all([ensurePersonLine(person.id), ensureSponsorLine(person.id)]);
  await evaluate(person.id, "onboard");
  log.info("api", `onboarded ${person.id}${verified ? " (verified)" : ""}${result.medicalFirst ? " (medical-first)" : ""}`);
  if (verified) await welcomeNewPerson(store.must(person.id));
  return c.json({
    apiToken: person.apiToken,
    screening: result,
    agentHandle: andiNumber(store.must(person.id).photon),
    voiceNumber: config.photon.voiceNumber || null,
    // The shared Photon line can only reply after the person texts it first.
    firstText: "hi andi",
    linkCode: person.linkCode ?? null,
    me: summary(store.must(person.id)),
  });
});

// Everything below needs the person's token.
api.use("/*", async (c, next) => {
  const p = store.byToken(bearer(c));
  if (!p) return c.json(errorBody("unauthorized", "Please sign in again."), 401);
  // The app sends its current time zone on every request, so day counts follow travel.
  const tz = validTimezone(c.req.header("x-timezone"));
  if (tz && tz !== p.timezone) store.update(p.id, (x) => void (x.timezone = tz));
  c.set("person", p);
  await next();
});

// Per-person limit for everything authenticated: generous for humans, stops runaway loops.
api.use("/*", rateLimit({ windowMs: 60_000, max: 120, key: (c) => `p:${c.get("person").id}` }));

const me = (c: { get: (k: "person") => Person }) => store.must(c.get("person").id);

api.get("/me", async (c) => {
  await healLines(me(c).id); // no-op once both lines are assigned
  return c.json(summary(me(c)));
});

// Sign out: retire this token on the server, so it stops working even if it was copied.
// The account, its texts and calls are untouched; signing in again issues a new token.
api.post("/signout", (c) => {
  store.update(me(c).id, (x) => {
    x.apiToken = token();
  });
  return c.body(null, 204);
});

// Permanently delete the account and everything Andi knows (App Store guideline 5.1.1(v)).
api.delete("/me", (c) => {
  const p = me(c);
  if (p.whyAudioPath) fs.rmSync(p.whyAudioPath, { force: true });
  chipHub.disconnect(p.id);
  store.remove(p.id);
  void clearSponsorStatus(p).finally(() => releasePersonLines(p)); // take the status down, then free the seats
  log.info("api", `deleted account ${p.id}`);
  return c.body(null, 204);
});

api.put("/consents", async (c) => {
  const consents = Consents.parse(await json(c));
  const p = store.update(me(c).id, (x) => {
    x.consents = consents;
    if (x.sponsor) x.sponsor.photon.statusText = undefined; // force a status refresh
  });
  await updateSponsorStatus(p);
  return c.json(summary(store.must(p.id)));
});

// When Andi holds back check-ins and milestone texts. Replies to the person are never delayed.
api.put("/quiet-hours", async (c) => {
  const quietHours = QuietHours.parse(await json(c));
  const p = store.update(me(c).id, (x) => {
    x.quietHours = quietHours;
  });
  return c.json(summary(p));
});

api.put("/sponsor", async (c) => {
  const s = z.object({ name: Name, phone: Handle }).parse(await json(c));
  const phone = normalizeHandle(s.phone);
  if (phone === me(c).phone) throw new ApiError(400, "invalid_request", "Your person needs to be someone else's number.");
  const previous = me(c).sponsor;
  const same = previous?.phone === phone;
  const p = store.update(me(c).id, (x) => {
    // Keep the iMessage link (and status message) when only the name changes.
    x.sponsor = same
      ? { ...x.sponsor!, name: s.name }
      : { name: s.name, phone, portalToken: token(), photon: {} }; // a new person never inherits the old portal link
  });
  if (!same) {
    if (previous) void clearSponsorStatus({ ...p, sponsor: previous }).finally(() => releaseSponsorLine(p.id, previous));
    await ensureSponsorLine(p.id);
  }
  return c.json(summary(store.must(p.id)));
});

api.delete("/sponsor", (c) => {
  const previous = me(c).sponsor;
  const p = store.update(me(c).id, (x) => {
    x.sponsor = undefined;
  });
  if (previous) void clearSponsorStatus({ ...p, sponsor: previous }).finally(() => releaseSponsorLine(p.id, previous));
  return c.json(summary(p));
});

const Place = z.object({
  name: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().min(50).max(2000).default(150),
  kind: z.enum(["bar", "liquor_store", "other"]).default("bar"),
  alternative: z.string().trim().max(200).optional().nullable(),
});

api.get("/places", (c) => c.json(me(c).places));

api.post("/places", async (c) => {
  const body = Place.parse(await json(c));
  if (me(c).places.length >= MAX_PLACES)
    throw new ApiError(409, "conflict", `You can mark up to ${MAX_PLACES} places. Remove one to add another.`);
  const place = { id: id("plc"), ...body, alternative: body.alternative || undefined };
  store.update(me(c).id, (x) => {
    x.places.push(place);
  });
  return c.json(place, 201);
});

api.delete("/places/:placeId", (c) => {
  const placeId = c.req.param("placeId");
  if (!me(c).places.some((pl) => pl.id === placeId)) throw new ApiError(404, "not_found", "That place is already gone.");
  store.update(me(c).id, (x) => {
    x.places = x.places.filter((pl) => pl.id !== placeId);
  });
  return c.body(null, 204);
});

// iOS Core Location region monitoring reports geofence enter/exit here. Only the event is sent,
// never coordinates.
api.post("/location", async (c) => {
  const body = z.object({ placeId: z.string().min(1), event: z.enum(["enter", "exit"]) }).parse(await json(c));
  const pid = me(c).id;
  const risk = body.event === "enter" ? await onPlaceEnter(pid, body.placeId) : await onPlaceExit(pid, body.placeId);
  return c.json({ risk });
});

// Optional: share location with Andi through Find My instead of (or as well as) iOS geofences.
api.post("/findmy/request", async (c) => {
  if (!findMyEnabled()) throw new ApiError(409, "conflict", "Find My isn't set up on this server yet.");
  if (!me(c).photon.spaceId) throw new ApiError(409, "conflict", "Text Andi first, then turn on Find My.");
  try {
    const receipt = await requestFindMy(me(c).phone);
    return c.json({ ok: true, receipt });
  } catch (err) {
    log.error("findmy", "request failed", err);
    throw new ApiError(503, "upstream_unavailable", "Couldn't send the Find My request. Try again in a minute.");
  }
});

api.post("/checkin", async (c) => {
  const body = z
    .object({
      hungry: z.boolean(),
      angry: z.boolean(),
      lonely: z.boolean(),
      tired: z.boolean(),
      mood: z.number().int().min(1).max(5).optional().nullable(),
      note: z.string().trim().max(500).optional().nullable(),
    })
    .parse(await json(c));
  const safety = await screenNote(me(c), body.note);
  const risk = await onCheckin(me(c).id, {
    hungry: body.hungry,
    angry: body.angry,
    lonely: body.lonely,
    tired: body.tired,
    mood: body.mood ?? undefined,
    note: body.note || undefined,
    source: "app",
  });
  return c.json({ risk, safety });
});

// Free-text notes from the app get the same safety routing as iMessages. A crisis note gets the
// crisis reply in the response (the app shows it with 988) and over iMessage, and is logged.
async function screenNote(p: Person, note: string | null | undefined) {
  if (!note) return null;
  const route = routeInbound(note, p.sponsor?.name);
  if (route.kind !== "crisis" && route.kind !== "withdrawal_emergency") return null;
  store.log(p.id, { kind: "crisis", detail: `${route.kind} (app note)` });
  await textPerson(p, route.reply);
  return { kind: route.kind, message: route.reply };
}

// The person's "why". Text, or a short voice memo (audio/* body, up to 5 MB).
api.post("/why", bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json(errorBody("too_large", "That recording is too long."), 413) }), async (c) => {
  const pid = me(c).id;
  const ct = c.req.header("content-type") ?? "";
  if (ct.startsWith("audio/")) {
    const dir = path.join(config.dataDir, "why");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${pid}.m4a`);
    fs.writeFileSync(file, Buffer.from(await c.req.arrayBuffer()));
    store.update(pid, (x) => {
      x.whyAudioPath = file;
    });
    return c.json({ ok: true, audio: true });
  }
  const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(await json(c));
  store.update(pid, (x) => {
    x.whyText = text;
  });
  return c.json({ ok: true });
});

api.get("/why/audio", (c) => {
  const p = me(c);
  if (!p.whyAudioPath || !fs.existsSync(p.whyAudioPath)) throw new ApiError(404, "not_found", "No recording yet.");
  return c.body(fs.readFileSync(p.whyAudioPath), 200, { "content-type": "audio/mp4" });
});

api.post("/call", async (c) => c.json(await callPerson(me(c).id, "app")));

api.post("/breathe", async (c) => {
  await startBreathing(me(c).id, "app");
  return c.json({ ok: true });
});

api.post("/slip", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const { note } = z.object({ note: z.string().trim().max(500).optional().nullable() }).parse(raw ?? {});
  const safety = await screenNote(me(c), note);
  const risk = await onSlip(me(c).id, note || undefined);
  return c.json({ risk, safety, message: safety?.message ?? "thank you for telling andi. one night doesn't erase your days." });
});

api.get("/risk", async (c) => c.json(await evaluate(me(c).id, "app_refresh")));

api.get("/wrapped", (c) => c.json(wrapped(me(c))));

api.get("/events", (c) => c.json(me(c).events.slice(-100).reverse()));

// The app asks for a chip token, then sends it to the chip over Bluetooth with Wi-Fi credentials.
// The new token is "pending" until a chip connects with it, so a failed pairing never knocks
// a working chip offline. The first connection with it promotes it and retires the old one.
api.post("/chip/pair", (c) => {
  if (!config.features.chip) throw new ApiError(404, "feature_off", "The chip is paused.");
  const p = store.update(me(c).id, (x) => {
    x.chipPendingToken = token();
  });
  const ws = config.publicUrl.replace(/^http/, "ws");
  return c.json({ chipToken: p.chipPendingToken, wsUrl: `${ws}/chip?token=${p.chipPendingToken}` });
});

api.delete("/chip", (c) => {
  if (!config.features.chip) throw new ApiError(404, "feature_off", "The chip is paused.");
  const p = store.update(me(c).id, (x) => {
    x.chipToken = undefined;
    x.chipPendingToken = undefined;
  });
  chipHub.disconnect(p.id);
  return c.json(summary(p));
});

