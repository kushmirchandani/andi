// Capital One Nessie v2 (mock banking). Used for two things:
//   - a quiet signal: a new purchase at an alcohol seller triggers a gentle check-in. Purchases
//     arrive on a signed notify webhook (routes/nessie.ts), so a purchase made anywhere on the
//     person's account reaches Andi, not only the ones our demo route makes.
//   - a reward: money not spent on alcohol, shown on the chip and in Andi Wrapped
// Docs: https://v2.nessieisreal.com/docs (spec: /openapi.json). Bearer auth, integer cents,
// list responses are { items, next_cursor }, errors are problem+json.

import crypto from "node:crypto";
import { config, enabled } from "../config.js";
import { fetchWithRetry } from "../http.js";

export interface NessieMerchant {
  id: string;
  name: string;
  category?: string;
}

export interface NessieTransaction {
  id: string;
  kind: string; // "purchase", "deposit", ...
  status: string; // "pending" | "completed" | "declined" | "cancelled"
  amount_cents: number;
  merchant_id?: string;
  payer_id?: string;
  description?: string;
}

export interface NessieWebhook {
  id: string;
  mode: "notify" | "decision";
  url: string;
  active: boolean;
  events?: string[] | null;
  secret?: string; // only on create and rotate
}

// One event, as delivered by a notify webhook and listed by GET /events.
export interface NessieEvent {
  id: string;
  type: string; // "transaction.created", "transaction.completed", ...
  account_id?: string;
  tx_id?: string;
  data?: { transaction?: NessieTransaction };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchWithRetry("nessie", `${config.nessie.baseUrl}${path}`, {
    timeoutMs: 8_000,
    retries: method === "GET" ? 2 : 0, // no idempotency keys yet: a retried create is a second record
    method,
    headers: { authorization: `Bearer ${config.nessie.apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Nessie ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const ALCOHOL_WORDS = ["liquor", "wine", "spirits", "beer", "bar", "pub", "tavern", "brewery", "saloon", "cantina"];

export function isAlcoholSeller(m: Pick<NessieMerchant, "name" | "category">) {
  const hay = [m.name, m.category ?? ""].join(" ").toLowerCase();
  return ALCOHOL_WORDS.some((w) => new RegExp(`\\b${w}`).test(hay));
}

// Nessie-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">
export function verifySignature(secret: string, header: string | undefined, body: string) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DEMO_ADDRESS = { street_number: "1", street_name: "Oxford St", city: "Cambridge", state: "MA", zip: "02138" };
const cents = (dollars: number) => Math.round(dollars * 100);

export const nessie = {
  enabled: enabled.nessie,

  async createCustomer(firstName: string) {
    const c = await call<{ id: string }>("POST", "/customers", { first_name: firstName, last_name: "Demo", address: DEMO_ADDRESS });
    return c.id;
  },

  async createAccount(customerId: string) {
    const a = await call<{ id: string }>("POST", `/customers/${customerId}/accounts`, {
      type: "Checking",
      nickname: "Everyday",
      balance_cents: cents(2500),
    });
    return a.id;
  },

  // Reuses a merchant with the same name, so repeated demo runs don't pile up duplicates.
  async getOrCreateMerchant(name: string, category: string) {
    const existing = await call<{ items: NessieMerchant[] | null }>("GET", "/merchants?limit=100").catch(() => ({ items: [] }));
    const hit = (existing.items ?? []).find((m) => m.name === name);
    if (hit) return hit.id;
    const m = await call<NessieMerchant>("POST", "/merchants", {
      name,
      category,
      address: { street_number: "10", street_name: "Brattle St", city: "Cambridge", state: "MA", zip: "02138" },
      geocode: { lat: 42.3736, lng: -71.1205 },
    });
    return m.id;
  },

  // The purchase starts out pending and settles on its own a little later.
  createPurchase: (accountId: string, merchantId: string, amount: number, description: string) =>
    call<NessieTransaction>("POST", `/accounts/${accountId}/purchases`, { merchant_id: merchantId, amount_cents: cents(amount), description }),

  getMerchant: (merchantId: string) => call<NessieMerchant>("GET", `/merchants/${merchantId}`),

  listWebhooks: async () => (await call<{ items: NessieWebhook[] | null }>("GET", "/webhooks")).items ?? [],
  createWebhook: (url: string, events: string[]) => call<NessieWebhook>("POST", "/webhooks", { mode: "notify", url, events }),
  rotateWebhookSecret: (id: string) => call<NessieWebhook>("POST", `/webhooks/${id}/secret/rotate`),
};

// Money saved = self-reported weekly alcohol spend x weeks sober, minus alcohol-seller purchases since.
export function moneySaved(weeklySpend: number, daysSober: number, alcoholSpendSince = 0) {
  return Math.max(0, Math.round((weeklySpend / 7) * daysSober - alcoholSpendSince));
}
