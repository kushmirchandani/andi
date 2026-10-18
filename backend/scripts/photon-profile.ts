// Sets Andi's iMessage identity on Photon: first name "Andi" (no last name) and the ring avatar,
// so people see "Andi" with a photo instead of a bare number.
//
//   npm run photon:profile              # update the live Photon project (needs PHOTON_API_KEY + PHOTON_PROJECT_ID)
//   npm run photon:profile -- --dry-run # only write the avatar to ./andi-avatar.png, no network
//
// Flow (Photon V2): PATCH /agent-profile {firstName, lastName}; POST /agent-profile/avatar/uploads
// {contentType} -> presigned S3 POST; upload the file there (formFields first, file last, no Photon
// credentials); PUT /agent-profile/avatar {uploadId}. Mutations need an Idempotency-Key.

import crypto from "node:crypto";
import fs from "node:fs";
import { avatarPng } from "../src/cards/render.js";
import { config, enabled } from "../src/config.js";

const dryRun = process.argv.includes("--dry-run");
const png = avatarPng();

if (dryRun) {
  fs.writeFileSync("andi-avatar.png", png);
  console.log(`dry run: wrote andi-avatar.png (${png.length} bytes). nothing sent.`);
  process.exit(0);
}
if (!enabled.photon()) {
  console.error("PHOTON_API_KEY and PHOTON_PROJECT_ID are required (or pass --dry-run).");
  process.exit(1);
}

const base = `${config.photon.origin}/v1/projects/${config.photon.projectId}/agent-profile`;
const auth = { authorization: `Bearer ${config.photon.apiKey}`, accept: "application/json" };
const key = (what: string) => `andi-profile:${what}:${crypto.createHash("sha256").update(png).digest("hex").slice(0, 16)}`;

async function call(method: string, path: string, body: unknown, idempotencyKey?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} agent-profile${path} -> ${res.status} (request ${res.headers.get("x-request-id")}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const named = await call("PATCH", "", { firstName: "Andi", lastName: null }, key("name"));
console.log(`name set: ${named.firstName}${named.lastName ? ` ${named.lastName}` : ""}`);

const upload = (await call("POST", "/avatar/uploads", { contentType: "image/png" })) as {
  uploadId: string;
  uploadUrl: string;
  formFields: Record<string, string>;
};
const form = new FormData();
for (const [k, v] of Object.entries(upload.formFields)) form.append(k, v);
form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "andi-avatar.png"); // the file must be the last part
const s3 = await fetch(upload.uploadUrl, { method: "POST", body: form });
if (!s3.ok) throw new Error(`avatar upload -> ${s3.status}: ${(await s3.text()).slice(0, 300)}`);

const done = await call("PUT", "/avatar", { uploadId: upload.uploadId }, key("avatar"));
console.log(`avatar set: ${done.avatarUrl ? "yes" : "no url returned"}`);
