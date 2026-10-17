import { photon, type Target } from "../photon/client.js";
import { log } from "../log.js";
import { nowIso, store } from "../store.js";
import type { Person } from "../types.js";

// A shared Photon line can only text people who have texted it first, so we learn each
// person's space + agent user from their first inbound message.
export function personTarget(p: Person): Target | null {
  return p.photon.spaceId && p.photon.agentUserId ? { spaceId: p.photon.spaceId, senderId: p.photon.agentUserId } : null;
}

export function sponsorTarget(p: Person): Target | null {
  const s = p.sponsor?.photon;
  return s?.spaceId && s.agentUserId ? { spaceId: s.spaceId, senderId: s.agentUserId } : null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Typing delay before each bubble, so Andi reads like a person texting. TYPING_DELAY=0 in tests.
const typingDelay = (text: string) => {
  const scale = process.env.TYPING_DELAY === "0" ? 0 : 1;
  return scale * Math.min(2200, 500 + text.length * 18);
};

// Text the person like a human would: typing indicator, a beat, then each bubble.
// Never throws: a failed send is logged and the flow continues (the app still works).
export async function textPerson(p: Person, ...bubbles: string[]): Promise<string[]> {
  const t = personTarget(p);
  if (!t) {
    log.info("andi", `${p.id} hasn't texted Andi yet; skipped ${bubbles.length} message(s)`);
    return [];
  }
  const ids: string[] = [];
  try {
    for (const text of bubbles) {
      await photon.typing(t, true);
      await pause(typingDelay(text));
      const sent = await photon.text(t, text);
      if (sent.id) ids.push(sent.id);
    }
  } catch (err) {
    log.error("andi", `sending to ${p.id} failed`, err);
  } finally {
    await photon.typing(t, false);
  }
  if (ids.length && store.get(p.id)) {
    store.update(p.id, (x) => {
      x.photon.lastOutboundAt = nowIso();
    });
  }
  return ids;
}

export async function textSponsor(p: Person, text: string): Promise<{ id?: string } | null> {
  const t = sponsorTarget(p);
  if (!t) {
    log.info("andi", `sponsor for ${p.id} hasn't texted Andi yet; skipped a message`);
    return null;
  }
  try {
    return await photon.text(t, text);
  } catch (err) {
    log.error("andi", `sending to sponsor of ${p.id} failed`, err);
    return null;
  }
}
