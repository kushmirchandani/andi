// "Andi learns you": per-person patterns from the person's own history.
//
// Two halves, like the risk score:
//   patternInputs(p)        history -> a few compact counts (TypeScript only; the history lives here)
//   summarizePatterns(in)   counts -> risky window, top trigger, what helped, confidence
// summarizePatterns is mirrored exactly in chalk/features.py (learn_patterns) and checked by
// `npm run parity`, so Chalk and the local fallback always agree.
//
// Privacy: the inputs are counts by hour and kind, never message text, places, merchants or
// amounts. Location and purchase signals are left out entirely when those consents are off.
// Slips and purchases count toward "was it a hard moment" and "did it help", but no output
// (and no text built from one) ever names them.

import { clock } from "../clock.js";
import { validTimezone } from "./signals.js";
import { config } from "../config.js";
import type { Person } from "../types.js";

// MARK: Pure summary (mirrored in chalk/features.py)

export const INTERVENTIONS = ["walk", "breathe", "call", "meeting", "talk", "workout", "music"] as const;
export type Intervention = (typeof INTERVENTIONS)[number];
export const TRIGGERS = ["hungry", "angry", "lonely", "tired", "places"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface PatternInputs {
  historyDays: number; // days of history we have (capped at the lookback)
  hardMoments: string; // "weekday:hour:days|..." distinct days with a hard moment in that local hour
  halt: string; // "hungry:n|angry:n|lonely:n|tired:n" from check-ins
  placeEnters: number; // risky-place entries (0 without location consent)
  interventions: string; // "kind:tried:helped|..."
}

export interface RiskyWindow {
  weekday: number | null; // 0 = Sunday; null = most days
  startHour: number;
  hours: number;
}

export interface PatternSummary {
  ready: boolean; // enough history to say anything
  riskyWindow: RiskyWindow | null;
  topTrigger: Trigger | null;
  whatHelped: Intervention | null;
  confidence: number; // 0-100
}

export const MIN_HISTORY_DAYS = 14;
export const MIN_HARD_MOMENTS = 6;
const WINDOW_HOURS = 3;

function parseTriples(s: string) {
  return s
    .split("|")
    .filter(Boolean)
    .map((part) => part.split(":"));
}

export function summarizePatterns(i: PatternInputs): PatternSummary {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const [w, h, n] of parseTriples(i.hardMoments)) {
    const wd = Number(w);
    const hr = Number(h);
    if (wd >= 0 && wd < 7 && hr >= 0 && hr < 24) grid[wd][hr] += Number(n);
  }
  let total = 0;
  for (const row of grid) for (const n of row) total += n;

  const ready = i.historyDays >= MIN_HISTORY_DAYS && total >= MIN_HARD_MOMENTS;
  if (!ready) return { ready: false, riskyWindow: null, topTrigger: null, whatHelped: null, confidence: 0 };

  // A window starting at hour h runs WINDOW_HOURS, spilling into the next day after midnight.
  const daySum = (w: number, h: number) => {
    let s = 0;
    for (let k = 0; k < WINDOW_HOURS; k++) {
      const hh = h + k;
      s += grid[(w + Math.floor(hh / 24)) % 7][hh % 24];
    }
    return s;
  };

  // Best window by total; on a tie, prefer one that starts on an hour with hard moments in it
  // (so a 9-11pm pattern reads "9pm", not an empty 8pm), then the earliest.
  let weekly = { w: 0, h: 0, s: -1, first: 0 };
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const s = daySum(w, h);
      const first = grid[w][h];
      if (s > weekly.s || (s === weekly.s && first > 0 && weekly.first === 0)) weekly = { w, h, s, first };
    }
  }
  let daily = { h: 0, s: -1, covered: 0, first: 0 };
  for (let h = 0; h < 24; h++) {
    let s = 0;
    let covered = 0;
    let first = 0;
    for (let w = 0; w < 7; w++) {
      const d = daySum(w, h);
      s += d;
      first += grid[w][h];
      if (d > 0) covered += 1;
    }
    if (s > daily.s || (s === daily.s && first > 0 && daily.first === 0)) daily = { h, s, covered, first };
  }

  let riskyWindow: RiskyWindow | null = null;
  let windowScore = 0;
  if (daily.covered >= 4 && daily.s * 2 >= weekly.s * 3) {
    riskyWindow = { weekday: null, startHour: daily.h, hours: WINDOW_HOURS };
    windowScore = daily.s;
  } else if (weekly.s >= 3) {
    riskyWindow = { weekday: weekly.w, startHour: weekly.h, hours: WINDOW_HOURS };
    windowScore = weekly.s;
  }

  // Top trigger: the most common, if it's at least 3 times and 30% of all trigger mentions.
  const counts = new Map<string, number>();
  for (const [k, n] of parseTriples(i.halt)) counts.set(k, (counts.get(k) ?? 0) + Number(n));
  counts.set("places", i.placeEnters);
  let triggerSum = 0;
  for (const t of TRIGGERS) triggerSum += counts.get(t) ?? 0;
  let topTrigger: Trigger | null = null;
  let topCount = 0;
  for (const t of TRIGGERS) {
    const n = counts.get(t) ?? 0;
    if (n > topCount) {
      topTrigger = t;
      topCount = n;
    }
  }
  if (topCount < 3 || topCount * 10 < triggerSum * 3) topTrigger = null;

  // What helped: tried at least twice, helped at least 60% of the time; best rate, then most wins.
  let whatHelped: Intervention | null = null;
  let best = { rate: -1, helped: -1 };
  const tried = new Map<string, [number, number]>();
  for (const [k, t, h] of parseTriples(i.interventions)) {
    const prev = tried.get(k) ?? [0, 0];
    tried.set(k, [prev[0] + Number(t), prev[1] + Number(h)]);
  }
  for (const k of INTERVENTIONS) {
    const [t, h] = tried.get(k) ?? [0, 0];
    if (t < 2 || h * 10 < t * 6) continue;
    const rate = h / t;
    if (rate > best.rate || (rate === best.rate && h > best.helped)) {
      whatHelped = k;
      best = { rate, helped: h };
    }
  }

  // 0-100: more history and a sharper window both raise it.
  const volume = Math.min(1, total / 20);
  const focus = riskyWindow ? Math.min(1, (windowScore / total) * 2) : 0;
  const confidence = Math.floor((volume * 0.5 + focus * 0.5) * 100);

  return { ready, riskyWindow, topTrigger, whatHelped, confidence };
}

// MARK: History -> inputs (TypeScript only)

export const LOOKBACK_DAYS = 56;
const HELP_WINDOW_MS = 24 * 3600_000; // an intervention "helped" if no slip within a day
const PURCHASE_WINDOW_MS = 12 * 3600_000; // ...and no alcohol-seller purchase within 12 hours
const TALK_AFTER_RISK_MS = 2 * 3600_000; // texting Andi within 2h of a risk rise counts as "talk"

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Local weekday (0 = Sunday), hour, minute and date (YYYY-MM-DD) in the person's zone. */
export function localParts(at: Date, timezone?: string) {
  const timeZone = validTimezone(timezone) ?? config.timezone;
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

const ms = (iso: string) => new Date(iso).getTime();

export function patternInputs(p: Person, now = clock.now()): PatternInputs {
  const since = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  const recent = <T extends { at: string }>(xs: T[]) => xs.filter((x) => ms(x.at) >= since && ms(x.at) <= now.getTime());
  const events = recent(p.events);
  const checkins = recent(p.checkins);
  const slips = recent(p.slips);
  const purchases = p.consents.purchases ? recent(p.purchases) : [];

  // Hard moments: distinct (day, local hour) pairs with any sign it was a hard time.
  const hard: string[] = [];
  for (const e of events) {
    if (e.kind === "risk_change" && (e.level === "elevated" || e.level === "high")) hard.push(e.at);
    if (e.kind === "breathe" || e.kind === "call") hard.push(e.at);
    if (e.kind === "place_enter" && p.consents.location) hard.push(e.at);
  }
  for (const c of checkins) {
    const halt = [c.hungry, c.angry, c.lonely, c.tired].filter(Boolean).length;
    if (halt >= 2 || (c.mood !== undefined && c.mood <= 2)) hard.push(c.at);
  }
  for (const s of slips) hard.push(s.at);
  for (const b of purchases) hard.push(b.at);

  const seen = new Set<string>();
  const buckets = new Map<string, number>();
  for (const at of hard) {
    const l = localParts(new Date(at), p.timezone);
    const key = `${l.date}|${l.weekday}|${l.hour}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = `${l.weekday}:${l.hour}`;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const hardMoments = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join("|");

  const halt = { hungry: 0, angry: 0, lonely: 0, tired: 0 };
  for (const c of checkins) {
    if (c.hungry) halt.hungry += 1;
    if (c.angry) halt.angry += 1;
    if (c.lonely) halt.lonely += 1;
    if (c.tired) halt.tired += 1;
  }

  // Interventions, judged only once we know how the next day went.
  const occurrences: { kind: Intervention; at: number }[] = [];
  const riskRises = events.filter((e) => e.kind === "risk_change" && (e.level === "elevated" || e.level === "high")).map((e) => ms(e.at));
  const inbound = events.filter((e) => e.kind === "inbound").map((e) => ms(e.at));
  for (const e of events) {
    if (e.kind === "breathe") occurrences.push({ kind: "breathe", at: ms(e.at) });
    if (e.kind === "call") occurrences.push({ kind: "call", at: ms(e.at) });
    if (e.kind === "coping" && (INTERVENTIONS as readonly string[]).includes(e.detail ?? "")) {
      occurrences.push({ kind: e.detail as Intervention, at: ms(e.at) });
    }
  }
  for (const r of riskRises) {
    const replied = inbound.find((t) => t >= r && t - r <= TALK_AFTER_RISK_MS);
    if (replied !== undefined) occurrences.push({ kind: "talk", at: replied });
  }
  const slipTimes = slips.map((s) => ms(s.at));
  const buyTimes = purchases.map((b) => ms(b.at));
  const tally = new Map<string, [number, number]>();
  for (const o of occurrences) {
    if (now.getTime() - o.at < HELP_WINDOW_MS) continue; // too soon to know
    const slipped = slipTimes.some((t) => t >= o.at && t - o.at <= HELP_WINDOW_MS);
    const bought = buyTimes.some((t) => t >= o.at && t - o.at <= PURCHASE_WINDOW_MS);
    const prev = tally.get(o.kind) ?? [0, 0];
    tally.set(o.kind, [prev[0] + 1, prev[1] + (slipped || bought ? 0 : 1)]);
  }
  const interventions = INTERVENTIONS.filter((k) => tally.has(k))
    .map((k) => `${k}:${tally.get(k)![0]}:${tally.get(k)![1]}`)
    .join("|");

  const firstAt = Math.min(ms(p.createdAt), ...p.events.map((e) => ms(e.at)), ...p.checkins.map((c) => ms(c.at)));
  const historyDays = Math.max(0, Math.min(LOOKBACK_DAYS, Math.floor((now.getTime() - firstAt) / 86_400_000)));

  return {
    historyDays,
    hardMoments,
    halt: `hungry:${halt.hungry}|angry:${halt.angry}|lonely:${halt.lonely}|tired:${halt.tired}`,
    placeEnters: p.consents.location ? events.filter((e) => e.kind === "place_enter").length : 0,
    interventions,
  };
}

// MARK: Coping mentions in their texts (logged as a kind only, never the words)

const COPING: [Intervention, RegExp][] = [
  ["walk", /\b(walk|walked|walking|a stroll)\b/i],
  ["meeting", /\b(meeting|aa|na|my group)\b/i],
  ["workout", /\b(gym|work ?out|worked out|went (for a )?run|ran|running|yoga|swim|swam)\b/i],
  ["music", /\b(music|playlist|song|songs)\b/i],
];

/** Which coping activities a message mentions (for the "what helped" tally). */
export function copingMentions(text: string): Intervention[] {
  return COPING.filter(([, re]) => re.test(text)).map(([k]) => k);
}

// MARK: Words

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function hourLabel(h: number) {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "midnight";
  if (hh === 12) return "noon";
  return hh < 12 ? `${hh}am` : `${hh - 12}pm`;
}

export function partOfDay(h: number) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 20) return "evening";
  return "night";
}

/** "friday 8pm–11pm" or "most days 9pm–midnight". */
export function windowLabel(w: RiskyWindow) {
  const span = `${hourLabel(w.startHour)}–${hourLabel(w.startHour + w.hours)}`;
  return w.weekday === null ? `most days ${span}` : `${DAYS[w.weekday]} ${span}`;
}

export const INTERVENTION_LABEL: Record<Intervention, string> = {
  walk: "a walk",
  breathe: "a breathing round",
  call: "calling your person",
  meeting: "a meeting",
  talk: "texting me through it",
  workout: "moving your body",
  music: "music",
};

/** The pre-window text. Only ever built from the window, what helped and their person's name. */
export function nudgeText(s: PatternSummary, sponsorName?: string) {
  const w = s.riskyWindow!;
  const part = partOfDay(w.startHour);
  const opener = w.weekday === null ? `${part}'s coming up` : `it's almost ${DAYS[w.weekday]} ${part}`;
  const person = sponsorName?.toLowerCase();
  switch (s.whatHelped) {
    case "walk":
      return `${opener}. last time it got hard, the walk helped. want to plan one?`;
    case "breathe":
      return `${opener}. breathing it through has helped you before. want to do a round together when it starts?`;
    case "call":
      return person
        ? `${opener}. talking to ${person} has helped you before. want to line up a call?`
        : `${opener}. calling someone has helped you before. want to line someone up?`;
    case "meeting":
      return `${opener}. a meeting has helped you before. is there one you could get to?`;
    case "talk":
      return `${opener}. texting me through it has helped before. i'm right here. want to check in when it starts?`;
    case "workout":
      return `${opener}. moving your body has helped you before. want to plan something?`;
    case "music":
      return `${opener}. music has helped you before. want to queue something up?`;
    default:
      return `${opener}. that's been a harder stretch for you. want to make a small plan for it? i'm around.`;
  }
}

/** A short line for the brain's context. Never names places, purchases or slips. */
export function patternMemory(s: PatternSummary | undefined) {
  if (!s?.ready) return undefined;
  const bits: string[] = [];
  if (s.riskyWindow) bits.push(`harder stretch is usually ${windowLabel(s.riskyWindow)}`);
  if (s.whatHelped) bits.push(`what has helped before: ${INTERVENTION_LABEL[s.whatHelped].replace("your person", "their person").replace("texting me", "texting you")}`);
  if (s.topTrigger && s.topTrigger !== "places") bits.push(`often feeling ${s.topTrigger} when it's hard`);
  return bits.length ? bits.join("; ") : undefined;
}

/** The /api/me view: the summary plus words the app can show as-is. */
export function patternsView(s: PatternSummary | undefined) {
  if (!s?.ready) return { ready: false, riskyWindow: null, whatHelped: null, topTrigger: null, confidence: 0 };
  return {
    ready: true,
    riskyWindow: s.riskyWindow ? { ...s.riskyWindow, label: windowLabel(s.riskyWindow) } : null,
    whatHelped: s.whatHelped ? { kind: s.whatHelped, label: INTERVENTION_LABEL[s.whatHelped] } : null,
    topTrigger: s.topTrigger ? { kind: s.topTrigger, label: s.topTrigger === "places" ? "places you marked" : s.topTrigger } : null,
    confidence: s.confidence,
  };
}
