// Keeps each person's and sponsor's Photon line assignment in step with their handle.
// See photon/lines.ts for why assignments exist.

import { config, enabled } from "../config.js";
import { assignLine, releaseLine } from "../photon/lines.js";
import { normalizeHandle, store } from "../store.js";

// Is anything else still using this handle (a person, a sponsor, or a sign-in in progress)?
function handleInUse(handle: string, except: { id: string; role: "person" | "sponsor" | "signIn" }) {
  const h = normalizeHandle(handle);
  return (
    store.all().some(
      (p) =>
        (normalizeHandle(p.phone) === h && !(except.role === "person" && p.id === except.id)) ||
        (p.sponsor && normalizeHandle(p.sponsor.phone) === h && !(except.role === "sponsor" && p.id === except.id)),
    ) || store.signIns().some((s) => normalizeHandle(s.phone) === h && !(except.role === "signIn" && s.id === except.id))
  );
}

// A sign-in needs a line before the person can text it. Every number gets the same call, whether
// or not it has an account, so the response never hints either way.
export async function ensureSignInLine(signInId: string) {
  const s = store.signIns().find((x) => x.id === signInId);
  if (!s || !enabled.photon()) return;
  const line = await assignLine(s.phone);
  if (!store.signIns().some((x) => x.id === signInId)) return;
  store.updateSignIn(signInId, (x) => {
    if (line.assignmentId) x.photon.assignmentId = line.assignmentId;
    if (line.number) x.photon.andiNumber = line.number;
  });
}

export async function releaseSignInLine(s: { id: string; phone: string; photon: { assignmentId?: string } }) {
  if (handleInUse(s.phone, { id: s.id, role: "signIn" })) return;
  await releaseLine(s.photon.assignmentId);
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
  if (handleInUse(sponsor.phone, { id: personId, role: "sponsor" })) return;
  await releaseLine(sponsor.photon.assignmentId);
}

export async function releasePersonLines(person: { id: string; phone: string; photon: { assignmentId?: string }; sponsor?: { phone: string; photon: { assignmentId?: string } } }) {
  if (!handleInUse(person.phone, { id: person.id, role: "person" })) await releaseLine(person.photon.assignmentId);
  if (person.sponsor) await releaseSponsorLine(person.id, person.sponsor);
}

// The number a handle should text: its own assignment, else the project's configured number.
export const andiNumber = (link?: { andiNumber?: string }) => link?.andiNumber || config.photon.agentHandle || null;
