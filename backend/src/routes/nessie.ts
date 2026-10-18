// POST /nessie/webhook: Nessie v2 notify deliveries. Signed with the hook's secret
// (Nessie-Signature: t=..,v1=hmac-sha256("t.body")); at-least-once, so de-duplicated on Nessie-Event-Id.

import { Hono } from "hono";
import { errorBody } from "../http.js";
import { log } from "../log.js";
import { verifySignature, type NessieEvent } from "../nessie/client.js";
import { handleNessieEvent } from "../nessie/webhook.js";
import { store } from "../store.js";

export const nessieRoutes = new Hono();

nessieRoutes.post("/webhook", async (c) => {
  const body = await c.req.text();
  const hook = store.nessieWebhook;
  if (!hook || !verifySignature(hook.secret, c.req.header("nessie-signature"), body))
    return c.json(errorBody("unauthorized", "Bad webhook signature."), 401);

  let event: NessieEvent;
  try {
    event = JSON.parse(body) as NessieEvent;
  } catch {
    return c.json(errorBody("invalid_request", "Body isn't JSON."), 400);
  }
  const eventId = c.req.header("nessie-event-id") ?? event.id;
  if (eventId && store.nessieSeen(eventId)) return c.json({ ok: true, result: "duplicate" });

  // A failure answers 500, so Nessie retries; the event is only marked seen once handled.
  const result = await handleNessieEvent(event);
  if (eventId) store.markNessieSeen(eventId);
  if (result === "alcohol_purchase") log.info("nessie", `alcohol purchase on ${event.tx_id ?? event.data?.transaction?.id}`);
  return c.json({ ok: true, result });
});
