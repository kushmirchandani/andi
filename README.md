# Andi

A recovery companion that lives in your texts. Andi notices the hard moments (a bar you marked, a liquor-store stop, a lonely Friday night), reaches out first, and gets your person on the phone when it matters. A small round chip on your nightstand shows your day count and glows with how things are going.

HackHarvard 2026 · Hardware for Good · built with Photon, Chalk, Capital One Nessie and Daytona.

| Folder | What |
| --- | --- |
| `andi/`, `andi.xcodeproj` | iOS app (SwiftUI) |
| `backend/` | Node/TypeScript service: iMessage agent, risk engine, sponsor status, chip WebSocket, voice webhooks, red team |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Setup](docs/SETUP.md) · [API](docs/API.md) · [Voice agent](docs/VOICE_AGENT.md) · [Demo runbook](docs/DEMO.md) · [Research and evidence](docs/research/) |
| `firmware/` | ESP32-S3 chip (coming next) |

Quick start, no keys needed:

```sh
cd backend && npm ci && npm run check && npm run dev
npm run smoke     # in another terminal: the whole Friday-night story
```

Then open `andi.xcodeproj`, set your signing team, and run on your iPhone (or use "try with sample data" on the welcome screen).

If you're in crisis, call or text 988.
