// WebSocket hub for the Andi chip (ESP32-S3 round AMOLED).
// The iOS app pairs the chip over Bluetooth and hands it Wi-Fi credentials plus a chip token;
// the chip then connects here: wss://<host>/chip?token=<chipToken>
//
// Server -> chip: {"type":"state", "day":41, "glow":"steady"|"warm"|"alert", "mode":"idle"|"breathing"|"calling"|"milestone", "saved":1400, "line":"..."}
// Chip -> server: {"type":"hello"} | {"type":"tap"} | {"type":"long_press"}
//
// The server pings every 25 s and drops chips that don't answer (Wi-Fi drops are silent),
// so chipOnline in /api/me stays truthful. The chip should reconnect with backoff.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { log } from "../log.js";
import { store } from "../store.js";

export type ChipGlow = "steady" | "warm" | "alert";
export type ChipMode = "idle" | "breathing" | "calling" | "milestone";

export interface ChipState {
  type: "state";
  day: number;
  glow: ChipGlow;
  mode: ChipMode;
  saved: number;
  line?: string;
}

export type ChipEvent = { type: "hello" | "tap" | "long_press" };

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
const sockets = new Map<string, Set<WebSocket>>();
const lastState = new Map<string, ChipState>();
const alive = new WeakMap<WebSocket, boolean>();
const lastAction = new Map<string, number>(); // personId:type -> ms, debounces repeated taps
let onEvent: (personId: string, e: ChipEvent) => void = () => {};
let onConnect: (personId: string) => void = () => {};

const DEBOUNCE_MS = 3_000;

const heartbeat = setInterval(() => {
  for (const set of sockets.values()) {
    for (const ws of set) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }
}, 25_000);
heartbeat.unref();

export const chipHub = {
  onChipEvent(fn: typeof onEvent) {
    onEvent = fn;
  },
  // Called when a chip connects and nothing has been pushed to it yet (engine sends the state).
  onChipConnect(fn: typeof onConnect) {
    onConnect = fn;
  },

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/chip") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const presented = url.searchParams.get("token") ?? "";
    let person = store.byChipToken(presented);
    if (!person) {
      // First connection with a freshly paired token: promote it and retire the old chip.
      const pending = store.byPendingChipToken(presented);
      if (pending) {
        chipHub.disconnect(pending.id);
        person = store.update(pending.id, (x) => {
          x.chipToken = x.chipPendingToken;
          x.chipPendingToken = undefined;
        });
        log.info("chip", `new chip paired for ${pending.id}`);
      }
    }
    if (!person) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const personId = person.id;
      const set = sockets.get(personId) ?? new Set();
      set.add(ws);
      sockets.set(personId, set);
      alive.set(ws, true);
      log.info("chip", `connected for ${personId}`);
      const s = lastState.get(personId);
      if (s) ws.send(JSON.stringify(s));
      else onConnect(personId);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (raw) => {
        alive.set(ws, true);
        let e: ChipEvent;
        try {
          e = JSON.parse(raw.toString()) as ChipEvent;
        } catch {
          return; // ignore malformed frames
        }
        if (!["hello", "tap", "long_press"].includes(e?.type)) return;
        if (e.type !== "hello") {
          const key = `${personId}:${e.type}`;
          const now = Date.now();
          if (now - (lastAction.get(key) ?? 0) < DEBOUNCE_MS) return;
          lastAction.set(key, now);
        }
        if (!store.get(personId)) return ws.close(4001, "account deleted");
        try {
          onEvent(personId, e);
        } catch (err) {
          log.error("chip", "event handler failed", err);
        }
      });
      ws.on("close", () => {
        set.delete(ws);
        // Only drop the entry if it's still this set (a re-pair may have registered a new one).
        if (set.size === 0 && sockets.get(personId) === set) sockets.delete(personId);
      });
      ws.on("error", (err) => log.warn("chip", "socket error", err));
    });
  },

  push(personId: string, state: ChipState) {
    lastState.set(personId, state);
    for (const ws of sockets.get(personId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(state));
    }
  },

  // Close a person's chip connections (re-pairing, unpairing or account deletion).
  disconnect(personId: string) {
    for (const ws of sockets.get(personId) ?? []) ws.close(4001, "unpaired");
    sockets.delete(personId);
    lastState.delete(personId);
  },

  closeAll() {
    for (const set of sockets.values()) for (const ws of set) ws.close(1001, "server restarting");
    sockets.clear();
  },

  connected: (personId: string) => (sockets.get(personId)?.size ?? 0) > 0,
  count: () => [...sockets.values()].reduce((n, s) => n + s.size, 0),
  last: (personId: string) => lastState.get(personId),
};
