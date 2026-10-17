# Backend API

Base URL: `https://andi-backend.fly.dev` (or `http://localhost:8080`). JSON in and out.

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

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/onboard` | `{name, phone, soberSince: "YYYY-MM-DD", weeklyDrinkSpend, screening: {drinksPerDay, drinksDaily, morningDrinking, pastWithdrawal}, sponsor?: {name, phone}, consents?, why?, timezone?}` | `{apiToken, screening: {medicalFirst, message}, agentHandle, voiceNumber, firstText, linkCode, me}` |
| GET | `/api/me` | | `Me` |
| DELETE | `/api/me` | | 204. Deletes everything |
| PUT | `/api/consents` | `Consents` | `Me` |
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
| POST | `/api/breathe` | | `{ok}` |
| POST | `/api/slip` | `{note?}` | `{risk, safety, message}` (`message` is the crisis reply when `safety` is set) |
| GET | `/api/risk` | | `Risk` (re-scores now) |
| GET | `/api/wrapped` | | Andi Wrapped stats |
| GET | `/api/events` | | Last 100 events, newest first |
| POST | `/api/chip/pair` | | `{chipToken, wsUrl}`. The token is pending until a chip connects with it |
| DELETE | `/api/chip` | | `Me` |

### Types

```ts
Me {
  id, name, day: number, soberSince, moneySaved: number,
  risk: Risk | null, consents: Consents, places: Place[],
  sponsor: { name, phone, linked: boolean, andiNumber: string | null } | null,
  imessageLinked: boolean,
  agentHandle: string | null,     // the number THIS person texts (their Photon line)
  voiceNumber: string | null,     // Andi's voice number
  chipPaired: boolean, chipOnline: boolean, medicalFirst: boolean,
  portalUrl: string | null,       // the sponsor's portal
  linkCode: string | null,        // until linked
  why: string | null, hasWhyAudio: boolean, findMyAvailable: boolean
}
Consents { location: boolean, purchases: boolean, shareWithSponsor: "none" | "status" | "status_and_reason", sponsorAlerts: boolean }
Risk { score: number, level: "low" | "elevated" | "high", reasons: string[], source: "chalk" | "local", at?: string }
Place { id, name, lat, lng, radiusM, kind, alternative? }
```

## Sponsor portal

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/s/:portalToken` | HTML status page (auto-refreshes every 30 s) |
| GET | `/s/:portalToken/status.json` | `{name, day, sharing, status, level, reason, updatedAt}`; fields the person doesn't share are `null` |

## Chip WebSocket

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

## Demo and testing (`/demo`, header `x-demo-key`)

Off in production unless `DEMO_KEY` is set.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/demo/seed` | `{name?, phone?, sponsorName?, sponsorPhone?, days?}` | Maya, day 41, sponsor Sam, The Rusty Anchor. Creates Photon line assignments and a Nessie account when configured |
| POST | `/demo/clock` | `{iso}` or `{iso: null}` | Pin "now" (e.g. Friday 11:05 pm) |
| POST | `/demo/inbound` | `{from, text?}` / `{from, pollVote: [...]}` / `{from, reaction}` | Simulate an iMessage arriving; returns Andi's replies |
| GET / DELETE | `/demo/outbox` | | What Andi sent (or would have, in dry-run) |
| POST | `/demo/place-enter` | `{personId?}` | Enter the first risk place |
| POST | `/demo/purchase` | `{amount?, merchant?}` | Liquor-store purchase (real Nessie purchase when configured) |
| POST | `/demo/checkin-poll` | | Send the HALT poll |
| POST | `/demo/advance` | `{days}` | Move the sober date back, run a tick, return Wrapped |
| POST | `/demo/tick` | | Run the 10-minute job now |
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

`GET /health` (200, or 503 when the Photon stream has been down over 5 minutes) → `{ok, version, uptimeS, people, chipsOnline, sponsors: {photon: dry-run | connecting | subscribed | disconnected, chalk: local | live | "degraded (local fallback)", nessie, anthropic, elevenlabs, findMy}, photon: {cursor, lastEventAt}}`
