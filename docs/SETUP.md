# Setup: from zero to a live Andi

Everything runs today with **no keys** (dry-run mode). Each section below turns one integration on. Do them in any order; `GET /health` shows what's live. All variables live in `backend/.env` locally and as Fly secrets in production (full list: `backend/.env.example`).

Checklist:

- [ ] 1. Run it locally
- [ ] 2. Deploy to Fly
- [ ] 3. Photon iMessage
- [ ] 4. Voice (Photon + ElevenLabs)
- [ ] 5. Claude
- [ ] 6. Chalk
- [ ] 7. Capital One Nessie
- [ ] 8. Daytona
- [ ] 9. iOS app on your phone
- [ ] 10. Optional: Find My
- [ ] 11. Factory Droid (nightly safety autofix)

## 1. Run it locally

```sh
cd backend
npm ci              # on your Mac (the node_modules there were installed from a Linux shell)
npm run check       # typecheck + 76 tests, no network
npm run dev         # http://localhost:8080, dry-run
npm run smoke       # in a second terminal: the whole Friday-night story
```

`npm run smoke` seeds Maya, simulates her and Sam texting Andi, walks into the bar, buys wine, texts "i really want a drink" and "CALL", then prints everything Andi would have sent. In dry-run, outbound iMessages go to an in-memory outbox (`GET /demo/outbox`) instead of Photon.

To simulate a text from anyone: `POST /demo/inbound {"from": "+1617…", "text": "hi andi 482913"}` with header `x-demo-key`. This is how you can finish the app's "text Andi" step before Photon is set up.

## 2. Deploy to Fly

Fly isn't a HackHarvard sponsor, but it's the simplest always-on host for a process that holds a long-lived connection (Photon's event stream).

The app is `andi-tdc-backend` in `iad`, with its `andi_data` volume and public IPs already set up. To redeploy and set the basics:

```sh
cd backend
fly secrets set PUBLIC_URL=https://andi-tdc-backend.fly.dev DEMO_KEY=$(openssl rand -hex 16) AGENT_TEST_KEY=$(openssl rand -hex 16)
fly deploy
curl https://andi-tdc-backend.fly.dev/health
```

From scratch on a new Fly account: `fly launch --no-deploy --copy-config`, `fly volumes create andi_data --size 1 --region iad`, then the commands above. If the app has no public IPs (`fly ips list`), run `fly ips allocate-v6` and `fly ips allocate-v4 --shared`.

If you pick a different app name, update `PUBLIC_URL` in `fly.toml` and the secret, and the app's default server in `andi/Core/AppModel.swift` (`defaultBaseURLString`), or set it in the app's server sheet.

The config asks for one shared-CPU 512 MB machine, always on, plus a 1 GB volume. Check your Fly org's billing page for what that costs on your plan.

## 3. Photon iMessage

1. Open the Photon Beta dashboard (app.beta.photon.codes), create or select a project.
2. **Settings** → copy the **Project ID** (starts with `pho_prj_`).
3. **API keys** → **New API key** with `project:read`, `project:write`, `platforms:read` and **`platforms:write`**. Copy it (shown once).
4. **iMessage**: make sure the project has shared iMessage capacity (Free includes 25 shared assignments).
5. Set the secrets:
   ```sh
   fly secrets set PHOTON_PROJECT_ID=pho_prj_... PHOTON_API_KEY=...
   ```
6. Check `GET /health` → `sponsors.photon` should read `subscribed`.

How it works (important): on the shared pool Andi only hears people it has **assigned**. The backend creates an assignment for each person and each sponsor at onboarding, and Photon allocates the number each of them texts. The app shows the person their number; the "invite your person" button sends the sponsor theirs. You don't need to assign anyone by hand, and `PHOTON_AGENT_HANDLE` is only a fallback (for dedicated lines, or if assignment fails).

Test: onboard in the app with your own number, tap "text andi", send the prefilled message. Andi replies within a few seconds.

Known limits from Photon's docs: shared lines are direct chats only, can't text first (the person must message after being assigned), and don't support calls.

## 4. Voice (Photon + ElevenLabs)

Your voice number: **+1 305 810 8482** (already in `.env` as `PHOTON_VOICE_NUMBER`).

In Photon (Voice → Lines → your number → Set up default → SIP → Create profile):
1. **Outbound calls**: Digest algorithm **SHA-256** → **Enable outbound**. Copy the **password** (shown once), the **username**, and the server (e.g. `sip.photon.codes:5061`, TLS).
2. **Inbound calls**: **Enable inbound**, SIP address `sips:sip.rtc.elevenlabs.io:5061`, transport **TLS**. Leave credentials empty.
3. Media encryption: **Auto**.

In ElevenLabs:
1. Create the agent from [VOICE_AGENT.md](VOICE_AGENT.md): prompt, first message, the 9 dynamic variables, the two tools.
2. **Phone Numbers → Import number → From SIP Trunk**: label "Andi", number `+13058108482`.
   - Inbound: media encryption **Allowed**, allowed source IPs `0.0.0.0/0`, no credentials.
   - Outbound: address `sip.photon.codes:5061` (no `sip:` prefix), transport **TLS**, media encryption **Allowed**, codecs G.722 / PCMU / PCMA, username + password from Photon.
3. Assign the agent to the number. Copy the **phone number ID** and the **agent ID**.
4. **Agents settings** → conversation initiation webhook `https://andi-tdc-backend.fly.dev/elevenlabs/init` with secret header `x-andi-secret`. On the agent's **Security** tab, turn on **Fetch initiation client data from a webhook**.

Then:
```sh
fly secrets set ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=... ELEVENLABS_PHONE_NUMBER_ID=... ELEVENLABS_WEBHOOK_SECRET=$(openssl rand -hex 16)
```
(Use the same secret value in ElevenLabs.)

Test: call +1 305 810 8482 from your phone (inbound), then tap "call my person" in the app with a sponsor whose number is a second phone (outbound). Without voice configured, "call my person" texts the sponsor a tap-to-call link instead.

### Voice notes in iMessage (optional)

Andi can also send short iMessage voice notes in its ElevenLabs voice: on milestones, and when someone asks to hear Andi ("send me a voice note"). Text always goes too. Each person gets at most `VOICE_NOTES_PER_DAY` (default 3) a day, to save credits.

1. ElevenLabs → **Voices** → pick Andi's voice → copy its **voice ID**. The API key needs **Text to Speech** access.
2. `fly secrets set ELEVENLABS_VOICE_ID=...` (uses the same `ELEVENLABS_API_KEY`; optional: `ELEVENLABS_TTS_MODEL`, default `eleven_flash_v2_5`, and `VOICE_NOTES_PER_DAY`).

Without `ELEVENLABS_VOICE_ID` there are no voice notes; nothing else changes.

### Andi's name and photo in Messages

```sh
npm run photon:profile -- --dry-run   # writes andi-avatar.png so you can look at it first
npm run photon:profile                # sets the Photon agent profile: "Andi" + the ring avatar
```

## 5. Claude

```sh
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
```
Model defaults to `claude-sonnet-5-5` (`ANTHROPIC_MODEL`). The same key also turns on the LLM red team (Claude writes the scenarios, plays each person, and judges every conversation; `REDTEAM_MODEL` picks its model, default `claude-sonnet-5-5`). Then rerun the red team against the real model:
```sh
ANTHROPIC_API_KEY=sk-ant-... ANDI_URL=https://andi-tdc-backend.fly.dev AGENT_TEST_KEY=<yours> npm run redteam -- --local --n 24
```
`--scripted` runs only the 18 fixed personas with regex scoring (no Claude calls).

## 6. Chalk

1. Ask the Chalk team at the sponsor table for an environment, and to **enable Evaluations and the async Function queue** for it.
2. **Settings → Access tokens**: create client credentials.
3. Deploy the features (`backend/chalk/chalk.yaml` is the project file; `.chalkignore` keeps the local parity stub and evals out of the deploy):
   ```sh
   curl -s -L https://api.chalk.ai/install.sh | sh   # Chalk CLI
   cd backend/chalk && chalk login && chalk apply
   ```
4. Set the secrets (engine URL and environment are discovered from the token response if you leave them out):
   ```sh
   fly secrets set CHALK_CLIENT_ID=... CHALK_CLIENT_SECRET=...
   ```
5. `GET /health` → `sponsors.chalk: "live"`, and `risk.source` in `/api/me` becomes `chalk`.
6. Evaluations: `python chalk/evals/run_eval.py redteam/results/redteam-*.jsonl` (needs `chalkcompute`).

Proof for judges: `npm run parity` shows the Chalk resolver and the TypeScript scorer agree on 5,000 random inputs.

## 7. Capital One Nessie

Andi uses **Nessie v2** (https://v2.nessieisreal.com), the rewrite Capital One is trying out at HackHarvard.

1. Sign in with GitHub at https://v2.nessieisreal.com/account and copy your key (`nsk_...`).
2. `fly secrets set NESSIE_API_KEY=nsk_... -a andi-tdc-backend`
3. On boot the server registers a **notify webhook** at `$PUBLIC_URL/nessie/webhook` for `transaction.created` and keeps its signing secret in the store. Check `GET /health` → `sponsors.nessie: "webhook"`. (Locally, with an http PUBLIC_URL, it skips the webhook and shows `"api"`.)
4. `POST /demo/seed` creates a Nessie customer and checking account. `POST /demo/purchase` makes a real purchase at "Square Wine & Spirits" and feeds it to the risk engine (`"source": "nessie"`).
5. Purchases made anywhere else on that account (curl, the Nessie dashboard) also reach Andi through the webhook. The same transaction is never counted twice.

Debug deliveries with `curl -H "Authorization: Bearer $NESSIE_API_KEY" https://v2-prod-api.nessieisreal.com/webhooks` and `/webhooks/<id>/deliveries`.

## 8. Daytona

```sh
cd backend
DAYTONA_API_KEY=... ANDI_URL=https://andi-tdc-backend.fly.dev AGENT_TEST_KEY=<yours> npm run redteam   # 24 improvised + 18 scripted conversations, one sandbox each (add ANTHROPIC_API_KEY=... for the LLM attacker + judge)
DAYTONA_API_KEY=... npm run tune                                                               # 500 simulated weeks, 10 sandboxes
```
Results land in `redteam/results/` (scorecard with per-category pass rates and the judge's reasons, JSONL transcripts for Chalk, `tune.json` for the threshold chart).

## 9. iOS app on your phone

1. Open `andi.xcodeproj` in Xcode. Target **andi** → **Signing & Capabilities**: pick your team, set a bundle ID (e.g. `com.kush.andi`).
2. Pick your iPhone as the run destination (the target is now iPhone/iPad only) and build. The code hasn't been compiled yet, so expect a few small fixes on the first build; paste the errors back to Claude.
3. Server: the app talks to `https://andi-tdc-backend.fly.dev` by default. To point it elsewhere: in Debug builds tap "server: …" on the welcome screen, or set `ANDI_BASE_URL` in the scheme's environment.
4. No backend at all? On the welcome screen's server sheet, tap **try with sample data** (Debug), or run with `ANDI_DEMO=1`. Every SwiftUI preview also runs on sample data.
5. For a backend on your Mac's network over plain http, iOS blocks it by default. Easiest: deploy to Fly (https). Otherwise add App Transport Security → Allow Local Networking in the target's Info tab.

## 10. Optional: Find My

Find My needs Photon's **Advanced iMessage SDK** credentials (a line address `host:port` and a token). Ask Photon whether your line exposes them. Then:
```sh
fly secrets set FINDMY_IMESSAGE_ADDRESS=host:port FINDMY_IMESSAGE_TOKEN=...
```
`POST /api/findmy/request` sends the person a location-sharing request; once accepted, the server checks their risk places itself and the iOS geofences become a backup.

## Questions to ask at the sponsor tables

- **Photon:** does shared-pool assignment via API need anything enabled on our project? Can the Advanced iMessage SDK (Find My) be used with our Beta project, and which credentials? Hackathon credits for voice minutes?
- **Chalk:** environment + Evaluations enabled; is `/v1/query/online` on the API server fine or should we use the engine URL?
- **ElevenLabs:** does Photon's SIP INVITE carry the caller's number as `caller_id` in E.164?
- **Nessie (v2 lead dev at the Capital One table):** is the notify envelope exactly the `/events` item shape (`{id, type, account_id, tx_id, data: {transaction}}`)? Any tolerance on the signature timestamp we should enforce?

## 11. Factory Droid (nightly safety autofix)

1. Create an API key at app.factory.ai/settings/api-keys and put it in `backend/.env` as `FACTORY_API_KEY=fk-...`.
2. Install the CLI the SDK drives: `curl -fsSL https://app.factory.ai/cli | sh` (then `droid --version`).
3. First run, on tonight's known misses:
   ```sh
   cd backend
   npm run autofix -- --gaps droid/examples/tonight.json
   ```
   Read `redteam/results/autofix/<run>/PULL_REQUEST.md` and `fix.patch`. If it looks right: `npm run autofix -- --gaps droid/examples/tonight.json --apply` (or `patch -p1 -i <run>/fix.patch`), then `npm run check`.
4. Full loop (red-team failures + the Droid's own gap hunt): `npm run autofix`.
5. Nightly: copy `docs/ci/nightly-safety.yml` to `.github/workflows/` and add the secrets it lists.

No key yet? `npm run autofix:selftest` runs the whole pipeline with a stand-in for the Droid, so you can see the report format.
