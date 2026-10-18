// Nessie v2 notify webhook: Nessie POSTs every new transaction on our key to /nessie/webhook, and
// Andi reacts to purchases at alcohol sellers on a person's linked account. On boot the server
// registers the hook itself (or re-keys it if we lost the secret), because Nessie shows a hook's
// signing secret only once.

import { config, enabled } from "../config.js";
import { log } from "../log.js";
import { onAlcoholPurchase } from "../services/engine.js";
import { store } from "../store.js";
import { isAlcoholSeller, nessie, type NessieEvent } from "./client.js";

const EVENTS = ["transaction.created"]; // the moment of the purchase, before it settles

export const webhookUrl = () => `${config.publicUrl}/nessie/webhook`;

export async function ensureNessieWebhook() {
  if (!enabled.nessie()) return;
  const url = webhookUrl();
  // Hosted Nessie only calls public https URLs.
  if (!url.startsWith("https://") || /\/\/(localhost|127\.|10\.|192\.168\.)/.test(url)) {
    log.info("nessie", "PUBLIC_URL isn't a public https URL; no webhook (demo purchases still work)");
    return;
  }
  const ours = (await nessie.listWebhooks()).find((h) => h.mode === "notify" && h.url === url);
  const saved = store.nessieWebhook;
  if (ours && saved?.id === ours.id && saved.url === url) return;
  const hook = ours ? await nessie.rotateWebhookSecret(ours.id) : await nessie.createWebhook(url, EVENTS);
  if (!hook.secret) throw new Error("Nessie returned no webhook secret");
  store.nessieWebhook = { id: hook.id, url, secret: hook.secret };
  log.info("nessie", `${ours ? "re-keyed" : "registered"} webhook ${hook.id} -> ${url}`);
}

export async function handleNessieEvent(e: NessieEvent) {
  const tx = e.data?.transaction;
  if (e.type !== "transaction.created" || tx?.kind !== "purchase" || !tx.merchant_id) return "ignored";
  const accountId = tx.payer_id ?? e.account_id;
  const p = accountId ? store.all().find((x) => x.nessie?.accountId === accountId) : undefined;
  if (!p) return "unknown_account";
  const merchant = await nessie.getMerchant(tx.merchant_id);
  if (!isAlcoholSeller(merchant)) return "not_alcohol";
  await onAlcoholPurchase(p.id, merchant.name, tx.amount_cents / 100, tx.id);
  return "alcohol_purchase";
}
