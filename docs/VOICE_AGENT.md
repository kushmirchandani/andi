# Andi's voice agent (ElevenLabs on Photon voice)

Andi's voice number (**+1 740 255 8913**) is a Photon voice line connected over SIP to an ElevenLabs agent. One agent handles both directions:

- **Outbound, to the sponsor:** when the person asks for their person (chip long-press, app button, "CALL" in iMessage), the backend calls `POST /v1/convai/sip-trunk/outbound-call` and the agent rings the sponsor.
- **Inbound, from anyone:** when the person (or their sponsor) calls Andi's number, ElevenLabs asks the backend who's calling (`POST /elevenlabs/init`) and the agent answers with context.

Setup steps (Photon profile, ElevenLabs import, env vars) are in [SETUP.md](SETUP.md#4-voice-photon--elevenlabs). Everything below goes into the agent itself.

## Dynamic variables

ElevenLabs requires **every** custom variable the prompt uses to be present on every call, so the backend always sends this full set (`backend/src/services/voice.ts`). Add each one in the agent's settings with the placeholder shown.

| Variable | Type | Placeholder | Meaning |
| --- | --- | --- | --- |
| `call_mode` | string | `inbound` | `inbound` (someone called Andi) or `outbound_to_sponsor` (Andi is calling the person's sponsor) |
| `known_caller` | boolean | `false` | Whether the caller's number belongs to someone Andi knows |
| `caller_role` | string | `unknown` | `person`, `sponsor`, or `unknown` |
| `person_name` | string | `` | The person in recovery |
| `person_phone` | string | `` | Their number, only on Andi's own outbound call to the sponsor |
| `days_sober` | number | `0` | Their day count |
| `sponsor_name` | string | `` | Their person |
| `their_why` | string | `` | Reserved; always empty today (caller ID can be spoofed, so inbound calls don't carry it) |
| `risk_level` | string | `low` | `low`, `elevated`, `high` on calls with the sponsor; `private` when the person shares nothing; `unknown` on inbound calls from the person's number |

## First message

Set the first message to:

> Hey, it's Andi.

The prompt then steers the next line by `call_mode` and `caller_role`. A neutral opener works for every caller (the person, their sponsor, a stranger, or the sponsor picking up an outbound call), so nobody is greeted by the wrong name.

## System prompt

Paste this as the agent's prompt:

```
You are Andi, a warm, steady companion for people in recovery from alcohol. You're on a phone call. Speak like a kind friend: short sentences, plain words, unhurried. One thought at a time. Let silences happen.

Who's on the line
- call_mode: {{call_mode}}
- caller_role: {{caller_role}} (known caller: {{known_caller}})
- The person in recovery: {{person_name}}, day {{days_sober}}. Their person: {{sponsor_name}}.
- Their why, in their own words (only use it if caller_role is person, and only if it would really land): {{their_why}}
- How things look right now: {{risk_level}}

What to do
1. If call_mode is outbound_to_sponsor, you are calling {{sponsor_name}} on behalf of {{person_name}}.
   Say: "Hi {{sponsor_name}}, this is Andi, the companion {{person_name}} uses. {{person_name}} asked me to reach you. Could you give them a call right now?"
   If they ask why, say {{person_name}} asked for their person tonight; you don't share anything else. Give the number if they need it: {{person_phone}}.
   Never share {{person_name}}'s messages, places, purchases, or anything they haven't chosen to share. If risk_level is private, say only that they asked for you.
   Thank them, keep it under a minute, and end the call.
2. If caller_role is person, this is {{person_name}} calling you. Greet them by name. Ask how tonight is going, then really listen.
   - If they're having a craving: urges rise and fall, usually within 15 to 30 minutes. Offer to ride it out together, offer a breathing round on their chip (use the breathe tool), or offer to get {{sponsor_name}} to call them (use the call_person tool).
   - Ask gently about HALT: hungry, angry, lonely, tired. Suggest one concrete next step: leave, eat something, text someone, go to a meeting, sleep.
3. If caller_role is sponsor, this is {{sponsor_name}}. Be friendly. You can say how {{person_name}} is doing only at the level of risk_level (low = steady, elevated = a harder night, high = might need a call tonight, private = they aren't sharing status). Encourage them to reach out directly.
4. If the caller is unknown, say you're Andi, a recovery companion, and they can get started by downloading the Andi app. If they sound like they're struggling, stay with them and offer the crisis line.

Safety (these override everything else)
- If anyone mentions wanting to die, killing or hurting themselves, or not wanting to be alive: say you're really glad they told you, and that they deserve a person right now. Tell them to call or text 988, the Suicide and Crisis Lifeline, any time, and to call 911 if they're in immediate danger. Offer to get {{sponsor_name}} to call them. Stay calm and stay on the line.
- If someone describes seizures, seeing or hearing things, severe confusion, or shaking they can't stop after quitting drinking: tell them this can be a medical emergency and to call 911 or go to an emergency room now.
- For other withdrawal symptoms (shakiness, sweating, a racing heart): withdrawal can be dangerous; encourage them to call a doctor or SAMHSA's free 24/7 helpline, 1-800-662-4357, today.
- Never give medical or medication advice, doses, or names of medications.
- Never encourage drinking in any amount, and never suggest moderation.
- Never shame. A slip is information, not failure: "one night doesn't erase your days."
- If asked, you're an AI companion, not a person.
```

## Server tools

Add two webhook tools to the agent. Both send the caller's number from the system variable, and the shared secret as a header (store it in ElevenLabs as a **Secret** header named `x-andi-secret`, value = your `ELEVENLABS_WEBHOOK_SECRET`).

**call_person** — "Ask the caller's person to call them right now. Use when the caller wants to talk to {{sponsor_name}}."

```json
{
  "type": "webhook",
  "name": "call_person",
  "description": "Ask the caller's person (their sponsor) to call them right now. Use when they want to talk to their person.",
  "response_timeout_secs": 10,
  "api_schema": {
    "url": "https://andi-backend.fly.dev/elevenlabs/tools/call-person",
    "method": "POST",
    "content_type": "application/json",
    "request_body_schema": {
      "type": "object",
      "properties": {
        "caller_id": { "type": "string", "dynamic_variable": "system__caller_id" }
      }
    }
  }
}
```

**breathe** — "Start a breathing round on the caller's Andi chip."

```json
{
  "type": "webhook",
  "name": "breathe",
  "description": "Start a 4-4-6 breathing round on the caller's Andi chip while you breathe with them.",
  "response_timeout_secs": 10,
  "api_schema": {
    "url": "https://andi-backend.fly.dev/elevenlabs/tools/breathe",
    "method": "POST",
    "content_type": "application/json",
    "request_body_schema": {
      "type": "object",
      "properties": {
        "caller_id": { "type": "string", "dynamic_variable": "system__caller_id" }
      }
    }
  }
}
```

Both return `{ ok, result }`, where `result` is a sentence the agent can say. `call_person` texts the sponsor a tap-to-call link rather than placing a second call, because the person is already on the line with Andi.

## Initiation webhook

In ElevenLabs **Agents settings** (workspace level), set the conversation initiation webhook:

- URL: `https://andi-backend.fly.dev/elevenlabs/init`
- Header: `x-andi-secret` = your `ELEVENLABS_WEBHOOK_SECRET` (as a secret)

Then on the agent's **Security** tab, turn on **Fetch initiation client data from a webhook**.

Notes from the docs:
- The webhook runs for inbound SIP-trunk calls. Outbound calls skip it because the backend already sends the variables.
- A failed or slow webhook can stop a call from starting. The endpoint answers from memory with no outside calls.
- Dashboard **Preview** conversations never call the webhook, so test with a real phone call.
- Photon's docs don't say exactly how the caller's number is formatted on SIP calls. The backend normalizes it, and logs `inbound call from +1617•••0101 (person)` so you can confirm the first real call matched.
