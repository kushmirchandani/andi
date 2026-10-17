// "Call your person." Two paths:
//  1. Voice: an ElevenLabs agent on a Photon number (SIP trunk, see Photon's ElevenLabs cookbook)
//     rings the sponsor and asks them to call the person right now.
//  2. Fallback: Andi texts the sponsor with a tap-to-call link and tells the person help is coming.
//
// The ElevenLabs endpoint below is ElevenLabs' outbound SIP-trunk call API
// (https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call).

import { clock } from "../clock.js";
import { config, enabled } from "../config.js";
import { fetchWithRetry, UpstreamError } from "../http.js";
import { log } from "../log.js";
import { nowIso, store } from "../store.js";
import { varsForSponsor } from "./voice.js";
import type { Person } from "../types.js";
import { pushChip } from "./engine.js";
import { sponsorTarget, textPerson, textSponsor } from "./targets.js";

export type CallVia = "voice" | "text" | "none" | "cooldown";
export const CALL_COOLDOWN_MS = 60_000;

async function voiceCall(p: Person) {
  const res = await fetchWithRetry("elevenlabs", "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call", {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabs.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: config.elevenlabs.agentId,
      agent_phone_number_id: config.elevenlabs.agentPhoneNumberId,
      to_number: p.sponsor!.phone,
      conversation_initiation_client_data: {
        // Same full variable set as inbound calls (ElevenLabs needs every variable the prompt uses).
        dynamic_variables: varsForSponsor(p, "outbound_to_sponsor"),
      },
    }),
    timeoutMs: 15_000,
    retries: 0, // never risk ringing someone twice
  });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError("elevenlabs", res.status, `ElevenLabs outbound call ${res.status}: ${text.slice(0, 200)}`);
  // Response: { success, message, conversation_id, sip_call_id }
  const body = (() => {
    try {
      return JSON.parse(text) as { success?: boolean; message?: string; conversation_id?: string };
    } catch {
      return {};
    }
  })();
  if (body.success === false) throw new UpstreamError("elevenlabs", res.status, `ElevenLabs refused the call: ${body.message ?? "unknown"}`);
  log.info("calls", `voice call placed for ${p.id} (conversation ${body.conversation_id ?? "?"})`);
}

export async function callPerson(
  personId: string,
  from: "chip" | "imessage" | "app" | "voice",
  opts: { preferText?: boolean } = {},
): Promise<{ ok: boolean; via: CallVia }> {
  const p = store.get(personId);
  if (!p) return { ok: false, via: "none" };
  if (!p.sponsor) {
    await textPerson(p, "you haven't picked your person yet. you can add someone in the andi app.");
    return { ok: false, via: "none" };
  }
  // A double tap on the chip, or "call" in iMessage right after the app button, rings once.
  const since = p.lastCallAt ? clock.now().getTime() - new Date(p.lastCallAt).getTime() : Infinity;
  if (since < CALL_COOLDOWN_MS) return { ok: true, via: "cooldown" };
  store.update(p.id, (x) => {
    x.lastCallAt = nowIso();
  });
  store.log(p.id, { kind: "call", detail: `requested from ${from}` });
  pushChip(store.must(p.id), "calling", `calling ${p.sponsor.name}`);

  if (enabled.elevenlabs() && !opts.preferText) {
    try {
      await voiceCall(p);
      await textPerson(p, `calling ${p.sponsor.name} now. stay with me, they'll ring you in a sec.`);
      return { ok: true, via: "voice" };
    } catch (err) {
      log.warn("calls", "voice call failed, falling back to text", err);
    }
  }

  if (!sponsorTarget(p)) {
    // Their person hasn't texted Andi yet, so Andi can't reach them. Give the person the number instead.
    await textPerson(p, `i can't reach ${p.sponsor.name} yet (they haven't texted me). call them directly: tel:${p.sponsor.phone}. i'm right here.`);
    return { ok: false, via: "none" };
  }
  await textSponsor(p, `${p.name} asked me to reach you. can you call them right now? tel:${p.phone}`);
  await textPerson(p, `i just asked ${p.sponsor.name} to call you. hang tight, i'm here till they do.`);
  return { ok: true, via: "text" };
}
