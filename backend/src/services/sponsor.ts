// The sponsor's "live card": one status message in their thread that Andi edits in place
// (Photon text.update) instead of sending new bubbles. It only ever shows what the person
// chose to share. Full detail lives at the consent-scoped portal: /s/<portalToken>.

import { clock } from "../clock.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { photon } from "../photon/client.js";
import { daysSober, nowIso, store } from "../store.js";
import type { Person, RiskLevel } from "../types.js";
import { sponsorTarget, textSponsor } from "./targets.js";

const STATUS: Record<RiskLevel, string> = {
  low: "steady today",
  elevated: "having a harder night",
  high: "might need a call tonight",
};

export const ALERT_COOLDOWN_MS = 2 * 3600_000;

export function portalUrl(p: Person) {
  return p.sponsor ? `${config.publicUrl}/s/${p.sponsor.portalToken}` : null;
}

export function sponsorView(p: Person) {
  const share = p.consents.shareWithSponsor;
  const level = p.lastRisk?.level ?? "low";
  return {
    name: p.name,
    day: daysSober(p),
    sharing: share,
    status: share === "none" ? null : STATUS[level],
    level: share === "none" ? null : level,
    reason: share === "status_and_reason" ? (p.lastRisk?.reasons[0] ?? null) : null,
    updatedAt: share === "none" ? null : (p.lastRisk?.at ?? null),
  };
}

function statusText(p: Person) {
  const v = sponsorView(p);
  // Not sharing: replace whatever the thread showed with a neutral line (never leave old status up).
  if (!v.status) return `${p.name} isn't sharing their status right now. i'll still reach out if they ask for you.`;
  const reason = v.reason ? `\n${v.reason.toLowerCase()}` : "";
  return `${p.name} · day ${v.day}\n${v.status}${reason}\n${portalUrl(p)}`;
}

async function sendFreshStatus(p: Person, text: string) {
  const t = sponsorTarget(p);
  if (!t) return;
  const sent = await photon.text(t, text);
  store.update(p.id, (x) => {
    if (x.sponsor) x.sponsor.photon.statusMessageId = sent.id;
  });
}

// Never throws: the sponsor's status is a side effect of risk updates, not part of them.
export async function updateSponsorStatus(p: Person) {
  const t = sponsorTarget(p);
  const text = statusText(p);
  if (!t || !text || p.sponsor?.photon.statusText === text) return;
  const existing = p.sponsor?.photon.statusMessageId;
  try {
    if (existing) {
      try {
        await photon.edit(t, existing, text);
      } catch (err) {
        // Editing can fail (e.g. the message is too old to edit): start a fresh status message.
        log.warn("sponsor", "edit failed, sending a new status message", err);
        await sendFreshStatus(p, text);
      }
    } else {
      await sendFreshStatus(p, text);
    }
    store.update(p.id, (x) => {
      if (x.sponsor) x.sponsor.photon.statusText = text;
    });
  } catch (err) {
    log.error("sponsor", `status update for ${p.id} failed`, err);
  }
}

// Account deleted or person removed: take the status message down.
export async function clearSponsorStatus(p: Person) {
  const t = sponsorTarget(p);
  const id = p.sponsor?.photon.statusMessageId;
  if (!t || !id) return;
  try {
    await photon.unsend(t, id);
  } catch (err) {
    log.warn("sponsor", "couldn't unsend the status message; editing it instead", err);
    await photon.edit(t, id, "this status is no longer active.").catch(() => undefined);
  }
}

// High-risk nudge to the sponsor. Only with consent, at most once every 2 hours.
// The cooldown is claimed before sending, so two signals arriving together alert once.
export async function maybeAlertSponsor(p: Person) {
  if (!p.sponsor || !p.consents.sponsorAlerts || !sponsorTarget(p)) return false;
  const last = p.sponsor.lastAlertAt ? new Date(p.sponsor.lastAlertAt).getTime() : 0;
  if (clock.now().getTime() - last < ALERT_COOLDOWN_MS) return false;
  const previous = p.sponsor.lastAlertAt;
  store.update(p.id, (x) => {
    if (x.sponsor) x.sponsor.lastAlertAt = nowIso();
  });
  const sent = await textSponsor(p, `heads up: ${p.name} might need a call tonight. you don't need to mention me, just reach out.`);
  if (!sent) {
    store.update(p.id, (x) => {
      if (x.sponsor) x.sponsor.lastAlertAt = previous;
    });
    return false;
  }
  store.log(p.id, { kind: "sponsor_alert", level: "high" });
  return true;
}
