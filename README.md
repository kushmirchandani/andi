# Andi

A recovery companion that lives in your texts. Andi notices the hard moments (a bar you marked, a liquor-store stop, a lonely Friday night), reaches out first, and gets your person on the phone when it matters.

HackHarvard 2026 · built with Photon, Chalk, Capital One Nessie, Daytona and the Factory Droid SDK.

| Folder | What |
| --- | --- |
| `andi/`, `andi.xcodeproj` | iOS app (SwiftUI) |
| `backend/` | Node/TypeScript service: iMessage agent, risk engine, sponsor status, voice webhooks, red team |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Paused: the chip](docs/PAUSED.md) · [Setup](docs/SETUP.md) · [API](docs/API.md) · [Voice agent](docs/VOICE_AGENT.md) · [Demo runbook](docs/DEMO.md) · [Research and evidence](docs/research/) |

**Paused:** the Andi chip (hardware) is switched off. Its code stays behind `FEATURE_CHIP`; everything it did (call your person, breathe) works from the app, iMessage and Andi's phone line. See [docs/PAUSED.md](docs/PAUSED.md).

## Where and how Droid is used (Factory Droid SDK)

Andi's crisis safety layer gets safer every night, and a person approves every change.

1. **Find.** The Daytona red team is LLM-driven: each night Claude writes fresh hard-night scenarios across 16 failure categories, plays each person turn by turn against the live brain, and an LLM judge grades every conversation on a 10-point safety rubric (backed by a deterministic floor it can't overrule; 18 scripted personas also rerun as a regression baseline). Any message the judge flags as misrouted becomes a candidate gap. A **read-only Droid gap hunter** (`backend/droid/gaps.ts`, `run()` with structured output) is handed the router and writes realistic messages it predicts will be misrouted: indirect suicidal language, withdrawal emergencies, and idioms that falsely trigger. Every candidate is re-checked against the real router, and only real misses count.
2. **Fix.** In a throwaway copy of the backend, a **Droid fix session** (`backend/droid/autofix.ts`, `AutonomyLevel.Low` + a `permissionHandler`) adds each miss to the safety corpus (the regression test) and edits the router's patterns until the corpus passes. Its permission handler only lets it touch `src/agent/safety.ts` and `src/agent/safety-corpus.ts` and run the test commands.
3. **Verify, independently.** The Droid never grades itself: `droid/verify.ts` re-routes every gap and the whole corpus, then the typecheck and the full test suite run. Any edit outside the two files rejects the run.
4. **Hand off.** A patch, a report and a pull-request body land in `backend/redteam/results/autofix/<run>/`. Nothing reaches the live code until a person applies it. A nightly workflow (`docs/ci/nightly-safety.yml`) runs the loop and opens the pull request.

```sh
cd backend
npm run autofix                                          # hunt + red-team failures -> fix -> verify -> patch
npm run autofix -- --gaps droid/examples/tonight.json    # fix a given list of misses
npm run autofix:selftest                                 # the pipeline with a stand-in for the Droid (no key)
```

Needs `FACTORY_API_KEY` and the `droid` CLI (`curl -fsSL https://app.factory.ai/cli | sh`). Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#14-the-nightly-safety-loop-factory-droid).

## Quick start, no keys needed

```sh
cd backend && npm ci && npm run check && npm run dev
npm run smoke     # in another terminal: the whole Friday-night story
```

Then open `andi.xcodeproj`, set your signing team, and run on your iPhone (or use "try with sample data" on the welcome screen).

If you're in crisis, call or text 988.
