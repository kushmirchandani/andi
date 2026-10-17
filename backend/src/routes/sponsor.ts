// The sponsor's portal: consent-scoped status only. Linked from the status message in their thread.

import { Hono } from "hono";
import { store } from "../store.js";
import { sponsorView } from "../services/sponsor.js";

export const sponsorRoutes = new Hono();

// Private links: never cached, indexed, or leaked through Referer.
sponsorRoutes.use("/s/*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex, nofollow");
});

sponsorRoutes.get("/s/:token/status.json", (c) => {
  const p = store.byPortalToken(c.req.param("token"));
  if (!p) return c.json({ error: "not_found", message: "This link is no longer active." }, 404);
  return c.json(sponsorView(p));
});

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

sponsorRoutes.get("/s/:token", (c) => {
  const p = store.byPortalToken(c.req.param("token"));
  if (!p) return c.text("This link is no longer active.", 404);
  const v = sponsorView(p);
  const tone = v.level === "high" ? "#d85a30" : v.level === "elevated" ? "#ef9f27" : "#1d9e75";
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.name)} · Andi</title>
<meta http-equiv="refresh" content="30"><meta name="robots" content="noindex">
<style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0d0b0a;color:#f4efe8;display:grid;place-items:center;min-height:100vh}
.card{width:min(360px,90vw);text-align:center;padding:40px 24px}
.orb{width:140px;height:140px;border-radius:50%;margin:0 auto 28px;background:radial-gradient(circle,${tone} 0%,transparent 70%);opacity:.9}
.day{font-size:56px;font-weight:600;letter-spacing:-1px;margin:0}
.label{color:#a59d93;margin:4px 0 28px}
.status{font-size:20px;margin:0}
.reason{color:#a59d93;margin-top:8px}
.call{display:inline-block;margin-top:28px;padding:14px 28px;border-radius:999px;background:#f4efe8;color:#0d0b0a;text-decoration:none;font-weight:600}
.foot{color:#6f6860;font-size:13px;margin-top:40px;line-height:1.5}
</style></head><body><div class="card">
<div class="orb"></div>
<p class="day">${v.day}</p><p class="label">days for ${esc(v.name)}</p>
${v.status ? `<p class="status">${esc(v.status)}</p>` : `<p class="status">${esc(v.name)} isn't sharing status right now.</p>`}
${v.reason ? `<p class="reason">${esc(v.reason)}</p>` : ""}
${p.phone.startsWith("+") ? `<a class="call" href="tel:${esc(p.phone)}">Call ${esc(v.name)}</a>` : ""}
<p class="foot">${esc(v.name)} chooses what you see here. You'll never see their private messages.<br>If they ever say they want to hurt themselves, call or text 988.</p>
</div></body></html>`);
});
