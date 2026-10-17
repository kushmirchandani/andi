import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { chipHub } from "./chip/hub.js";
import { config, configWarnings, enabled } from "./config.js";
import { startFindMyWatcher } from "./findmy/watcher.js";
import { log } from "./log.js";
import { startPhotonStream, stopPhotonStream } from "./photon/events.js";
import { callPerson } from "./services/calls.js";
import { handlePhotonEvent } from "./services/conversation.js";
import { startBreathing, tick } from "./services/engine.js";
import { flushStore, loadStore } from "./store.js";

loadStore();
for (const w of configWarnings()) log.warn("config", w);

// Chip events: tap = breathe, long press = call your person.
chipHub.onChipEvent((personId, e) => {
  if (e.type === "tap") void startBreathing(personId, "chip").catch((err) => log.error("chip", "breathe failed", err));
  if (e.type === "long_press") void callPerson(personId, "chip").catch((err) => log.error("chip", "call failed", err));
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const live = Object.entries({
    photon: enabled.photon(),
    chalk: enabled.chalk(),
    nessie: enabled.nessie(),
    claude: enabled.anthropic(),
    elevenlabs: enabled.elevenlabs(),
    findMy: enabled.findmy(),
  })
    .map(([k, v]) => `${k}=${v ? "live" : "off"}`)
    .join(" ");
  log.info("boot", `andi backend on :${info.port} (${config.isProd ? "production" : "development"}) ${live}`);
  if (enabled.demo() && !config.isProd) log.info("boot", `demo routes on, x-demo-key: ${config.demoKey}`);
});

server.on("upgrade", (req, socket, head) => chipHub.handleUpgrade(req, socket, head));

startPhotonStream(handlePhotonEvent);
startFindMyWatcher();

let ticking = false;
const ticker = setInterval(async () => {
  if (ticking) return; // a slow tick never overlaps the next one
  ticking = true;
  try {
    await tick();
  } catch (err) {
    log.error("tick", "failed", err);
  } finally {
    ticking = false;
  }
}, 10 * 60_000);

// Fly sends SIGINT/SIGTERM on deploy: stop taking work, flush the store, then exit.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("boot", `${signal}: shutting down`);
  clearInterval(ticker);
  stopPhotonStream();
  chipHub.closeAll();
  server.close();
  flushStore();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("process", "unhandled rejection", err));
process.on("uncaughtException", (err) => {
  log.error("process", "uncaught exception", err);
  flushStore();
});
