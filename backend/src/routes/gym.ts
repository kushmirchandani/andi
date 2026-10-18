// Andi Gym scoreboard: how Andi has coached itself, night by night (gym/night.ts writes the data).
//   GET /gym                the page (x-demo-key header, or ?key= for a browser)
//   GET /gym/history.json   the raw history
// Same protection as the demo routes: off in production unless DEMO_KEY is set.

import { Hono } from "hono";
import { PLAYBOOK } from "../agent/playbook.js";
import { config } from "../config.js";
import { errorBody } from "../http.js";
import { safeEqual } from "../store.js";
import { readHistory, type NightEntry } from "../../gym/lib.js";

export const gym = new Hono();

gym.use("/*", async (c, next) => {
  const key = c.req.header("x-demo-key") ?? c.req.query("key") ?? "";
  if (!config.demoKey || !safeEqual(key, config.demoKey)) return c.json(errorBody("unauthorized", "Bad or missing demo key."), 401);
  await next();
});

gym.get("/history.json", (c) => c.json({ live: PLAYBOOK.version, nights: readHistory() }));

gym.get("/", (c) => {
  c.header("cache-control", "no-store");
  return c.html(page(readHistory(), PLAYBOOK.version));
});

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Helpfulness by night: the live playbook (line) and each night's candidate (dot; filled if promoted). */
function chart(nights: NightEntry[]) {
  const W = 720;
  const H = 260;
  const pad = { l: 44, r: 20, t: 20, b: 36 };
  const pts = nights.filter((n) => n.decision !== "no-candidate" || n.scores.baseline.conversations);
  if (!pts.length) return "";
  const values = pts.flatMap((n) => [n.scores.baseline.helpfulness, n.scores.candidate.conversations ? n.scores.candidate.helpfulness : n.scores.baseline.helpfulness]);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 8) / 10) * 10);
  const hi = Math.min(100, Math.ceil((Math.max(...values) + 8) / 10) * 10);
  const n = pts.length;
  const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / Math.max(1, hi - lo);
  const grid = [lo, (lo + hi) / 2, hi]
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 10}" y="${y(v) + 4}" class="axis" text-anchor="end">${Math.round(v)}</text>`)
    .join("");
  const live = pts.map((p, i) => `${x(i)},${y(p.scores.baseline.helpfulness)}`).join(" ");
  const dots = pts
    .map((p, i) => {
      const b = `<circle cx="${x(i)}" cy="${y(p.scores.baseline.helpfulness)}" r="4.5" class="live"><title>${esc(p.baselineVersion)} live: ${p.scores.baseline.helpfulness}</title></circle>`;
      if (!p.scores.candidate.conversations) return b;
      const cy = y(p.scores.candidate.helpfulness);
      const cls = p.decision === "promoted" ? "cand promoted" : "cand";
      return `${b}<line x1="${x(i)}" x2="${x(i) + 14}" y1="${y(p.scores.baseline.helpfulness)}" y2="${cy}" class="tie"/><circle cx="${x(i) + 14}" cy="${cy}" r="5.5" class="${cls}"><title>${esc(p.candidateVersion)} candidate: ${p.scores.candidate.helpfulness} (${p.decision})</title></circle>`;
    })
    .join("");
  const labels = pts.map((p, i) => `<text x="${x(i)}" y="${H - 12}" class="axis" text-anchor="middle">${esc(p.at.slice(5, 10))}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Helpfulness by night">${grid}<polyline points="${live}" class="line"/>${dots}${labels}</svg>`;
}

function night(n: NightEntry) {
  const b = n.scores.baseline;
  const c = n.scores.candidate;
  const pill = n.decision === "promoted" ? `<span class="pill on">promoted</span>` : n.decision === "rejected" ? `<span class="pill">rejected</span>` : `<span class="pill">no candidate</span>`;
  const dims = Object.keys({ ...b.dimensions, ...c.dimensions });
  const dimRows = dims
    .map((k) => {
      const bv = b.dimensions[k];
      const cv = c.dimensions[k];
      const up = bv !== undefined && cv !== undefined && cv > bv;
      return `<tr><td>${esc(k.replaceAll("_", " "))}</td><td>${bv ?? "–"}</td><td class="${up ? "up" : ""}">${cv ?? "–"}</td></tr>`;
    })
    .join("");
  const samples = n.samples
    .map(
      (s) => `<div class="sample"><div class="label">${esc(s.scenario)}</div><p class="them">${esc(s.person)}</p>
      <div class="pair"><div><div class="label">${esc(n.baselineVersion)}</div><p>${esc(s.before)}</p></div><div><div class="label accent">${esc(n.candidateVersion)}</div><p>${esc(s.after)}</p></div></div></div>`,
    )
    .join("");
  return `<article class="card">
  <header><div><div class="label">${esc(new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${esc(n.mode)} · coach: ${esc(n.coach)}</div>
  <h3>${esc(n.baselineVersion)} → ${esc(n.candidateVersion)}</h3></div>${pill}</header>
  <div class="stats">
    <div><div class="big">${c.conversations ? `${n.delta >= 0 ? "+" : ""}${n.delta}` : "–"}</div><div class="label">helpfulness</div></div>
    <div><div class="big">${c.conversations ? c.safety : b.safety}%</div><div class="label">safety held</div></div>
    <div><div class="big">${n.scenarios.practice}+${n.scenarios.exam}</div><div class="label">practice + exam</div></div>
  </div>
  <p>${esc(n.change.summary)}</p>
  ${n.change.changes.length ? `<ul>${n.change.changes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${n.reasons.length ? `<p class="muted">${esc(n.reasons.join("; "))}</p>` : ""}
  ${dims.length ? `<table><thead><tr><th></th><th>${esc(n.baselineVersion)}</th><th>${esc(n.candidateVersion)}</th></tr></thead><tbody>${dimRows}</tbody></table>` : ""}
  ${samples ? `<div class="label section">same message, before and after</div>${samples}` : ""}
</article>`;
}

function page(nights: NightEntry[], live: string) {
  const latest = nights.at(-1);
  const promoted = nights.filter((n) => n.decision === "promoted").length;
  const best = latest ? (latest.decision === "promoted" ? latest.scores.candidate : latest.scores.baseline) : null;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Andi Gym</title>
<style>
:root{--bg:#000;--text:#F5F2EC;--muted:#8F8A84;--faint:#55514D;--card:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);--cream:#F2EDE4;--mint:#9FE3CB;--teal:#2E8F7A;--ember:#B8542A}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Helvetica Neue",sans-serif}
body{background:radial-gradient(60vw 40vw at 25% -5%,rgba(46,143,122,.45),transparent 70%),radial-gradient(40vw 30vw at 95% 10%,rgba(184,84,42,.22),transparent 70%),#000;background-attachment:fixed;min-height:100vh}
main{max-width:860px;margin:0 auto;padding:40px 20px 80px}
.mark{display:flex;align-items:center;gap:8px;font-weight:600;font-size:18px}.mark i{width:15px;height:15px;border:3px solid var(--text);border-radius:50%;display:inline-block}
h1{font-weight:200;font-size:clamp(40px,8vw,72px);line-height:1.05;margin:40px 0 12px;letter-spacing:-.02em}
h3{margin:4px 0 0;font-weight:600;font-size:20px}
p{margin:12px 0}.muted{color:var(--muted)}
.label{font-size:12px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.label.accent{color:var(--mint)}.label.section{margin:22px 0 6px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:32px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:20px;margin:12px 0}
.big{font-weight:200;font-size:44px;line-height:1.1;font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0 8px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.pill{border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--muted);white-space:nowrap}.pill.on{background:var(--cream);color:#0B0A09;border-color:transparent;font-weight:600}
ul{margin:8px 0;padding-left:20px}li{margin:4px 0}
table{width:100%;border-collapse:collapse;margin:12px 0;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 4px;border-bottom:1px solid var(--line);font-size:14px}th{color:var(--muted);font-weight:500}td.up{color:var(--mint)}
.sample{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.them{color:var(--muted);font-style:italic}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pair p{margin:6px 0 0;font-size:15px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.axis{fill:var(--faint);font-size:11px}
.line{fill:none;stroke:var(--text);stroke-width:1.5;opacity:.7}.live{fill:#000;stroke:var(--text);stroke-width:1.5}
.cand{fill:#000;stroke:var(--mint);stroke-width:2}.cand.promoted{fill:var(--mint)}.tie{stroke:var(--mint);stroke-dasharray:3 3;opacity:.6}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-top:8px}.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle;border:1.5px solid var(--text)}
.legend .c::before{border-color:var(--mint)}.legend .p::before{border-color:var(--mint);background:var(--mint)}
.empty{text-align:center;padding:48px 20px}
@media (max-width:560px){.pair{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr 1fr}.big{font-size:32px}}
</style></head>
<body><main>
<div class="mark"><i></i>andi gym</div>
<h1>andi coaches itself<br>every night.</h1>
<p class="muted">practice on fresh hard moments, get coached on the weakest replies, then sit the same held-out exam as the live version. a change ships only if it helps more and every safety check still holds. a person approves every change.</p>
<div class="kpis">
  <div class="card"><div class="big">${esc(live)}</div><div class="label">live playbook</div></div>
  <div class="card"><div class="big">${best ? best.helpfulness : "–"}</div><div class="label">helpfulness /100</div></div>
  <div class="card"><div class="big">${best ? `${best.safety}%` : "–"}</div><div class="label">safety held</div></div>
  <div class="card"><div class="big">${nights.length}</div><div class="label">nights · ${promoted} promoted</div></div>
</div>
${
  nights.length
    ? `<div class="card"><div class="label">helpfulness by night</div>${chart(nights)}<div class="legend"><span>live playbook</span><span class="c">candidate</span><span class="p">candidate, promoted</span></div></div>
<div class="label section">nights</div>
${[...nights].reverse().map(night).join("\n")}`
    : `<div class="card empty"><div class="big">0</div><p class="muted">no nights yet. run <code>npm run gym</code> (or <code>npm run gym:smoke</code>) and refresh.</p></div>`
}
</main></body></html>`;
}
