// Dynamic variables for the ElevenLabs voice agent. ElevenLabs requires every custom variable
// the agent's prompt uses to be present, so inbound (initiation webhook) and outbound
// (sip-trunk/outbound-call) calls always send this same full set.
// https://elevenlabs.io/docs/eleven-agents/customization/personalization

import { daysSober } from "../store.js";
import type { Person } from "../types.js";

export type VoiceVars = {
  call_mode: "inbound" | "outbound_to_sponsor";
  known_caller: boolean;
  caller_role: "person" | "sponsor" | "unknown";
  person_name: string;
  person_phone: string;
  days_sober: number;
  sponsor_name: string;
  their_why: string;
  risk_level: string;
};

const EMPTY: VoiceVars = {
  call_mode: "inbound",
  known_caller: false,
  caller_role: "unknown",
  person_name: "",
  person_phone: "",
  days_sober: 0,
  sponsor_name: "",
  their_why: "",
  risk_level: "low",
};

// Inbound call from the person's number. Caller ID can be spoofed, so this carries only what's
// safe to say to whoever is holding that number: no "why", no risk details.
export function varsForPerson(p: Person): VoiceVars {
  return {
    ...EMPTY,
    known_caller: true,
    caller_role: "person",
    person_name: p.name,
    person_phone: "",
    days_sober: daysSober(p),
    sponsor_name: p.sponsor?.name ?? "",
    their_why: "",
    risk_level: "unknown",
  };
}

// Calls with the sponsor only ever carry what the person chose to share.
export function varsForSponsor(p: Person, mode: VoiceVars["call_mode"]): VoiceVars {
  return {
    ...EMPTY,
    call_mode: mode,
    known_caller: true,
    caller_role: "sponsor",
    person_name: p.name,
    // Only on Andi's own outbound call to the sponsor (we dialed them), never to an inbound caller.
    person_phone: mode === "outbound_to_sponsor" ? p.phone : "",
    days_sober: daysSober(p),
    sponsor_name: p.sponsor?.name ?? "",
    risk_level: p.consents.shareWithSponsor === "none" ? "private" : (p.lastRisk?.level ?? "low"),
  };
}

export const varsForUnknown = (): VoiceVars => ({ ...EMPTY });
