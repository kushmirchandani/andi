# Andi architecture

Andi is a recovery companion that lives in iMessage. People text it like a friend; it notices hard moments (a bar they marked, a liquor-store purchase, a late Friday night, a lonely check-in), reaches out first, and gets their person on the phone when it matters. A small round chip on the nightstand shows their day count and glows with how things are going.

This document explains how the pieces fit, how data flows through them, and why each design choice was made. Setup steps for keys and deploys are in [SETUP.md](SETUP.md); the iOS API is in [API.md](API.md); the voice agent is in [VOICE_AGENT.md](VOICE_AGENT.md); the stage runbook is [DEMO.md](DEMO.md).

## 1. The system at a glance

```mermaid
flowchart LR
  subgraph Phone["Person's iPhone"]
    APP["Andi iOS app<br/>SwiftUI"]
    MSG["Messages<br/>(iMessage)"]
  end
  CHIP["Andi chip<br/>ESP32-S3 AMOLED"]
  SPONSOR["Their person<br/>(sponsor)"]

  subgraph Backend["Andi backend · Node 22 on Fly.io"]
    API["/api · Hono"]
    CONV["Conversation router"]
    BRAIN["Brain<br/>safety → Claude → guard"]
    ENGINE["Risk engine"]
    HUB["Chip hub<br/>WebSocket"]
    STORE[("JSON store<br/>Fly volume")]
  end

  PHOTON["Photon V2<br/>iMessage + voice"]
  CHALK["Chalk<br/>live risk score"]
  NESSIE["Capital One Nessie<br/>purchases"]
  ELEVEN["ElevenLabs<br/>voice agent"]
  CLAUDE["Claude API"]
  DAYTONA["Daytona<br/>red team + tuning"]

  APP -- "HTTPS + Bearer token" --> API
  APP -. "BLE pairing" .-> CHIP
  CHIP -- "wss /chip" --> HUB
  MSG <--> PHOTON
  SPONSOR <--> PHOTON
  PHOTON -- "Socket.IO events" --> CONV
  CONV --> BRAIN --> CLAUDE
  CONV --> ENGINE
  API --> ENGINE
  ENGINE --> CHALK
  ENGINE --> HUB
  ENGINE -- "send / edit / poll" --> PHOTON
  API --> NESSIE
  ENGINE --> STORE
  ELEVEN <-- "SIP" --> PHOTON
  ENGINE -- "outbound call" --> ELEVEN
  ELEVEN -- "webhooks" --> API
  DAYTONA -- "/agent/test" --> BRAIN
```

| Piece | Lives in | Job |
| --- | --- | --- |
| iOS app | `andi/` | Onboarding and safety screen, home (day count, glow, call / breathe / check in), risk places with geofences, settings and consent, chip pairing over Bluetooth |
| Backend | `backend/src/` | The brain. Holds the event stream from Photon, scores risk, decides when to reach out, keeps the sponsor's status current, drives the chip |
| Photon V2 | `backend/src/photon/` | Every iMessage in and out: text, edits in place, polls, tapbacks, typing, read receipts. Also the voice number (SIP to ElevenLabs) |
| Chalk | `backend/src/chalk/`, `backend/chalk/` | Serves the live risk score as features; runs the safety evaluations over red-team transcripts |
| Capital One Nessie | `backend/src/nessie/` | Purchases at alcohol sellers become a quiet signal; money not spent becomes the reward |
| ElevenLabs | `backend/src/services/calls.ts`, `routes/elevenlabs.ts` | The voice agent on Andi's number: calls the sponsor when the person asks, answers when the person calls Andi |
| Daytona | `backend/redteam/` | 18 hard-night personas in parallel sandboxes against the real brain; 500 simulated weeks to tune alert thresholds |
| Chip | ESP32-S3 (firmware later) | Glows steady / warm / alert; tap to breathe, long-press to call your person |

## 2. Design principles

1. **iMessage first.** The person never has to open an app on a hard night. The app is for setup and glanceable status; the relationship lives in Messages.
2. **Safety never depends on a model.** Crisis (988) and withdrawal-emergency (911) routing are deterministic and run *before* Claude. Every model reply passes an output guard *after*. Without a Claude key, conservative rule-based replies take over.
3. **The person decides what's shared.** Consent toggles gate every signal (location, purchases) and every sponsor-facing surface (status, reason, alerts). The sponsor never sees messages, places or coordinates.
4. **Every sponsor is optional.** Each integration has a local fallback, so the whole product runs with zero keys (dry-run mode) and degrades gracefully when a vendor is slow or down. `GET /health` shows what's live.
5. **One risk function.** The same scoring code runs live (local fallback), in Chalk (mirrored in Python, checked for parity on 5,000 random inputs), and inside Daytona sandboxes for tuning, so a "high" means the same thing everywhere.

## 3. Identity and linking

There's no password and no Sign in with Apple. The phone number is the account, and **texting Andi is the verification**.

```mermaid
sequenceDiagram
  autonumber
  participant P as Person
  participant App as iOS app
  participant B as Backend
  participant Ph as Photon (iMessage)
  App->>B: POST /api/onboard {name, phone, soberSince, screening, sponsor?, consents}
  B->>Ph: create shared-line assignments for her number and her sponsor's
  Ph-->>B: assignedPhoneNumber for each
  B-->>App: {apiToken, linkCode "482913", agentHandle (her assigned number), screening}
  Note over App: token → Keychain. If screening.medicalFirst:<br/>"talk to a doctor first" + SAMHSA button
  App->>P: "Text Andi to finish" (opens Messages with "hi andi 482913")
  P->>Ph: hi andi 482913
  Ph->>B: message.received (Socket.IO)
  B->>B: code matches pending account → link handle, store spaceId
  B->>Ph: "hey maya, it's andi…" (typing, then bubbles)
  loop every 3 s
    App->>B: GET /api/me
  end
  B-->>App: imessageLinked: true → home screen
```

Why this works:
- **Photon only delivers messages from assigned handles.** On the shared pool, each end user's handle is mapped onto a pooled line by an *assignment*, and the server allocates the number. So onboarding assigns a line for the person and for their sponsor, and the app shows each their own number. Assignments are released (freeing the seat) when an account is deleted or the sponsor changes, unless another account still uses that handle. If Photon is down at onboarding, `/api/me` retries at most once a minute until both lines exist.
- A message arriving from someone's iMessage handle proves they own it, so there's no SMS-code service to build.
- Photon's **shared line can only reply to people who text it first**, so the first text is required anyway. Linking turns that requirement into the sign-up moment.
- **The code is required.** Anyone can type anyone's number at onboarding, so a pending account links only when "hi andi <code>" arrives *from the number that was typed* (or from an iMessage email handle, which can't match a typed number). Wrong codes are limited to 5 an hour per sender. Texting from the typed number without the code doesn't link.
- **Reinstall restore.** If someone onboards again and texts the new code from a handle that already has a linked account, the backend moves the new install's token onto the existing account and drops the new one. Their days, places and person come back. Restore only happens when the pending account was created for that same number, so a 6-digit number sent in normal conversation can't hand anyone else the account.
- Codes are random (`crypto.randomInt`) and expire after 48 hours; signups that never text Andi are deleted after 48 hours and their Photon seats freed. Onboarding never deletes another pending signup. Strangers who text Andi get one friendly pointer a day; their handle is kept for two days only, to enforce that.
- App Store guideline 4.8 only requires Sign in with Apple when an app offers third-party or social login; an app using only its own sign-in is exempt. Account deletion (5.1.1(v)) is in Settings and calls `DELETE /api/me`.

The sponsor links the same way. The person taps "invite Sam" in the app, which opens Messages to Sam with a short note and Sam's Andi number; Sam texts "hi andi" once. Andi introduces itself and starts their status message.

## 4. The risk engine

Every signal funnels into one function, `evaluate(personId, trigger)` in `services/engine.ts`:

```mermaid
flowchart TB
  G["Geofence enter / exit<br/>(iOS CLMonitor or Find My)"] --> E
  N["Nessie purchase<br/>at an alcohol seller"] --> E
  C["HALT check-in<br/>(app, iMessage poll, or inferred by Claude)"] --> E
  S["Slip"] --> E
  T["Tick every 10 min<br/>(time of day, silence)"] --> E
  M["Inbound message / tapback"] --> E
  E["evaluate()<br/>per-person lock"] --> SIG["buildSignals()"]
  SIG --> CH{"Chalk online query<br/>person.risk_score / level / reasons"}
  CH -- "ok" --> R["Risk {score, level, reasons, source}"]
  CH -- "error / timeout 2.5 s<br/>(breaker opens 60 s)" --> L["Local scoreRisk()"] --> R
  R --> CHIP["Chip glow<br/>steady / warm / alert"]
  R --> STAT["Sponsor status message<br/>(edited in place)"]
  R -- "high + consent<br/>max 1 per 2 h" --> ALERT["Text the sponsor:<br/>'might need a call tonight'"]
```

### Scoring

| Signal | Points | Reason shown |
| --- | --- | --- |
| Inside a marked place, entered in the last 90 min | +30 | Near a place they marked as risky |
| Alcohol-seller purchase in the last 2 h | +40 | Recent purchase at an alcohol seller |
| …or in the last 24 h | +15 | Alcohol-seller purchase in the last day |
| 9 pm – 3 am | +10 | Late night |
| Fri/Sat after 8 pm, Sat/Sun before 3 am | +8 | Weekend night |
| Each HALT flag in the last 24 h (max 4) | +7 each | Feeling n of hungry, angry, lonely, tired |
| No check-in for over 30 h | +8 | No check-in for over a day |
| A nudge unanswered for over 12 h | +10 | Hasn't answered recent messages |
| First 30 days / first 90 days | +8 / +4 | First 30 days / First 90 days |
| Slip in the last 3 days | +12 | Slip in the last few days |

Capped at 100. **Elevated ≥ 35, high ≥ 65.** The Friday-night story: Maya (day 41) walks into the bar she marked at 11:05 pm → 30 + 10 + 8 + 4 = **52, elevated** → "do you want to be here right now?" with her safe alternative. She buys wine at the liquor store → +40 = **92, high** → her sponsor gets one heads-up text.

Daytona tuning (`npm run tune`, 500 simulated weeks across 10 sandboxes) recommends 30 / 50 for higher recall; the demo keeps 35 / 65 so the story steps cleanly from elevated to high. Present the tuning as calibration on synthetic data, not clinical validation.

### What happens on each signal

| Trigger | Andi's response |
| --- | --- |
| Enters a marked place | "looks like you're near The Rusty Anchor. do you want to be here right now?" + their safe alternative + "reply CALL or BREATHE". Not repeated for the same place within 30 min |
| Alcohol-seller purchase | "saw a stop at Square Wine & Spirits. no judgment at all. how's tonight going?" |
| Check-in (poll or app) | A reply matched to the strongest flag (lonely → offer to nudge their person) |
| Risk elevated or high on a tick | "thinking of you tonight. how are you doing, honestly?" At most every 3 h, never in quiet hours (2–9 am), and stops after two unanswered nudges |
| Milestone day (1, 3, 7, 14, 30, 60, 90, 180, 365) | One celebratory text and the chip's milestone animation, outside quiet hours |
| Risk becomes high | Sponsor status edits to "might need a call tonight"; with consent, one alert text per 2 h |

## 5. The conversation brain

**Safety runs first on every inbound text, from anyone**: before linking, before CALL/BREATHE keywords, before a sponsor's message is relayed, and for strangers. A crisis or withdrawal-emergency message gets the fixed 988 / 911 reply immediately (no typing delay), is logged, and nothing cheerful follows it (no welcome, no model reply). Check-in and slip notes typed in the app go through the same router; a crisis note gets 988 in the app and by iMessage. Matching normalizes curly apostrophes, "my self", "dont" and shorthand like "kms" before testing.

```mermaid
flowchart LR
  IN["Inbound text"] --> SAFE{"Safety router<br/>(regex, before anything else)"}
  SAFE -- "crisis" --> R988["Fixed reply now: 988, 911,<br/>offer their person"]
  SAFE -- "withdrawal emergency" --> R911["Fixed reply now: 911 / ER"]
  SAFE -- "none / warning" --> K{"Keyword?"}
  K -- "CALL" --> CALL["callPerson()"]
  K -- "BREATHE" --> BR["startBreathing()"]
  K -- "no" --> CL["Claude (claude-sonnet-5-5)<br/>forced tool call send_reply<br/>{reply, intent, halt}<br/>(+ safety note on a withdrawal warning)"]
  CL -- "error / no key" --> FB["Rule-based fallback<br/>(every hard reply offers a human)"]
  CL --> GUARD{"Output guard"}
  GUARD -- "encourages drinking /<br/>names medication" --> SAFEREPLY["Replaced with a safe reply"]
  GUARD -- "ok" --> OUT["Text back with typing indicator"]
  OUT --> ACT["intent → call / breathe / slip;<br/>halt → check-in"]
```

- The model returns structured output through a **forced tool call**, so replies never depend on parsing JSON out of prose.
- Context per turn: name, day count, their person, their why, local time, current risk and reasons, recent events, and the last 20 turns (persisted, so a redeploy doesn't wipe the conversation).
- The prompt forbids moderation advice, medical or medication advice, shame, and claiming to be human. The guard enforces the first two in code.
- The red team (`npm run redteam`) runs 18 scripted hard nights against this exact pipeline via `POST /agent/test`; the latest local run passed 18/18 on the rule-based fallback (no Claude key yet). Rerun it once `ANTHROPIC_API_KEY` is set. Transcripts feed the Chalk Evaluation (`chalk/evals/run_eval.py`).

## 6. The sponsor's view

Photon V2 has no app cards, so the sponsor's "live card" is **one status message that Andi edits in place** (`text.update`):

```
Maya · day 41
might need a call tonight
https://andi-backend.fly.dev/s/<portal token>
```

- What it shows is set by the person: `none` (nothing), `status` (default), or `status_and_reason` (adds the top reason).
- The link opens a portal (`/s/:token`) with the same consent-scoped view, a "Call Maya" button, and the 988 line. It is never cached, indexed, or sent as a Referer.
- If the person asks for help (app button, chip long-press, "CALL" in iMessage, or Claude hears it), Andi either rings the sponsor through the voice agent or texts them a tap-to-call link. Repeated requests within a minute ring once.
- Sponsors can text encouragement back; Andi passes it along, clearly attributed ("from Sam: …"), after the same output guard as Andi's own replies. Someone who is the person for two Andi users starts with a name ("Ben: proud of you"). A sponsor who also uses Andi is still linked as someone's person.
- Turning sharing to "none" edits the status to a neutral line; deleting the account or changing the person unsends it, and a new person always gets a new portal link.

## 7. Voice: "call your person" and calling Andi

```mermaid
sequenceDiagram
  autonumber
  participant P as Person
  participant B as Backend
  participant EL as ElevenLabs agent
  participant Ph as Photon voice (+1 740 255 8913)
  participant S as Sponsor
  P->>B: chip long-press / app button / "CALL"
  B->>EL: POST /v1/convai/sip-trunk/outbound-call<br/>{agent_id, agent_phone_number_id, to_number: sponsor,<br/>dynamic_variables: person_name, days_sober…}
  EL->>Ph: SIP INVITE (TLS, sip.photon.codes:5061)
  Ph->>S: rings from Andi's number
  EL->>S: "Hi Sam, this is Andi. Maya asked me to reach you…"
  B->>P: iMessage: "calling Sam now. stay with me."
  Note over B: If voice isn't configured or fails:<br/>text Sam a tel: link instead
```

Inbound: when the person calls Andi's number, Photon routes the call over SIP to ElevenLabs, ElevenLabs asks `POST /elevenlabs/init` who's calling, and Andi answers knowing their name, day count and person. Caller ID can be spoofed, so inbound calls never carry the person's "why" or risk details. During a call the agent can use two server tools: `call-person` (texts their person to call, since a second voice call would collide) and `breathe` (starts a round on the chip). Details and the agent prompt are in [VOICE_AGENT.md](VOICE_AGENT.md).

Note from Photon's docs: shared iMessage assignments don't support voice, so voice runs on its own voice-capable number.

## 8. Location: geofences, not tracking

```mermaid
flowchart LR
  A["Person marks a place<br/>(name, radius 100–500 m in the app,<br/>safe alternative)"] --> B["POST /api/places"]
  B --> C["iOS CLMonitor<br/>CircularGeographicCondition<br/>(max 20)"]
  C -- "enter / exit" --> D["POST /api/location<br/>{placeId, event}"]
  D --> E["onPlaceEnter()"]
  F["Optional: Find My via Photon<br/>Advanced iMessage SDK"] -- "server-side geofence check;<br/>coordinates never stored" --> E
```

- The only thing that leaves the phone is "arrived at place X" or "left place X". Coordinates of the person are never sent.
- iOS relaunches the app in the background for geofence events; the app model is created at launch so the monitor resumes before any screen exists.
- A newly added place starts as "inside", so marking a bar while standing in it doesn't trigger "do you want to be here?".
- Find My (optional) uses Photon's Advanced iMessage SDK: Andi sends a location-sharing request card; once accepted, the watcher checks geofences on the server and keeps only inside/outside state in memory. Missed updates during a disconnect aren't replayed, so it re-reads the list on reconnect.

## 9. Purchases and money saved (Nessie)

- At onboarding the person estimates their weekly drink spend; money saved = weekly spend ÷ 7 × days sober − alcohol purchases since.
- A purchase at a merchant whose name or category looks like an alcohol seller (liquor, wine, spirits, beer, bar, pub, tavern…) feeds the risk engine, only with the `purchases` consent.
- The demo creates a real Nessie customer, checking account, merchant and purchase. The client accepts both create-response shapes (an `objectCreated` id, or the plain string the current spec documents, in which case it looks the record up) and reuses merchants by name.

## 10. The chip

```mermaid
sequenceDiagram
  autonumber
  participant App
  participant Chip as Chip (BLE "Andi Chip")
  participant B as Backend
  App->>B: POST /api/chip/pair
  B-->>App: {chipToken, wsUrl: wss://…/chip?token=…}
  App->>Chip: scan for service A11D0001-…, connect
  App->>Chip: subscribe to status A11D0003
  App->>Chip: write config A11D0002 {"ssid","password","ws"}
  Chip-->>App: notify {"state":"wifi_connecting"} … {"state":"wifi_ok"}
  Chip->>B: WebSocket connect with token
  Chip-->>App: notify {"state":"ws_ok"} → paired
  B->>Chip: {"type":"state","day":41,"glow":"warm","mode":"idle","saved":1406}
  Chip->>B: {"type":"tap"} → breathing round
  Chip->>B: {"type":"long_press"} → call your person
```

- The server pings every 25 s and drops silent chips, so "online" in the app stays true. A new pairing token stays *pending* until a chip connects with it; only then is the old chip retired, so a failed pairing never knocks a working chip offline.
- Wi-Fi credentials and the chip token cross Bluetooth once; the firmware should require an encrypted (bonded) write on the config characteristic.
- Taps are debounced (3 s) so a bouncy button can't ring the sponsor twice.
- Firmware note: flags + the 128-bit service UUID + the name "Andi Chip" exceed the 31-byte advertising packet. Keep the UUID in the advertisement and move the name to the scan response.

## 11. Reliability

| Concern | How it's handled |
| --- | --- |
| Photon event stream drops | Socket.IO reconnects (including after a server-side disconnect); a rejected subscribe retries with backoff; we resume from the saved cursor, which only advances after an event is handled. If the stream is down over 5 minutes, `/health` returns 503 so Fly restarts the machine |
| One bad event | Retried up to 3 times across reconnects, then logged and skipped so the stream can't wedge |
| Backpressure | Over 128 queued deliveries, the connection is dropped and resumed from the cursor |
| Duplicate sends on retry | Photon sends carry an Idempotency-Key; retries reuse it |
| Chalk slow or down | 2.5 s timeout, then local scoring; a circuit breaker skips Chalk for 60 s after a failure |
| Time zones | The app sends its IANA zone at onboarding and on every request (`X-Timezone`); day counts, late-night signals and quiet hours use the person's zone |
| Two signals at once | `evaluate()` runs under a per-person lock; the sponsor alert's cooldown is claimed before sending |
| Vendor errors in a flow | Sends never throw into the API; a failed text is logged and the request still succeeds |
| Deploys | SIGTERM stops the stream, closes chips, flushes the store, exits. Writes are temp-file + fsync + rename |
| Corrupt store | Moved aside on boot instead of crashing |
| Abuse | Rate limits on onboarding (per IP) and on every authenticated route (per person); body size limits |

## 12. Data and privacy

```mermaid
erDiagram
  PERSON ||--o{ PLACE : marks
  PERSON ||--o{ CHECKIN : logs
  PERSON ||--o{ EVENT : "event log (last 500)"
  PERSON ||--o{ PURCHASE : "alcohol purchases (consented)"
  PERSON ||--o{ CHAT_TURN : "last 20 turns"
  PERSON ||--o| SPONSOR : "their person"
  PERSON {
    string id
    string name
    string phone "iMessage handle"
    date soberSince
    string apiToken
    string linkCode "until linked"
    json screening
    json consents
    json lastRisk
    string chipToken
    string whyText
  }
  SPONSOR {
    string name
    string phone
    string portalToken
    string statusMessageId
  }
  PLACE {
    string id
    string name
    float lat
    float lng
    float radiusM
    string kind
    string alternative
  }
```

- Stored in one JSON file on a Fly volume (fine for a hackathon and a pilot; swap for Postgres before scale).
- Never stored: the person's coordinates or raw Find My locations. Strangers who text Andi: only their handle, for two days, to limit replies to one a day.
- Logs mask phone numbers and never include tokens, query strings, or message bodies at the default log level.
- `DELETE /api/me` removes the person, their places, check-ins, chat history, voice memo and chip token.

## 13. Deployment

```mermaid
flowchart LR
  DEV["npm run dev<br/>(dry-run, no keys)"] --> TEST["npm run check<br/>typecheck + 76 tests<br/>npm run parity"]
  TEST --> FLY["fly deploy<br/>1 always-on machine, bos<br/>volume andi_data → /data"]
  FLY --> HEALTH["/health<br/>sponsor status"]
```

- Andi holds two long-lived connections (Photon's event stream, the chips' WebSockets), so it runs as one always-on process, not serverless. `fly.toml` keeps one machine running with auto-stop off.
- Secrets are Fly secrets; everything is listed in `backend/.env.example`.
- Demo and red-team routes are off in production unless `DEMO_KEY` / `AGENT_TEST_KEY` are set.

## 14. Repository layout

```
andi/                    iOS app (SwiftUI; file-system synchronized groups)
  Core/                  Models, APIClient, AppModel, LocationMonitor, ChipLink, Keychain, MockData
  UI/                    Theme, Components, Onboarding, Home, CheckIn, Breathe, Places, Settings
andi.xcodeproj
backend/
  src/
    app.ts index.ts      HTTP app; boot, background work, graceful shutdown
    routes/              api (iOS), demo, sponsor portal, agentTest (red team), elevenlabs (voice webhooks)
    services/            conversation, engine, sponsor, calls, voice, targets, wrapped
    agent/               safety, prompt, brain
    risk/                score (the one risk function), signals
    photon/ chalk/ nessie/ findmy/ chip/
    store.ts http.ts log.ts config.ts clock.ts types.ts
  chalk/                 features.py (Chalk resolver), evals/, parity/
  redteam/               personas, scorers, Daytona runner, threshold tuning
  test/                  node:test suites (in-process app, mocked vendors)
  scripts/smoke.sh       the Friday-night story end to end
docs/                    this documentation; research/ holds the vendor-doc verification and evidence catalog
firmware/                (next) ESP32-S3 chip, PlatformIO
```
