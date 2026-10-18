# Andi backend

The brain behind Andi: the iMessage agent (Photon V2), the risk engine (Chalk, with a local fallback), purchase signals (Capital One Nessie), the sponsor's status message and portal, the (paused) chip's WebSocket, the voice agent's webhooks (ElevenLabs on Photon voice), and the Daytona red team and threshold tuning.

Every integration is optional. With no keys the server runs in **dry-run mode**: iMessages go to an in-memory outbox instead of Photon, risk is scored locally, and Andi uses conservative rule-based replies. `GET /health` shows what's live.

```sh
npm ci
npm run check        # typecheck + tests (no network)
npm run dev          # http://localhost:8080, loads .env if present
npm run smoke        # the Friday-night story end to end against a running server
npm run parity       # Chalk resolver vs TypeScript scorer on 5,000 random inputs
npm run redteam      # 18 hard-night personas (Daytona, or -- --local)
npm run tune         # 500 simulated weeks to tune alert thresholds (Daytona, or -- --local)
npm run gym          # Andi Gym: practice, coach the playbook, A/B exam, promote only if more helpful AND no safety regression
npm run gym:smoke    # a tiny local Andi Gym night (see docs/ARCHITECTURE.md section 15; scoreboard at GET /gym)
```

Docs live in [`../docs`](../docs):

- [ARCHITECTURE.md](../docs/ARCHITECTURE.md): how it all fits, with diagrams
- [SETUP.md](../docs/SETUP.md): turning each sponsor on, deploying to Fly, running the app
- [API.md](../docs/API.md): every route
- [VOICE_AGENT.md](../docs/VOICE_AGENT.md): the ElevenLabs agent prompt, variables and tools
- [DEMO.md](../docs/DEMO.md): the stage runbook
- [research/](../docs/research): what each vendor's docs say, with sources

## Layout

```
src/
  index.ts            boot: listeners, Photon stream, Find My watcher, 10-minute tick, graceful shutdown
  app.ts              the Hono app (routes, error shape, health); tests drive it in-process
  routes/             api (iOS), demo, sponsor portal, agentTest (red team), elevenlabs (voice webhooks)
  services/           conversation (inbound iMessage), engine (risk + outreach), sponsor, calls, voice, lines, targets, wrapped
  agent/              safety (deterministic crisis/withdrawal routing + output guard), prompt, brain (Claude)
  risk/               score.ts (the one risk function), signals.ts
  photon/             client (send/edit/poll/typing/read), events (Socket.IO stream), lines (shared-line assignments)
  chalk/ nessie/ findmy/ chip/
  store.ts            JSON store with migrations, atomic writes, per-person locks
  http.ts log.ts config.ts clock.ts types.ts
chalk/                features.py (Chalk resolver), evals/ (safety scorers + Chalk Evaluation runner), parity/
redteam/              personas, scorers, Daytona runner, tuning
gym/                  Andi Gym: nightly self-coaching of src/agent/playbook.ts (history.json feeds GET /gym)
test/                 node:test suites; vendors are mocked at fetch
scripts/smoke.sh
```
