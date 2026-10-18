import "./setup.js";
import { app } from "../src/app.js";
import { clock } from "../src/clock.js";
import { photonOutbox } from "../src/photon/client.js";
import { store } from "../src/store.js";

export { app, clock, photonOutbox, store };

export const demoHeaders = { "content-type": "application/json", "x-demo-key": "test-demo" };

export async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export const onboardBody = (over: Record<string, unknown> = {}) => ({
  name: "Maya",
  phone: "+16175550101",
  soberSince: "2026-09-06",
  weeklyDrinkSpend: 240,
  screening: { drinksPerDay: 4, drinksDaily: false, morningDrinking: false, pastWithdrawal: false },
  sponsor: { name: "Sam", phone: "+16175550102" },
  ...over,
});

export async function onboard(over: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/onboard", { body: onboardBody(over) });
  if (r.status !== 200) throw new Error(`onboard failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { apiToken: string; linkCode: string; me: any; screening: any };
}

// Simulate an inbound iMessage via the demo route; returns what Andi sent back.
export async function inbound(from: string, payload: { text?: string; pollVote?: string[]; reaction?: string }) {
  const r = await call("POST", "/demo/inbound", { body: { from, ...payload }, headers: { "x-demo-key": "test-demo" } });
  if (r.status !== 200) throw new Error(`inbound failed ${r.status} ${JSON.stringify(r.json)}`);
  return (r.json.replies as { content: { type: string; text?: string } }[]).map((x) => x.content.text ?? x.content.type);
}

export function reset() {
  for (const p of store.all()) store.remove(p.id);
  for (const s of store.signIns()) store.removeSignIn(s.id);
  photonOutbox.clear();
  clock.pin(null);
}
