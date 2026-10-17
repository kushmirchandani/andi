// Inbound events over Photon's Socket.IO stream, following the official Node example
// (https://photon.codes/docs/beta/websocket/example): subscribe with a saved cursor,
// process deliveries serially, persist the cursor only after a handler succeeds.
//
// Poison events: if the same event fails 3 times (across reconnects) we log it, skip it and
// advance the cursor, so one bad message can't wedge the whole stream in a reconnect loop.

import { io, type Socket } from "socket.io-client";
import { config, enabled } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";

export interface PhotonUser {
  id: string;
  handle: string;
  kind: string; // "human" | "agent"
}

export interface PhotonMessage {
  id: string;
  platform: string;
  status: string;
  parentMessageId?: string;
  space: { id: string; kind: string };
  sentBy: PhotonUser;
  receivedBy?: PhotonUser;
  content: { type: string; text?: string; reaction?: string; action?: string; selectedOptions?: { id: string; text: string }[] };
  createdAt: string;
}

export interface PhotonEvent {
  id: string;
  type: string; // e.g. "message.received"
  data: { object: PhotonMessage };
}

export const photonStream = {
  state: "disabled" as "disabled" | "connecting" | "subscribed" | "disconnected",
  // When the stream was last subscribed (or started). /health turns unhealthy if this gets old,
  // so Fly restarts a machine whose stream is wedged instead of silently ignoring everyone.
  lastSubscribedAt: Date.now(),
  lastEventAt: null as string | null,
  connectionId: null as string | null,
  socket: null as Socket | null,
};

const MAX_ATTEMPTS = 3;

export function startPhotonStream(handle: (event: PhotonEvent) => Promise<void>) {
  if (!enabled.photon()) {
    log.info("photon", "PHOTON_API_KEY / PHOTON_PROJECT_ID not set; inbound stream disabled (dry-run mode)");
    return;
  }

  let epoch = 0;
  let pending = 0;
  let queue = Promise.resolve();
  const failures = new Map<number, number>(); // seq -> attempts

  const socket = io(config.photon.origin, {
    path: `/v1/projects/${config.photon.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.photon.apiKey}` },
    autoConnect: false,
    reconnectionDelayMax: 30_000,
  });
  photonStream.socket = socket;
  photonStream.state = "connecting";
  photonStream.lastSubscribedAt = Date.now();

  let subscribeAttempt = 0;
  const subscribe = () => {
    socket
      .timeout(10_000)
      .emit(
        "subscribe",
        { startSeq: store.photonCursor, apiVersion: config.photon.apiVersion },
        (error: unknown, result: { ok: boolean; error?: { code: string }; connectionId?: string }) => {
          if (error) return socket.io.engine.close(); // timed out: reconnect and try again
          if (!result?.ok) {
            // Rejected (e.g. a transient server error). Retry with backoff instead of sitting
            // connected-but-unsubscribed forever.
            photonStream.state = "disconnected";
            const wait = Math.min(60_000, 1_000 * 2 ** subscribeAttempt++);
            log.error("photon", `subscribe rejected: ${result?.error?.code ?? "unknown"}; retrying in ${wait} ms`);
            setTimeout(() => socket.connected && subscribe(), wait).unref();
            return;
          }
          subscribeAttempt = 0;
          photonStream.state = "subscribed";
          photonStream.lastSubscribedAt = Date.now();
          photonStream.connectionId = result.connectionId ?? null;
          log.info("photon", `subscribed ${result.connectionId ?? ""} from cursor ${store.photonCursor}`);
        },
      );
  };
  socket.on("connect", subscribe);

  socket.on("disconnect", (reason) => {
    epoch++;
    photonStream.state = "disconnected";
    log.warn("photon", `stream disconnected (${reason}); reconnecting`);
    // socket.io-client does not reconnect by itself after a server-side disconnect.
    if (reason === "io server disconnect") setTimeout(() => socket.connect(), 1_000).unref();
  });

  socket.on("delivery", (event: PhotonEvent, meta: { seq: number }) => {
    const generation = epoch;
    if (++pending > 128) {
      // Backpressure: drop the connection and resume from the saved cursor.
      pending--;
      epoch++;
      socket.io.engine.close();
      return;
    }
    queue = queue
      .then(async () => {
        if (generation !== epoch || meta.seq <= store.photonCursor) return;
        photonStream.lastEventAt = new Date().toISOString();
        try {
          await handle(event);
        } catch (err) {
          const attempts = (failures.get(meta.seq) ?? 0) + 1;
          failures.set(meta.seq, attempts);
          if (attempts < MAX_ATTEMPTS) throw err;
          log.error("photon", `event ${event.id} (seq ${meta.seq}) failed ${attempts} times; skipping it`, err);
        }
        failures.delete(meta.seq);
        store.photonCursor = meta.seq;
      })
      .catch((err) => {
        log.error("photon", "event handling failed; reconnecting to replay from cursor", err);
        if (generation === epoch) {
          epoch++;
          socket.io.engine.close();
        }
      })
      .finally(() => {
        pending--;
      });
  });

  socket.on("delivery_error", (e: { code: string }) => log.error("photon", `delivery_error ${e?.code}`));
  socket.on("connect_error", (e: Error) => log.warn("photon", `connect_error ${e.message}`));
  socket.connect();
}

// Healthy unless the stream has been down for more than 5 minutes.
export function photonStreamHealthy() {
  if (photonStream.state === "disabled" || photonStream.state === "subscribed") return true;
  return Date.now() - photonStream.lastSubscribedAt < 5 * 60_000;
}

export function stopPhotonStream() {
  photonStream.socket?.close();
  photonStream.socket = null;
}
