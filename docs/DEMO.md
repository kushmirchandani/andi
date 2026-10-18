# Demo runbook (Sunday judging)

The story happens on a Friday night; judging is Sunday morning. The demo routes pin "now" so late-night and weekend signals behave like the real moment.

## Before you go on

- Phones: **Maya's phone** (the person, has the app + Messages), **Sam's phone** (the sponsor; a teammate's phone works).
- Backend deployed with Photon, Claude, Nessie, Chalk (and voice if set up). `GET /health` shows each as live.
- In a terminal:
  ```sh
  export BASE=https://andi-tdc-backend.fly.dev KEY=<your DEMO_KEY>
  j() { curl -fsS -H 'content-type: application/json' -H "x-demo-key: $KEY" "$@"; echo; }
  j -X POST $BASE/demo/reset
  j -X POST $BASE/demo/clock -d '{"iso":"2026-10-16T23:05:00-04:00"}'      # Friday 11:05 pm, pin BEFORE seeding
  j -X POST $BASE/demo/seed  -d '{"phone":"+1<Maya>","sponsorPhone":"+1<Sam>","days":41}'
  ```
  The seed response's `textFrom` shows which number Maya and Sam each text. Text "hi andi <linkCode>" from Maya's phone and "hi andi" from Sam's once, before the demo. Sam now has the status message.
- Or onboard live in the app instead of seeding (adds ~40 seconds; shows the safety screen).

## The beats (about 3–4 minutes)

| # | Say | Do | What the audience sees |
| --- | --- | --- | --- |
| 1 | "Maya is 41 days sober. It's Friday, 11pm." | Show the app home | Day 41, risk low, money saved |
| 2 | "She walks into the bar she marked as risky." | `j -X POST $BASE/demo/place-enter` | Maya's phone: "do you want to be here right now?" + "the diner on Mass Ave is open till 2". Sam's status edits to "having a harder night" |
| 3 | "She stops at the liquor store." | `j -X POST $BASE/demo/purchase` | Real Nessie purchase. Risk goes high. Sam gets one text: "might need a call tonight" |
| 4 | "She texts Andi like a friend." | Maya types "i really want a drink" | Claude replies: rides the urge, offers Sam |
| 5 | "One tap." | Tap "call Sam" in the app (or reply CALL) | Sam's phone rings from Andi's number (voice) or gets a tap-to-call text |
| 6 | "Andi never saw where she was or what she bought, only that she was near a place she chose." | Open Sam's portal link | Consent-scoped status, "Call Maya" |
| 7 | "And we stress-tested it." | Show `redteam/results/latest-scorecard.json` and the tuning chart | Claude improvises a fresh set of hard nights every run and a judge grades each one (plus 18 scripted regressions, 18/18 on the fallback); thresholds tuned on 500 simulated weeks in Daytona; Chalk scoring with parity proof |
| 8 | "Regexes can't predict every way someone says they want to die, so Andi closes its own gaps every night." | Show `redteam/results/autofix/latest/PULL_REQUEST.md` (or run `npm run autofix -- --gaps droid/examples/tonight.json` live) | A Factory Droid found and patched 11 misses, verified independently, waiting for a human to merge |

Optional closers:
- Andi Wrapped: `j -X POST $BASE/demo/advance -d '{"days":49}'` → day 90 story (mornings, money saved, nights protected, urges ridden).
- HALT poll: `j -X POST $BASE/demo/checkin-poll` → a native iMessage poll on Maya's phone.

## If something breaks on stage

| Problem | Fallback |
| --- | --- |
| Photon is slow | Keep talking; replies have a typing indicator. `GET /demo/outbox` shows what was sent |
| Photon is down | Run the same beats with `POST /demo/inbound` and show the outbox on screen (dry-run is identical logic) |
| Voice doesn't ring | "call your person" falls back to texting Sam a tap-to-call link automatically |
| Chalk errors | The local scorer takes over in 2.5 s with identical numbers (`npm run parity`) |
| Nessie errors | `/demo/purchase` falls back to a local purchase signal (`"source": "local"`) |
| Wrong day count | You pinned the clock after seeding. `reset`, pin, then seed |

After the demo: `j -X POST $BASE/demo/clock -d '{"iso":null}'`.
