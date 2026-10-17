import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { app, call, onboard, store } from "./helpers.js";
import { chipHub } from "../src/chip/hub.js";
import { startBreathing } from "../src/services/engine.js";

let server: ReturnType<typeof serve>;
let port = 0;

before(async () => {
  chipHub.onChipEvent((personId, e) => {
    if (e.type === "tap") void startBreathing(personId, "chip");
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = (info as AddressInfo).port;
      resolve();
    });
    server.on("upgrade", (req, socket, head) => chipHub.handleUpgrade(req, socket, head));
  });
});
after(() => {
  chipHub.closeAll();
  server.close();
});

const nextMessage = (ws: WebSocket) => new Promise<any>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));

test("a chip with a bad token is refused", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chip?token=nope`);
  const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
  assert.match(err.message, /401/);
});

test("a paired chip gets its state on connect, and a tap starts breathing", async () => {
  const { apiToken } = await onboard();
  const pair = await call("POST", "/api/chip/pair", { token: apiToken });
  const url = pair.json.wsUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
  const ws = new WebSocket(url);
  const first = await nextMessage(ws);
  assert.equal(first.type, "state");
  assert.equal(typeof first.day, "number");
  assert.ok(["steady", "warm", "alert"].includes(first.glow));
  assert.equal((await call("GET", "/api/me", { token: apiToken })).json.chipOnline, true);

  const breathing = nextMessage(ws);
  ws.send(JSON.stringify({ type: "tap" }));
  assert.equal((await breathing).mode, "breathing");
  assert.ok(store.byToken(apiToken)!.events.some((e) => e.kind === "breathe" && e.detail === "chip"));

  // Re-pairing: the old chip keeps working until the new one connects, then it's retired.
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  const pair2 = await call("POST", "/api/chip/pair", { token: apiToken });
  assert.equal(ws.readyState, WebSocket.OPEN, "a pending pairing doesn't disconnect the working chip");
  const ws2 = new WebSocket(pair2.json.wsUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`));
  const state2 = await nextMessage(ws2);
  assert.equal(state2.type, "state");
  assert.equal(await closed, 4001);
  assert.equal((await call("GET", "/api/me", { token: apiToken })).json.chipOnline, true);
  ws2.close();
});
