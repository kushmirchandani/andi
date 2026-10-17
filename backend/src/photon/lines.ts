// Photon shared-line assignments (https://api.photon.codes/openapi.json, "Create shared line assignment";
// guide: https://photon.codes/docs/beta/get-started/imessage).
//
// On the shared iMessage pool, Andi only hears people it has *assigned*: an assignment maps one
// end user's handle (E.164 or email) onto a pooled line, and "the assigned number is allocated by
// the server". So every person (and every sponsor) gets an assignment at setup, and the number
// they text is the assignment's assignedPhoneNumber, not one global number.
//   POST   /v1/projects/{id}/platforms/imessage/assignments          { handle, firstName? } (Idempotency-Key)
//   GET    /v1/projects/{id}/platforms/imessage/assignments          ?pageToken=
//   DELETE /v1/projects/{id}/platforms/imessage/assignments/{assignmentId}   (frees the seat)
// Needs a project API key with platforms:read and platforms:write.
// Projects on dedicated lines get 409 IMESSAGE_MODE_DEDICATED: then PHOTON_AGENT_HANDLE is the number.

import crypto from "node:crypto";
import { config, enabled } from "../config.js";
import { fetchWithRetry, UpstreamError } from "../http.js";
import { log, mask } from "../log.js";
import { normalizeHandle } from "../store.js";

export interface Line {
  assignmentId?: string;
  number: string | null; // what this handle should text
}

interface Assignment {
  assignmentId: string;
  assignedPhoneNumber: string;
  handle: string;
  releasedAt?: string;
}

const base = () => `${config.photon.origin}/v1/projects/${config.photon.projectId}/platforms/imessage/assignments`;
const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${config.photon.apiKey}`,
  accept: "application/json",
  ...extra,
});

async function problemCode(res: Response) {
  const text = await res.text();
  try {
    return { code: (JSON.parse(text) as { code?: string }).code ?? "", text };
  } catch {
    return { code: "", text };
  }
}

async function findExisting(handle: string): Promise<Assignment | undefined> {
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${base()}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetchWithRetry("photon", url, { headers: headers(), timeoutMs: 10_000 });
    if (!res.ok) throw new UpstreamError("photon", res.status, `list assignments ${res.status}`);
    const body = (await res.json()) as { assignments: Assignment[]; nextPageToken?: string };
    const hit = body.assignments.find((a) => !a.releasedAt && normalizeHandle(a.handle) === normalizeHandle(handle));
    if (hit) return hit;
    if (!body.nextPageToken) return undefined;
    pageToken = body.nextPageToken;
  }
  return undefined;
}

// Assign (or find the existing assignment for) a handle. Never throws: on failure it returns the
// configured fallback number so onboarding still completes; /api/me retries later.
export async function assignLine(handle: string, firstName?: string): Promise<Line & { ok: boolean }> {
  const fallback = { number: config.photon.agentHandle || null };
  if (!enabled.photon()) return { ...fallback, ok: true };
  const h = normalizeHandle(handle);
  try {
    const body: Record<string, string> = { handle: h };
    if (firstName?.trim()) body.firstName = firstName.trim().slice(0, 100);
    const res = await fetchWithRetry("photon", base(), {
      method: "POST",
      // One key per attempt (retries inside fetchWithRetry reuse it); a duplicate comes back as 409 ASSIGNMENT_EXISTS.
      headers: headers({ "content-type": "application/json", "idempotency-key": `andi-assign:${crypto.randomUUID()}` }),
      body: JSON.stringify(body),
      timeoutMs: 10_000,
      retries: 2,
    });
    if (res.status === 201 || res.ok) {
      const a = (await res.json()) as Assignment;
      log.info("photon", `assigned ${mask(h)} -> ${a.assignedPhoneNumber}`);
      return { assignmentId: a.assignmentId, number: a.assignedPhoneNumber, ok: true };
    }
    const { code, text } = await problemCode(res);
    if (code === "ASSIGNMENT_EXISTS") {
      const a = await findExisting(h);
      if (a) return { assignmentId: a.assignmentId, number: a.assignedPhoneNumber, ok: true };
    }
    if (code === "IMESSAGE_MODE_DEDICATED") return { ...fallback, ok: true }; // dedicated line: one number for everyone
    log.error("photon", `assignment for ${mask(h)} failed: ${res.status} ${code || text.slice(0, 200)}`);
    return { ...fallback, ok: false };
  } catch (err) {
    log.error("photon", `assignment for ${mask(h)} failed`, err);
    return { ...fallback, ok: false };
  }
}

// Free the seat. Best effort; safe to repeat.
export async function releaseLine(assignmentId: string | undefined) {
  if (!assignmentId || !enabled.photon()) return;
  try {
    const res = await fetchWithRetry("photon", `${base()}/${encodeURIComponent(assignmentId)}`, {
      method: "DELETE",
      headers: headers(),
      timeoutMs: 10_000,
    });
    if (!res.ok && res.status !== 404) log.warn("photon", `release ${assignmentId} returned ${res.status}`);
  } catch (err) {
    log.warn("photon", `release ${assignmentId} failed`, err);
  }
}
