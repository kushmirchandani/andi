#!/usr/bin/env bash
# End-to-end smoke test of the Friday-night story against a running server, no sponsor keys needed.
#   npm run dev            (in one terminal)
#   npm run smoke          (in another)   or: BASE=https://your-app.fly.dev DEMO_KEY=... npm run smoke
set -euo pipefail
BASE="${BASE:-http://localhost:8080}"
KEY="${DEMO_KEY:-dev-demo-key}"
PERSON="${PERSON_PHONE:-+16175550101}"
SPONSOR="${SPONSOR_PHONE:-+16175550102}"
j() { curl -fsS -H 'content-type: application/json' -H "x-demo-key: $KEY" "$@"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }

say "health";               curl -fsS "$BASE/health"; echo
say "reset, pin the clock to Friday 11:05pm, seed Maya (day 41, sponsor Sam, one risk place)"
j -X POST "$BASE/demo/reset" >/dev/null
# Pin "now" first so the day count stays consistent for the whole story.
j -X POST "$BASE/demo/clock" -d '{"iso":"2026-10-16T23:05:00-04:00"}' >/dev/null
SEED=$(j -X POST "$BASE/demo/seed" -d "{\"phone\":\"$PERSON\",\"sponsorPhone\":\"$SPONSOR\"}")
echo "$SEED"
CODE=$(echo "$SEED" | field 'o.linkCode'); TOKEN=$(echo "$SEED" | field 'o.apiToken')
say "Maya texts Andi (links her number)"; j -X POST "$BASE/demo/inbound" -d "{\"from\":\"$PERSON\",\"text\":\"hi andi $CODE\"}" | field 'o.replies.map(r=>r.content.text).join("\n")'
say "Sam texts Andi";                     j -X POST "$BASE/demo/inbound" -d "{\"from\":\"$SPONSOR\",\"text\":\"hi andi\"}" | field 'o.replies.map(r=>r.content.text).join("\n")'
say "she walks into The Rusty Anchor";    j -X POST "$BASE/demo/place-enter" -d '{}' | field 'o.risk.level+" "+o.risk.score'
say "liquor store purchase (Nessie)";     j -X POST "$BASE/demo/purchase" -d '{}' | field 'o.source+" -> "+o.risk.level+" "+o.risk.score'
say "she replies"; j -X POST "$BASE/demo/inbound" -d "{\"from\":\"$PERSON\",\"text\":\"i really want a drink\"}" | field 'o.replies.map(r=>r.content.text).join("\n")'
say "she taps CALL";                      j -X POST "$BASE/demo/inbound" -d "{\"from\":\"$PERSON\",\"text\":\"CALL\"}" | field 'o.replies.map(r=>r.content.text).join("\n")'
say "what the app sees";                  curl -fsS "$BASE/api/me" -H "authorization: Bearer $TOKEN" | field '`day ${o.day}, risk ${o.risk.level}, saved $${o.moneySaved}, linked ${o.imessageLinked}, sponsor linked ${o.sponsor.linked}`'
say "everything Andi sent (outbox)";      j "$BASE/demo/outbox" | field 'o.map(m=>`${m.content.type.padEnd(11)} ${m.spaceId.slice(-6)}  ${(m.content.text??m.content.question??"").replace(/\n/g," / ")}`).join("\n")'
say "unpin the clock";                    j -X POST "$BASE/demo/clock" -d '{"iso":null}' >/dev/null; echo ok
