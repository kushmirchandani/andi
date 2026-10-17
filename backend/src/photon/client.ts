// Photon V2 (Beta) HTTP API: https://photon.codes/docs/beta
// Verified against https://api.photon.codes/openapi.json:
//   POST /v1/projects/{id}/messages  { spaceId, senderId, content, parentMessageId? }  -> 202 SentMessage
//   content types: text, text.update (edit), message.delete (unsend), reaction, poll, voice, attachment, group
//   POST /v1/projects/{id}/spaces/{spaceId}/typing  { senderId, typing }
//   POST /v1/projects/{id}/messages/{messageId}/read  (needs Idempotency-Key)
// Shared iMessage lines can only reply in direct chats to someone who has texted the line first.
//
// Without PHOTON_API_KEY / PHOTON_PROJECT_ID the client runs in dry-run mode: nothing is sent,
// and every message lands in the in-memory outbox (GET /demo/outbox) so flows stay testable.

import crypto from "node:crypto";
import { config, enabled } from "../config.js";
import { fetchWithRetry, UpstreamError } from "../http.js";
import { log } from "../log.js";

export type Content =
  | { type: "text"; format: "plain" | "markdown"; text: string }
  | { type: "text.update"; format: "plain" | "markdown"; text: string }
  | { type: "message.delete" }
  | { type: "reaction"; reaction: string; action: "add" | "remove" }
  | { type: "poll"; question: string; options: { id: string; text: string }[]; selectionMode: "single" | "multiple" };

export interface Target {
  spaceId: string;
  senderId: string; // the agent's user id in that space
}

export interface OutboxEntry {
  at: string;
  id: string;
  spaceId: string;
  content: Content;
  parentMessageId?: string;
  dryRun: boolean;
}

// Last 200 outbound messages, newest last. In memory only.
const outbox: OutboxEntry[] = [];
export const photonOutbox = {
  list: () => [...outbox],
  clear: () => void outbox.splice(0, outbox.length),
};
function record(e: OutboxEntry) {
  outbox.push(e);
  if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
}

const base = () => `${config.photon.origin}/v1/projects/${config.photon.projectId}`;

async function post(path: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.photon.apiKey}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  // Retries reuse the same Idempotency-Key, so Photon never sends a message twice.
  const res = await fetchWithRetry("photon", `${base()}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 10_000,
    retries: idempotencyKey ? 2 : 0,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UpstreamError("photon", res.status, `Photon ${path} ${res.status} (request ${res.headers.get("x-request-id")}): ${text.slice(0, 300)}`);
  }
  try {
    return text ? (JSON.parse(text) as { id?: string }) : {};
  } catch {
    return {};
  }
}

async function send(t: Target, content: Content, opts: { parentMessageId?: string; key?: string } = {}) {
  const entry = { at: new Date().toISOString(), spaceId: t.spaceId, content, parentMessageId: opts.parentMessageId };
  if (!enabled.photon()) {
    const id = `dry_${crypto.randomUUID()}`;
    record({ ...entry, id, dryRun: true });
    // Message bodies only at debug level: they can be crisis texts or someone's "why".
    log.info("photon", `dry-run ${content.type} -> ${t.spaceId}${"text" in content ? ` (${content.text.length} chars)` : ""}`);
    if ("text" in content) log.debug("photon", `dry-run text: ${content.text}`);
    return { id };
  }
  const body: Record<string, unknown> = { spaceId: t.spaceId, senderId: t.senderId, content };
  if (opts.parentMessageId) body.parentMessageId = opts.parentMessageId;
  const sent = await post("/messages", body, opts.key ?? `andi:${crypto.randomUUID()}`);
  record({ ...entry, id: sent.id ?? "?", dryRun: false });
  return sent;
}

export const photon = {
  text: (t: Target, text: string, opts?: { parentMessageId?: string; key?: string }) =>
    send(t, { type: "text", format: "plain", text }, opts),

  // Edit a message we sent, in place. Used for the sponsor's live status message.
  edit: (t: Target, messageId: string, text: string) =>
    send(t, { type: "text.update", format: "plain", text }, { parentMessageId: messageId }),

  unsend: (t: Target, messageId: string) => send(t, { type: "message.delete" }, { parentMessageId: messageId }),

  react: (t: Target, messageId: string, reaction = "❤️") =>
    send(t, { type: "reaction", reaction, action: "add" }, { parentMessageId: messageId }),

  poll: (t: Target, question: string, options: { id: string; text: string }[]) =>
    send(t, { type: "poll", question, options, selectionMode: "multiple" }),

  // Best effort: typing indicators and read receipts never fail a flow.
  async typing(t: Target, typing: boolean) {
    if (!enabled.photon()) return;
    await post(`/spaces/${t.spaceId}/typing`, { senderId: t.senderId, typing }).catch((e) =>
      log.debug("photon", "typing indicator failed", e),
    );
  },

  async markRead(messageId: string) {
    if (!enabled.photon()) return;
    await post(`/messages/${messageId}/read`, undefined, `read:${messageId}`).catch((e) => log.debug("photon", "markRead failed", e));
  },
};
