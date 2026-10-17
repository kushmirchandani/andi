// Small JSON-file store. One process, a modest number of people: right for a hackathon and
// a pilot. On Fly, DATA_DIR points at a mounted volume so state survives deploys.
//
// Durability: writes are debounced (200 ms), written to a temp file, fsynced, then renamed over
// the old file, so a crash never leaves a half-written store. flushStore() is called on shutdown.
// On load, a corrupt file is moved aside (andi.json.corrupt-<ts>) instead of crashing the server.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { clock } from "./clock.js";
import { log as logger } from "./log.js";
import type { AndiEvent, Person, StoreData } from "./types.js";

const file = () => path.join(config.dataDir, "andi.json");
let data: StoreData = { version: 2, people: {}, photonCursor: 0 };
let writeTimer: NodeJS.Timeout | null = null;

const MAX_EVENTS = 500;

// Fill fields added after a record was first written, so old stores keep working.
function migrate(p: Person): Person {
  p.places ??= [];
  p.checkins ??= [];
  p.slips ??= [];
  p.events ??= [];
  p.purchases ??= [];
  p.chat ??= [];
  p.photon ??= {};
  p.consents ??= { location: true, purchases: true, shareWithSponsor: "status", sponsorAlerts: true };
  if (p.sponsor) p.sponsor.photon ??= {};
  // v1 kept alcohol purchases only in the event log ("Merchant $34").
  if (p.purchases.length === 0) {
    for (const e of p.events) {
      const m = e.kind === "purchase" ? e.detail?.match(/^(.*) \$(\d+(?:\.\d+)?)$/) : null;
      if (m) p.purchases.push({ at: e.at, merchant: m[1], amount: Number(m[2]) });
    }
  }
  return p;
}

export function loadStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const f = file();
  if (!fs.existsSync(f)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<StoreData>;
    data = { version: 2, people: raw.people ?? {}, photonCursor: raw.photonCursor ?? 0, unknownReplies: raw.unknownReplies ?? {} };
    for (const p of Object.values(data.people)) migrate(p);
    logger.info("store", `loaded ${Object.keys(data.people).length} people, photon cursor ${data.photonCursor}`);
  } catch (err) {
    const aside = `${f}.corrupt-${Date.now()}`;
    fs.renameSync(f, aside);
    // Keep only the two newest corrupt copies (they hold personal data).
    const dir = path.dirname(f);
    const copies = fs.readdirSync(dir).filter((n) => n.startsWith("andi.json.corrupt-")).sort();
    for (const old of copies.slice(0, -2)) fs.rmSync(path.join(dir, old), { force: true });
    logger.error("store", `could not parse ${f}; moved it to ${aside} and started empty`, err);
  }
}

function writeNow() {
  const f = file();
  const tmp = `${f}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      writeNow();
    } catch (err) {
      logger.error("store", "write failed", err);
    }
  }, 200);
}

// Called on SIGTERM/SIGINT so a deploy never drops the last 200 ms of writes.
export function flushStore() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeNow();
  } catch (err) {
    logger.error("store", "flush failed", err);
  }
}

export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
export const token = () => crypto.randomBytes(24).toString("base64url");
export const nowIso = () => clock.now().toISOString();

// Constant-time string compare for keys and tokens.
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const people = () => Object.values(data.people);
const isLinked = (p: Person) => Boolean(p.photon.spaceId);

export const store = {
  all: people,
  get: (personId: string): Person | undefined => data.people[personId],
  // Like get(), but for code paths where the person must exist.
  must(personId: string): Person {
    const p = data.people[personId];
    if (!p) throw new Error(`Unknown person ${personId}`);
    return p;
  },
  byToken: (t: string) => (t ? people().find((p) => safeEqual(p.apiToken, t)) : undefined),
  byChipToken: (t: string) => (t ? people().find((p) => p.chipToken !== undefined && safeEqual(p.chipToken, t)) : undefined),
  byPendingChipToken: (t: string) =>
    t ? people().find((p) => p.chipPendingToken !== undefined && safeEqual(p.chipPendingToken, t)) : undefined,
  byPortalToken: (t: string) => (t ? people().find((p) => p.sponsor && safeEqual(p.sponsor.portalToken, t)) : undefined),
  // A linked account (verified by an inbound iMessage) always wins over a pending one with the same number.
  byPhone: (handle: string) => {
    const matches = people().filter((p) => samePhone(p.phone, handle));
    return matches.find(isLinked) ?? matches.at(-1);
  },
  linkedByPhone: (handle: string) => people().find((p) => isLinked(p) && samePhone(p.phone, handle)),
  // Link codes are valid for 48 hours after onboarding.
  byLinkCode: (code: string) =>
    people().find(
      (p) => !isLinked(p) && p.linkCode === code && clock.now().getTime() - new Date(p.createdAt).getTime() < 48 * 3600_000,
    ),
  bySponsorPhone: (handle: string) => people().find((p) => p.sponsor && samePhone(p.sponsor.phone, handle)),
  // Everyone who picked this handle as their person (one person can sponsor several).
  allBySponsorPhone: (handle: string) => people().filter((p) => p.sponsor && samePhone(p.sponsor.phone, handle)),
  linkCodeInUse: (code: string) => people().some((p) => !isLinked(p) && p.linkCode === code),

  put(person: Person) {
    data.people[person.id] = migrate(person);
    persist();
    return person;
  },
  update(personId: string, fn: (p: Person) => void) {
    const p = store.must(personId);
    fn(p);
    persist();
    return p;
  },
  log(personId: string, event: Omit<AndiEvent, "at">) {
    if (!data.people[personId]) return;
    store.update(personId, (p) => {
      p.events.push({ at: nowIso(), ...event });
      if (p.events.length > MAX_EVENTS) p.events.splice(0, p.events.length - MAX_EVENTS);
    });
  },
  remove(personId: string) {
    delete data.people[personId];
    persist();
  },

  get photonCursor() {
    return data.photonCursor;
  },
  set photonCursor(seq: number) {
    data.photonCursor = seq;
    persist();
  },

  // When we last auto-replied to an unknown handle, so strangers get one reply a day, not one per message.
  unknownRepliedAt(handle: string) {
    return data.unknownReplies?.[normalizeHandle(handle)];
  },
  markUnknownReplied(handle: string) {
    data.unknownReplies ??= {};
    data.unknownReplies[normalizeHandle(handle)] = nowIso();
    // Keep strangers' handles only as long as the once-a-day rule needs them.
    const cutoff = clock.now().getTime() - 2 * 86_400_000;
    for (const [h, at] of Object.entries(data.unknownReplies)) if (new Date(at).getTime() < cutoff) delete data.unknownReplies[h];
    persist();
  },
};

// iMessage handles can be phone numbers or Apple-account emails.
export function normalizeHandle(h: string) {
  const trimmed = h.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`; // US number without country code
  return `+${digits}`;
}

// A plausible phone number or email handle (used to validate input).
export function isValidHandle(h: string) {
  const n = normalizeHandle(h);
  if (n.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n);
  return /^\+\d{10,15}$/.test(n);
}

function samePhone(a: string, b: string) {
  return normalizeHandle(a) === normalizeHandle(b);
}

// Days since the sober date, counted in the app's time zone so the number flips at local midnight.
export function daysSober(p: Pick<Person, "soberSince" | "timezone">, at = clock.now()) {
  const today = localDate(at, p.timezone);
  const start = Date.UTC(...ymd(p.soberSince.slice(0, 10)));
  const now = Date.UTC(...ymd(today));
  return Math.max(0, Math.round((now - start) / 86_400_000));
}

// YYYY-MM-DD for `at` in the app's time zone.
export function localDate(at = clock.now(), timezone?: string) {
  let timeZone = config.timezone;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      timeZone = timezone;
    } catch {
      /* unknown zone: use the app's */
    }
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function ymd(s: string): [number, number, number] {
  const [y, m, d] = s.split("-").map(Number);
  return [y, (m || 1) - 1, d || 1];
}

// Serialize async work per person so concurrent signals (a geofence and a purchase arriving
// together) can't double-send a sponsor alert or interleave risk updates.
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(personId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(personId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  locks.set(personId, settled);
  void settled.then(() => {
    if (locks.get(personId) === settled) locks.delete(personId);
  });
  return next;
}
