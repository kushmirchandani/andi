// Capital One Nessie (mock banking). Used for two things:
//   - a quiet signal: a new purchase at an alcohol seller triggers a gentle check-in
//   - a reward: money not spent on alcohol, shown on the chip and in Andi Wrapped
// Docs: https://nessieisreal.com/documentation (spec: nessie-openapi-spec.yaml). The key goes in the `key` query param.

import { config, enabled } from "../config.js";
import { fetchWithRetry } from "../http.js";

interface NessieMerchant {
  _id: string;
  name: string;
  category?: string[] | string;
}
interface NessiePurchase {
  _id: string;
  merchant_id: string;
  amount: number;
  purchase_date: string;
  description?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.nessie.baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(config.nessie.apiKey)}`;
  const res = await fetchWithRetry("nessie", url, {
    timeoutMs: 8_000,
    retries: method === "GET" ? 2 : 0,
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Never include the URL in errors: it carries the API key.
  if (!res.ok) throw new Error(`Nessie ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const ALCOHOL_WORDS = ["liquor", "wine", "spirits", "beer", "bar", "pub", "tavern", "brewery", "saloon", "cantina"];

export function isAlcoholSeller(m: Pick<NessieMerchant, "name" | "category">) {
  const cats = Array.isArray(m.category) ? m.category : m.category ? [m.category] : [];
  const hay = [m.name, ...cats].join(" ").toLowerCase();
  return ALCOHOL_WORDS.some((w) => new RegExp(`\\b${w}`).test(hay));
}

// The current Nessie spec documents 201 bodies as plain strings ("Customer created"), while
// older responses carried { objectCreated: { _id } }. Accept both: use the id when present,
// otherwise look the new record up.
async function createdId<T extends { _id: string }>(res: unknown, lookup: () => Promise<T[]>, match: (x: T) => boolean) {
  const direct = (res as { objectCreated?: { _id?: string } } | null)?.objectCreated?._id;
  if (direct) return direct;
  const list = await lookup();
  const found = (Array.isArray(list) ? list : []).filter(match).at(-1)?._id;
  if (!found) throw new Error("Nessie create returned no id");
  return found;
}

const DEMO_ADDRESS = { street_number: "1", street_name: "Oxford St", city: "Cambridge", state: "MA", zip: "02138" };

export const nessie = {
  enabled: enabled.nessie,

  async createCustomer(firstName: string) {
    const r = await call<unknown>("POST", "/customers", { first_name: firstName, last_name: "Demo", address: DEMO_ADDRESS });
    return createdId<{ _id: string; first_name?: string; last_name?: string }>(
      r,
      () => call("GET", "/customers"),
      (c) => c.first_name === firstName && c.last_name === "Demo",
    );
  },

  async createAccount(customerId: string) {
    const r = await call<unknown>("POST", `/customers/${customerId}/accounts`, {
      type: "Checking",
      nickname: "Everyday",
      rewards: 0,
      balance: 2500,
    });
    return createdId<{ _id: string; nickname?: string }>(
      r,
      () => call("GET", `/customers/${customerId}/accounts`),
      (a) => a.nickname === "Everyday",
    );
  },

  // Reuses a merchant with the same name, so repeated demo runs don't pile up duplicates.
  async getOrCreateMerchant(name: string, category: string) {
    const existing = await call<NessieMerchant[]>("GET", "/merchants").catch(() => [] as NessieMerchant[]);
    const hit = (Array.isArray(existing) ? existing : []).find((m) => m.name === name);
    if (hit) return hit._id;
    const r = await call<unknown>("POST", "/merchants", {
      name,
      category, // the spec types category as a string (the docs' example shows an array; strings are accepted by isAlcoholSeller either way)
      address: { street_number: "10", street_name: "Brattle St", city: "Cambridge", state: "MA", zip: "02138" },
      geocode: { lat: 42.3736, lng: -71.1205 },
    });
    return createdId<NessieMerchant>(r, () => call("GET", "/merchants"), (m) => m.name === name);
  },

  async createPurchase(accountId: string, merchantId: string, amount: number, description: string) {
    const purchase_date = new Date().toISOString().slice(0, 10);
    const r = await call<unknown>("POST", `/accounts/${accountId}/purchases`, {
      merchant_id: merchantId,
      medium: "balance",
      purchase_date,
      amount,
      description,
    });
    return ((r as { objectCreated?: NessiePurchase } | null)?.objectCreated ?? {
      _id: "",
      merchant_id: merchantId,
      amount,
      purchase_date,
      description,
    }) as NessiePurchase;
  },

  listPurchases: (accountId: string) => call<NessiePurchase[]>("GET", `/accounts/${accountId}/purchases`),
  getMerchant: (merchantId: string) => call<NessieMerchant>("GET", `/merchants/${merchantId}`),
};

// Money saved = self-reported weekly alcohol spend x weeks sober, minus alcohol-seller purchases since.
export function moneySaved(weeklySpend: number, daysSober: number, alcoholSpendSince = 0) {
  return Math.max(0, Math.round((weeklySpend / 7) * daysSober - alcoholSpendSince));
}
