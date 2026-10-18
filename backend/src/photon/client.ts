// Photon V2 (Beta) HTTP API: https://photon.codes/docs/beta
// Verified against https://api.photon.codes/openapi.json:
//   POST /v1/projects/{id}/messages  { spaceId, senderId, content, parentMessageId? }  -> 202 SentMessage
//   content types: text, text.update (edit), message.delete (unsend), reaction, poll, voice, attachment, group
//   POST /v1/projects/{id}/spaces/{spaceId}/typing  { senderId, typing }
//   POST /v1/projects/{id}/messages/{messageId}/read  (needs Idempotency-Key)
//   POST /v1/projects/{id}/attachments  multipart/related: a JSON part {contentType, sizeBytes, filename}
//        then the file bytes (needs Idempotency-Key) -> Attachment { id: "pho_att_..." }
//   attachment / voice content then reference it: { type: "attachment" | "voice", attachmentId }
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
  | { type: "poll"; question: string; options: { id: string; text: string }[]; selectionMode: "single" | "multiple" }
  | { type: "attachment"; attachmentId: string }
  | { type: "voice"; attachmentId: string };

export interface FileInfo {
  contentType: string;
  sizeBytes: number;
  filename: string;
}

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
  // For attachments and voice notes: what was uploaded (never the bytes).
  file?: FileInfo;
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

async function send(t: Target, content: Content, opts: { parentMessageId?: string; key?: string; file?: FileInfo } = {}) {
  const entry = { at: new Date().toISOString(), spaceId: t.spaceId, content, parentMessageId: opts.parentMessageId, file: opts.file };
  if (!enabled.photon()) {
    const id = `dry_${crypto.randomUUID()}`;
    record({ ...entry, id, dryRun: true });
    // Message bodies only at debug level: they can be crisis texts or someone's "why".
    const size = "text" in content ? ` (${content.text.length} chars)` : opts.file ? ` (${opts.file.contentType}, ${opts.file.sizeBytes} bytes)` : "";
    log.info("photon", `dry-run ${content.type} -> ${t.spaceId}${size}`);
    if ("text" in content) log.debug("photon", `dry-run text: ${content.text}`);
    return { id };
  }
  const body: Record<string, unknown> = { spaceId: t.spaceId, senderId: t.senderId, content };
  if (opts.parentMessageId) body.parentMessageId = opts.parentMessageId;
  const key = opts.key ?? `andi:${crypto.randomUUID()}`;
  // A just-uploaded file can briefly be ATTACHMENT_NOT_READY (409): wait a beat and resend.
  for (let attempt = 0; ; attempt++) {
    try {
      const sent = await post("/messages", body, key);
      record({ ...entry, id: sent.id ?? "?", dryRun: false });
      return sent;
    } catch (err) {
      const notReady = err instanceof UpstreamError && err.status === 409 && /ATTACHMENT_NOT_READY/.test(err.message);
      if (!notReady || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// Upload bytes as a Photon Attachment. multipart/related with exactly two parts: the JSON
// description, then the file. Returns the attachment id (pho_att_...).
async function upload(bytes: Buffer, file: FileInfo): Promise<string> {
  const boundary = `andi-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify(file) +
      `\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);
  const res = await fetchWithRetry("photon", `${base()}/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.photon.apiKey}`,
      accept: "application/json",
      "content-type": `multipart/related; boundary=${boundary}; type="application/json"`,
      "idempotency-key": `andi-att:${crypto.createHash("sha256").update(body).digest("hex").slice(0, 40)}`,
    },
    body,
    timeoutMs: 30_000,
    retries: 2,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UpstreamError("photon", res.status, `Photon /attachments ${res.status} (request ${res.headers.get("x-request-id")}): ${text.slice(0, 300)}`);
  }
  const att = JSON.parse(text) as { id?: string };
  if (!att.id) throw new UpstreamError("photon", res.status, "Photon /attachments returned no id");
  return att.id;
}

async function sendFile(t: Target, kind: "attachment" | "voice", bytes: Buffer, contentType: string, filename: string) {
  const file: FileInfo = { contentType, sizeBytes: bytes.length, filename };
  if (!enabled.photon()) return send(t, { type: kind, attachmentId: "dry_att" }, { file });
  const attachmentId = await upload(bytes, file);
  return send(t, { type: kind, attachmentId }, { file });
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

  // An image (or any file) as its own bubble.
  image: (t: Target, png: Buffer, filename = "andi.png") => sendFile(t, "attachment", png, "image/png", filename),

  // A native iMessage voice note.
  voice: (t: Target, audio: Buffer, contentType = "audio/mpeg", filename = "andi.mp3") =>
    sendFile(t, "voice", audio, contentType, filename),

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
