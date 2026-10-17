// Keeps each person's and sponsor's Photon line assignment in step with their handle.
// See photon/lines.ts for why assignments exist.

import { config, enabled } from "../config.js";
import { assignLine, releaseLine } from "../photon/lines.js";
import { normalizeHandle, store } from "../store.js";

// Is any other account still using this handle (as a person or as a sponsor)?
function handleInUse(handle: string, except: { personId: string; role: "person" | "sponsor" }) {
  const h = normalizeHandle(handle);
  return store.all().some(
    (p) =>
      (normalizeHandle(p.phone) === h && !(except.role === "person" && p.id === except.personId)) ||
      (p.sponsor && normalizeHandle(p.sponsor.phone) === h && !(except.role === "sponsor" && p.id === except.personId)),
  );
}

export async function ensurePersonLine(personId: string) {
  if (!enabled.photon()) return; // dry-run: the configured number (if any) is used directly
  const p = store.get(personId);
  if (!p || (p.photon.andiNumber && p.photon.assignmentId)) return;
  const line = await assignLine(p.phone, p.name);
  if (!store.get(personId)) return;
  store.update(personId, (x) => {
    if (line.assignmentId) x.photon.assignmentId = line.assignmentId;
    if (line.number && (line.ok || !x.photon.andiNumber)) x.photon.andiNumber = line.number;
  });
}

export async function ensureSponsorLine(personId: string) {
  if (!enabled.photon()) return;
  const p = store.get(personId);
  if (!p?.sponsor || (p.sponsor.photon.andiNumber && p.sponsor.photon.assignmentId)) return;
  const line = await assignLine(p.sponsor.phone, p.sponsor.name);
  const fresh = store.get(personId);
  if (!fresh?.sponsor) return;
  store.update(personId, (x) => {
    if (!x.sponsor) return;
    if (line.assignmentId) x.sponsor.photon.assignmentId = line.assignmentId;
    if (line.number && (line.ok || !x.sponsor.photon.andiNumber)) x.sponsor.photon.andiNumber = line.number;
  });
}

// Lines are missing when Photon was down at setup; /api/me heals them on the next refresh.
const lastHeal = new Map<string, number>();
export async function healLines(personId: string) {
  if (!enabled.photon()) return;
  const p = store.get(personId);
  const missing = p && (!p.photon.assignmentId || (p.sponsor && !p.sponsor.photon.assignmentId));
  if (!missing) return;
  // The app polls /api/me every 3 s while linking; retry Photon at most once a minute.
  if (Date.now() - (lastHeal.get(personId) ?? 0) < 60_000) return;
  lastHeal.set(personId, Date.now());
  await ensurePersonLine(personId);
  await ensureSponsorLine(personId);
}

export async function releaseSponsorLine(personId: string, sponsor: { phone: string; photon: { assignmentId?: string } }) {
  if (handleInUse(sponsor.phone, { personId, role: "sponsor" })) return;
  await releaseLine(sponsor.photon.assignmentId);
}

export async function releasePersonLines(person: { id: string; phone: string; photon: { assignmentId?: string }; sponsor?: { phone: string; photon: { assignmentId?: string } } }) {
  if (!handleInUse(person.phone, { personId: person.id, role: "person" })) await releaseLine(person.photon.assignmentId);
  if (person.sponsor) await releaseSponsorLine(person.id, person.sponsor);
}

// The number a handle should text: its own assignment, else the project's configured number.
export const andiNumber = (link?: { andiNumber?: string }) => link?.andiNumber || config.photon.agentHandle || null;
