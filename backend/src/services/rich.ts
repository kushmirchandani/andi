// The richer iMessage pieces on top of plain texts: image cards, voice notes in Andi's voice,
// and tapbacks. Each one is optional and best effort: if it fails or isn't configured, the
// plain text that always goes with it still carries the message.

import { milestoneCard, recapCard } from "../cards/render.js";
import { config, enabled } from "../config.js";
import { fetchWithRetry } from "../http.js";
import { log } from "../log.js";
import { photon } from "../photon/client.js";
import { localDate, store } from "../store.js";
import type { Person } from "../types.js";
import { personTarget } from "./targets.js";
import { wrapped } from "./wrapped.js";

// MARK: Image cards

/** The milestone card, sent after the milestone text. Returns true if an image went out. */
export async function sendMilestoneCard(p: Person, day: number) {
  const t = personTarget(p);
  if (!t) return false;
  const png = milestoneCard(day);
  if (!png) return false;
  try {
    await photon.image(t, png, `andi-day-${day}.png`);
  } catch (err) {
    log.error("cards", `sending the day ${day} card to ${p.id} failed`, err);
    return false;
  }
  // Day 90 also gets the recap: gentle totals only, never slips, risk, places or purchases.
  if (day === 90) {
    const w = wrapped(p);
    const recap = recapCard({ days: w.days, urgesRidden: w.urgesRidden, checkins: w.checkins, callsToYourPerson: w.callsToYourPerson });
    if (recap) await photon.image(t, recap, "andi-90-days.png").catch((err) => log.error("cards", `recap to ${p.id} failed`, err));
  }
  return true;
}

// MARK: Voice notes

/** How many voice notes this person got today (their local day). */
export function voiceNotesToday(p: Person) {
  const today = localDate(undefined, p.timezone);
  return p.events.filter((e) => e.kind === "voice_note" && localDate(new Date(e.at), p.timezone) === today).length;
}

// ElevenLabs text-to-speech -> MP3 bytes, or null.
async function speak(text: string): Promise<Buffer | null> {
  const voiceId = encodeURIComponent(config.elevenlabs.voiceId);
  const res = await fetchWithRetry("elevenlabs", `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabs.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: config.elevenlabs.ttsModel }),
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!res.ok) {
    log.warn("voicenote", `tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send `text` as a voice note in Andi's voice. The caller has already sent the same words as
 * text (so it's readable without audio). Used sparingly to save credits: milestones, and when
 * the person asks to hear Andi. Capped per person per day. Returns true if audio went out.
 */
export async function sendVoiceNote(p: Person, text: string, why: string) {
  const t = personTarget(p);
  if (!t || !enabled.tts()) return false;
  if (voiceNotesToday(p) >= config.elevenlabs.voiceNotesPerDay) {
    log.info("voicenote", `${p.id} hit today's voice-note cap; text only`);
    return false;
  }
  const words = text.trim().slice(0, 400);
  if (!words) return false;
  try {
    const audio = await speak(words);
    if (!audio) return false;
    await photon.voice(t, audio);
    store.log(p.id, { kind: "voice_note", detail: why });
    return true;
  } catch (err) {
    log.error("voicenote", `voice note to ${p.id} failed`, err);
    return false;
  }
}

// MARK: Tapbacks

/** ❤️ on one of the person's messages. Best effort. */
export async function heart(p: Person, messageId: string) {
  const t = personTarget(p);
  if (!t) return;
  await photon.react(t, messageId, "❤️").catch((err) => log.debug("andi", "tapback failed", err));
}
