// Image cards Andi sends in iMessage (milestones, the 90-day recap) and Andi's avatar.
// Built as SVG and rendered to PNG with resvg, in the app's look: true black, a soft teal and
// ember glow, one huge thin number, small tracked caps, warm off-white text, lowercase voice.
//
// Cards only ever show the day count and gentle totals. Never slips, risk, places or purchases:
// an image can be forwarded or seen over a shoulder.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { log } from "../log.js";

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts");
const FONT_FILES = [path.join(FONT_DIR, "Inter-ExtraLight.ttf"), path.join(FONT_DIR, "Inter-Medium.ttf")];

const C = {
  bg: "#000000",
  teal: "#2E8F7A",
  ember: "#B8542A",
  mint: "#6FD6B4",
  text: "#F5F2EC",
  muted: "#8F8A84",
  faint: "#55514D",
};

const W = 1080;
const H = 1350;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function render(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  return Buffer.from(resvg.render().asPng());
}

// The background every card shares: black, a teal glow up top, an ember one lower right.
function glow(w: number, h: number) {
  return `
  <defs>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${Math.round(w * 0.11)}"/></filter>
    <filter id="halo" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="${C.bg}"/>
  <ellipse cx="${w * 0.34}" cy="${h * 0.17}" rx="${w * 0.5}" ry="${w * 0.36}" fill="${C.teal}" opacity="0.55" filter="url(#soft)"/>
  <ellipse cx="${w * 0.86}" cy="${h * 0.43}" rx="${w * 0.36}" ry="${w * 0.27}" fill="${C.ember}" opacity="0.30" filter="url(#soft)"/>`;
}

function wordmark(cx: number, y: number) {
  return `
  <circle cx="${cx - 52}" cy="${y - 14}" r="14" fill="none" stroke="${C.text}" stroke-width="6"/>
  <text x="${cx - 26}" y="${y}" font-family="Inter" font-weight="500" font-size="40" fill="${C.text}">andi</text>`;
}

const MILESTONE_LINES: Record<number, string> = {
  1: "the first morning. it counts.",
  3: "three mornings in a row.",
  7: "one whole week.",
  14: "two weeks of mornings.",
  30: "a month of mornings you remember.",
  60: "two months. look at you.",
  90: "ninety days. a whole season.",
  180: "half a year of mornings.",
  365: "one year. every single morning.",
};

export const milestoneLine = (day: number) => MILESTONE_LINES[day] ?? `${day} mornings you remember.`;

export function milestoneSvg(day: number) {
  const cx = W / 2;
  const cy = 620;
  const digits = String(day).length;
  const size = digits >= 3 ? 250 : 320;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${glow(W, H)}
  ${wordmark(cx, 150)}
  <circle cx="${cx}" cy="${cy}" r="330" fill="none" stroke="${C.mint}" stroke-width="10" opacity="0.55" filter="url(#halo)"/>
  <circle cx="${cx}" cy="${cy}" r="330" fill="none" stroke="${C.mint}" stroke-width="3"/>
  <text x="${cx}" y="${cy + size * 0.36}" text-anchor="middle" font-family="Inter" font-weight="200" font-size="${size}" fill="${C.text}">${day}</text>
  <text x="${cx}" y="${cy + 200}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="32" letter-spacing="10" fill="${C.muted}">${day === 1 ? "DAY" : "DAYS"}</text>
  <text x="${cx}" y="1110" text-anchor="middle" font-family="Inter" font-weight="500" font-size="48" fill="${C.text}">${esc(milestoneLine(day))}</text>
  <text x="${cx}" y="1180" text-anchor="middle" font-family="Inter" font-weight="500" font-size="32" fill="${C.muted}">i'm really proud of you.</text>
</svg>`;
}

export interface RecapStats {
  days: number;
  urgesRidden: number;
  checkins: number;
  callsToYourPerson: number;
}

export function recapSvg(s: RecapStats) {
  const cx = W / 2;
  const tiles: [string, number][] = [
    ["urges ridden out", s.urgesRidden],
    ["check-ins", s.checkins],
    ["calls to your person", s.callsToYourPerson],
  ];
  const tileSvg = tiles
    .map(([label, value], i) => {
      const y = 760 + i * 150;
      return `
  <rect x="90" y="${y}" width="${W - 180}" height="120" rx="34" fill="#FFFFFF" fill-opacity="0.06" stroke="#FFFFFF" stroke-opacity="0.09" stroke-width="2"/>
  <text x="140" y="${y + 74}" font-family="Inter" font-weight="500" font-size="36" fill="${C.text}">${esc(label)}</text>
  <text x="${W - 140}" y="${y + 78}" text-anchor="end" font-family="Inter" font-weight="200" font-size="64" fill="${C.text}">${value}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${glow(W, H)}
  ${wordmark(cx, 150)}
  <text x="${cx}" y="290" text-anchor="middle" font-family="Inter" font-weight="500" font-size="32" letter-spacing="10" fill="${C.muted}">YOUR FIRST</text>
  <text x="${cx}" y="560" text-anchor="middle" font-family="Inter" font-weight="200" font-size="280" fill="${C.text}">${s.days}</text>
  <text x="${cx}" y="650" text-anchor="middle" font-family="Inter" font-weight="500" font-size="32" letter-spacing="10" fill="${C.muted}">DAYS</text>
  ${tileSvg}
  <text x="${cx}" y="1260" text-anchor="middle" font-family="Inter" font-weight="500" font-size="36" fill="${C.text}">every one of these was you.</text>
</svg>`;
}

/** Andi's contact photo: the ring mark on black with a soft glow. Square. */
export function avatarSvg() {
  const s = 1024;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="110"/></filter>
    <filter id="halo" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect width="${s}" height="${s}" fill="${C.bg}"/>
  <ellipse cx="380" cy="360" rx="420" ry="320" fill="${C.teal}" opacity="0.6" filter="url(#soft)"/>
  <ellipse cx="760" cy="720" rx="300" ry="240" fill="${C.ember}" opacity="0.3" filter="url(#soft)"/>
  <circle cx="512" cy="512" r="230" fill="none" stroke="${C.mint}" stroke-width="40" opacity="0.6" filter="url(#halo)"/>
  <circle cx="512" cy="512" r="230" fill="none" stroke="${C.text}" stroke-width="56"/>
</svg>`;
}

// Milestone cards are identical for everyone on the same day, so render each once.
const cache = new Map<string, Buffer>();

function cached(key: string, build: () => Buffer): Buffer | null {
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const png = build();
    if (cache.size > 50) cache.clear();
    cache.set(key, png);
    return png;
  } catch (err) {
    log.error("cards", `rendering ${key} failed`, err);
    return null;
  }
}

/** PNG for a milestone day, or null if rendering failed (callers fall back to text only). */
export const milestoneCard = (day: number) => cached(`milestone:${day}`, () => render(milestoneSvg(day), W));

export const recapCard = (s: RecapStats) => {
  try {
    return render(recapSvg(s), W);
  } catch (err) {
    log.error("cards", "rendering the recap failed", err);
    return null;
  }
};

export const avatarPng = () => render(avatarSvg(), 1024);
