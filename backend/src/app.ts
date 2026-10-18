// The HTTP app, separate from index.ts (which starts listeners and background work) so tests
// can drive it in-process with app.request().

import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { chalkStatus } from "./chalk/client.js";
import { chipHub } from "./chip/hub.js";
import { config, enabled } from "./config.js";
import { ApiError, errorBody } from "./http.js";
import { log } from "./log.js";
import { photonStream, photonStreamHealthy } from "./photon/events.js";
import { agentTest } from "./routes/agentTest.js";
import { api } from "./routes/api.js";
import { demo } from "./routes/demo.js";
import { elevenlabsRoutes } from "./routes/elevenlabs.js";
import { gym } from "./routes/gym.js";
import { nessieRoutes } from "./routes/nessie.js";
import { sponsorRoutes } from "./routes/sponsor.js";
import { store } from "./store.js";

const startedAt = new Date();

export const app = new Hono();

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));

// Access log without query strings (chip and portal URLs carry tokens).
app.use("*", async (c, next) => {
  const t0 = performance.now();
  await next();
  if (c.req.path === "/health") return;
  const path = c.req.path.replace(/^\/s\/[^/]+/, "/s/:token");
  log.info("http", `${c.req.method} ${path} ${c.res.status} ${Math.round(performance.now() - t0)}ms`);
});

app.onError((err, c) => {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const message = first?.message && !first.message.startsWith("Invalid") ? first.message : "Some of that didn't look right.";
    return c.json(errorBody("invalid_request", message, { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }), 400);
  }
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
  if (err instanceof HTTPException) return c.json(errorBody("http_error", err.message), err.status);
  log.error("http", `${c.req.method} ${c.req.path} failed`, err);
  return c.json(errorBody("server_error", "Something went wrong on our side. Try again in a moment."), 500);
});

app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));

app.get("/", (c) => c.text("andi is running. see /health"));

// 503 when the iMessage stream has been down over 5 minutes, so Fly's health check restarts us.
app.get("/health", (c) =>
  c.json({
    ok: photonStreamHealthy(),
    version: config.version,
    uptimeS: Math.round((Date.now() - startedAt.getTime()) / 1000),
    people: store.all().length,
    features: config.features,
    chipsOnline: config.features.chip ? chipHub.count() : 0,
    sponsors: {
      photon: enabled.photon() ? photonStream.state : "dry-run",
      nessie: enabled.nessie() ? (store.nessieWebhook ? "webhook" : "api") : false,
      chalk: enabled.chalk() ? (Date.now() < chalkStatus.openUntil ? "degraded (local fallback)" : "live") : "local",
      anthropic: enabled.anthropic(),
      elevenlabs: enabled.elevenlabs(),
      findMy: enabled.findmy(),
    },
    photon: { cursor: store.photonCursor, lastEventAt: photonStream.lastEventAt },
  }, photonStreamHealthy() ? 200 : 503),
);

app.route("/api", api);
if (enabled.demo()) app.route("/demo", demo);
if (enabled.demo()) app.route("/gym", gym);
app.route("/", sponsorRoutes);
if (enabled.agentTest()) app.route("/", agentTest);
app.route("/elevenlabs", elevenlabsRoutes);
app.route("/nessie", nessieRoutes);
