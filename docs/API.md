# Backend API

Base URL: `https://andi-tdc-backend.fly.dev` (or `http://localhost:8080`). JSON in and out.

**Auth:** every `/api/*` route except `POST /api/onboard` needs `Authorization: Bearer <apiToken>`. The app also sends `X-Timezone: <IANA zone>`; the server keeps the person's zone up to date from it.

**Errors** always look like this, and `message` is safe to show to the person:

```json
{ "error": "invalid_request", "message": "Your start date can't be in the future." }
```

| Code | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | Validation failed (`issues[]` lists each field) or the body isn't JSON |
| `unauthorized` | 401 | Missing or unknown token. The app signs out |
| `not_found` | 404 | Unknown route or record |
| `conflict` | 409 | e.g. a 21st place, or Find My not set up |
| `too_large` | 413 | Voice memo over 5 MB |
| `rate_limited` | 429 | Over the limit (`retry-after` header). Onboarding: 20/hour per IP. Everything else: 120/min per person |
| `upstream_unavailable` | 503 | A vendor call the request depends on failed |
| `server_error` | 500 | Bug. Logged |

## iOS app (`/api`)

Sign-in: the app's first screen sends the number to `POST /api/signin` and shows "text andi" with `firstText linkCode`. The response never says whether the number has an account. When the code arrives from that number, Andi replies in Messages and `GET /api/signin` moves on: `signed_in` (an existing account now uses `signInToken`; other installs get 401) or `verified` (no account: `POST /api/onboard` with `signInToken` creates it already linked). "Skip for now" also onboards with `signInToken`; the account stays pending with the same `linkCode` until the person texts it.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/signin` | `{phone}` | `{signInToken, linkCode, firstText, agentHandle}`. Identical for every number. No auth. 20/hour per IP |
| GET | `/api/signin` | (Bearer `signInToken`) | `{state: waiting \| verified \| signed_in}`. 401 when expired (48 h) |
| POST | `/api/onboard` | `{name, signInToken?, phone?, soberSince: "YYYY-MM-DD", weeklyDrinkSpend, screening: {drinksPerDay, drinksDaily, morningDrinking, pastWithdrawal}, sponsor?: {name, phone}, consents?, why?, timezone?}` | `{apiToken, screening: {medicalFirst, message}, agentHandle, voiceNumber, firstText, linkCode, me}` |
| POST | `/api/signout` | | 204. Retires this token; the account stays |
| GET | `/api/me` | | `Me` |
| DELETE | `/api/me` | | 204. Deletes everything |
| PUT | `/api/consents` | `Consents` | `Me` |
| PUT | `/api/quiet-hours` | `QuietHours` | `Me` |
| PUT | `/api/sponsor` | `{name, phone}` | `Me`. Same number keeps the iMessage link |
| DELETE | `/api/sponsor` | | `Me` |
| GET | `/api/places` | | `[Place]` |
| POST | `/api/places` | `{name, lat, lng, radiusM (50–2000, default 150), kind: bar \| liquor_store \| other, alternative?}` | `Place` (201). Max 20 |
| DELETE | `/api/places/:id` | | 204 |
| POST | `/api/location` | `{placeId, event: enter \| exit}` | `{risk}` (`null` if location consent is off) |
| POST | `/api/findmy/request` | | `{ok, receipt}` |
| POST | `/api/checkin` | `{hungry, angry, lonely, tired, mood?: 1–5, note?}` | `{risk, safety}`. `safety` is `{kind, message}` when the note needs crisis guidance, else `null` |
| POST | `/api/why` | `{text}` or an `audio/*` body | `{ok}` |
| GET | `/api/why/audio` | | `audio/mp4` |
| POST | `/api/call` | | `{ok, via: voice \| text \| none \| cooldown}` |
| POST | `/api/breathe` | | `{ok}`. Logs a round; the app's breathing screen calls it |
| POST | `/api/slip` | `{note?}` | `{risk, safety, message}` (`message` is the crisis reply when `safety` is set) |
| GET | `/api/risk` | | `Risk` (re-scores now) |
| GET | `/api/wrapped` | | Andi Wrapped stats |
| GET | `/api/events` | | Last 100 events, newest first |
| POST | `/api/chip/pair` | | *Paused (404 `feature_off` unless `FEATURE_CHIP=1`).* `{chipToken, wsUrl}`. The token is pending until a chip connects with it |
| DELETE | `/api/chip` | | `Me`. *Paused like pairing.* |

### Types

```ts
Me {
  id, name, day: number, soberSince, moneySaved: number,
  risk: Risk | null, consents: Consents, quietHours: QuietHours, places: Place[],
  sponsor: { name, phone, linked: boolean, andiNumber: string | null } | null,
  imessageLinked: boolean,
  agentHandle: string | null,     // the number THIS person texts (their Photon line)
  voiceNumber: string | null,     // Andi's voice number
  features: { chip: boolean },   // false while the chip is paused; the app hides its section
  chipPaired: boolean, chipOnline: boolean, medicalFirst: boolean,
  portalUrl: string | null,       // the sponsor's portal
  linkCode: string | null,        // until linked
  why: string | null, hasWhyAudio: boolean, findMyAvailable: boolean,
  patterns: Patterns              // what Andi has learned from their own history
}
Patterns {                        // all null / 0 until ready (about 2 weeks and 6 hard moments)
  ready: boolean,
  riskyWindow: { weekday: 0-6 | null, startHour: 0-23, hours: number, label: string } | null,  // weekday null = most days; label e.g. "friday 8pm–11pm"
  whatHelped: { kind: "walk" | "breathe" | "call" | "meeting" | "talk" | "workout" | "music", label: string } | null,  // label e.g. "a walk"
  topTrigger: { kind: "hungry" | "angry" | "lonely" | "tired" | "places", label: string } | null,
  confidence: number              // 0-100
}
Consents { location: boolean, purchases: boolean, shareWithSponsor: "none" | "status" | "status_and_reason", sponsorAlerts: boolean }
QuietHours { enabled: boolean, start: 0-23, end: 0-23 }  // local hours, end exclusive, may wrap midnight; server default until set
Risk { score: number, level: "low" | "elevated" | "high", reasons: string[], source: "chalk" | "local", at?: string }
Place { id, name, lat, lng, radiusM, kind, alternative? }
```

## Sponsor portal

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/s/:portalToken` | HTML status page (auto-refreshes every 30 s) |
| GET | `/s/:portalToken/status.json` | `{name, day, sharing, status, level, reason, updatedAt}`; fields the person doesn't share are `null` |

## Chip WebSocket (paused)

Refused while `FEATURE_CHIP` is off. Kept for when the chip comes back.

`wss://<host>/chip?token=<chipToken>`

- Server → chip: `{"type":"state","day":41,"glow":"steady"|"warm"|"alert","mode":"idle"|"breathing"|"calling"|"milestone","saved":1406,"line":"…"}` (sent on connect and on every change)
- Chip → server: `{"type":"hello"}`, `{"type":"tap"}` (breathe), `{"type":"long_press"}` (call your person)
- Server pings every 25 s. Close code 4001 means the chip was unpaired or re-paired.

## Voice webhooks (`/elevenlabs`, header `x-andi-secret`)

| Path | Called by | Returns |
| --- | --- | --- |
| POST `/elevenlabs/init` | ElevenLabs, inbound calls | `{type: "conversation_initiation_client_data", dynamic_variables}` |
| POST `/elevenlabs/tools/call-person` | Agent tool | `{ok, result}` |
| POST `/elevenlabs/tools/breathe` | Agent tool | `{ok, result}` |

## Nessie webhook (`/nessie`, header `Nessie-Signature`)

| Path | Called by | Returns |
| --- | --- | --- |
| POST `/nessie/webhook` | Nessie v2 notify hook (`transaction.created`), registered by the server on boot | `{ok, result: "alcohol_purchase" \| "not_alcohol" \| "unknown_account" \| "ignored" \| "duplicate"}`; 401 on a bad signature |

## Demo and testing (`/demo`, header `x-demo-key`)

Off in production unless `DEMO_KEY` is set.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/demo/seed` | `{name?, phone?, sponsorName?, sponsorPhone?, days?}` | Maya, day 41, sponsor Sam, The Rusty Anchor. Creates Photon line assignments and a Nessie account when configured |
| POST | `/demo/clock` | `{iso}` or `{iso: null}` | Pin "now" (e.g. Friday 11:05 pm) |
| POST | `/demo/inbound` | `{from, text?}` / `{from, pollVote: [...]}` / `{from, reaction}` | Simulate an iMessage arriving; returns Andi's replies |
| GET / DELETE | `/demo/outbox` | | What Andi sent (or would have, in dry-run). Images and voice notes show `file: {contentType, sizeBytes, filename}`, never the bytes |
| GET | `/demo/card/:kind` | `?day=30` | Preview an iMessage image card as PNG: `milestone`, `recap` or `avatar` |
| POST | `/demo/place-enter` | `{personId?}` | Enter the first risk place |
| POST | `/demo/purchase` | `{amount?, merchant?}` | Liquor-store purchase (real Nessie purchase when configured) |
| POST | `/demo/checkin-poll` | | Send the HALT poll |
| POST | `/demo/advance` | `{days}` | Move the sober date back, run a tick, return Wrapped |
| POST | `/demo/tick` | | Run the 10-minute job now |
| POST | `/demo/seed-history` | `{personId?, weeks?}` | **Demo data.** Writes 2–8 weeks of synthetic history (Friday evenings are hard, a walk helps), re-learns patterns, and returns them with `nudgeAt` (pin the clock there, then tick, to see Andi's pre-window text) and `nudgePreview` |
| GET | `/demo/state` | `?personId=` | Raw person record |
| GET | `/demo/chip` | | Chip online + last state |
| POST | `/demo/reset` | | Delete everyone, unpin the clock |

## Red team (`POST /agent/test`, header `x-test-key`)

Stateless: same brain and safety layer as production; nothing is sent or stored.

```json
{ "persona": { "name": "Maya", "daysSober": 41, "sponsorName": "Sam", "riskLevel": "elevated", "localTime": "Friday 11:05 PM" },
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "message": "i'm outside the bar" }
```
Returns `{reply, intent, halt, route: crisis | withdrawal_emergency | model | fallback, guarded}`.

## Health

`GET /health` (200, or 503 when the Photon stream has been down over 5 minutes) → `{ok, version, uptimeS, people, features: {chip}, chipsOnline, sponsors: {photon: dry-run | connecting | subscribed | disconnected, chalk: local | live | "degraded (local fallback)", nessie: false | "api" | "webhook", anthropic, elevenlabs, findMy}, photon: {cursor, lastEventAt}}`
