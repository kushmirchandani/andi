# Evidence catalog (internal)

Every vendor-facing claim the code and docs rely on, where it came from, and how it was checked. Researched 2026-10-17. "Twice" means the source was re-opened in a second pass and the quote matched. Full write-ups: [sponsor-verification.md](sponsor-verification.md), [elevenlabs-verification.md](elevenlabs-verification.md).

## Photon

| Claim | Source | Checked | Used in |
| --- | --- | --- | --- |
| Send = `POST /v1/projects/{id}/messages` `{spaceId, senderId, content, parentMessageId?}`, `Idempotency-Key` required | api.photon.codes/openapi.json | Twice | `photon/client.ts` |
| Content types `text`, `text.update`, `message.delete`, `reaction`, `poll` and their required fields (`additionalProperties: false`) | openapi.json | Twice | `photon/client.ts` |
| Edit / unsend / react target the message via `parentMessageId` | Inferred: the only field available in the schema | Not stated in prose. Test once on a real line | `photon/client.ts` |
| Mark read takes no request body | openapi.json (`requestBody: null`) | Twice; code fixed | `photon/client.ts` |
| Socket.IO path `/v1/projects/{id}/events/ws`, `subscribe {startSeq, apiVersion}`, `delivery(event, {seq})`, cursor semantics | photon.codes/docs/beta/websocket/{connect,session,cursors,events,example}.md | Twice | `photon/events.ts` |
| Shared line only replies in direct spaces to a peer with an active assignment who messaged it since | openapi.json, send operation description | Twice | linking flow |
| Shared-line assignment API: `POST/GET /platforms/imessage/assignments`, `DELETE …/{assignmentId}`; "The assigned number is allocated by the server"; errors `ASSIGNMENT_EXISTS`, `IMESSAGE_MODE_DEDICATED`, `SHARED_LINE_CAP_EXCEEDED`, `SHARED_LINE_POOL_EXHAUSTED`; needs `platforms:write` | openapi.json (`createSharedLineAssignment`, `SharedLineAssignment`, `CreateSharedLineAssignmentRequest`) | Read from the spec directly | `photon/lines.ts`, `services/lines.ts` |
| Assign in the dashboard: iMessage → enter the sender's identity → assign from the shared pool; sender must send a fresh message after assignment; shared lines don't support calls | photon.codes/docs/beta/get-started/imessage.md | Once (WebFetch summary) | SETUP.md |
| API key permissions `project:read`, `project:write`, `platforms:read`, `platforms:write`; Project ID prefix `pho_prj_` | photon.codes/docs/beta/get-started/project.md | Once (WebFetch summary) | SETUP.md |
| Voice: "Shared iMessage assignments do not support Voice"; SIP setup steps (SHA-256 outbound, `sip.photon.codes:5061` TLS, inbound `sips:sip.rtc.elevenlabs.io:5061`) | photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | Twice | SETUP.md, VOICE_AGENT.md |
| Advanced iMessage SDK: `createGrpcClient`, `locations.request/list/watch`; watch updates not replayed; `createClient` deprecated | `node_modules/@photon-ai/advanced-imessage/dist/grpc.d.ts` v2.3.0; photon.codes/docs/advanced-kits/imessage/locations.md | Twice | `findmy/watcher.ts` |
| Plans: Free includes 25 shared assignments | Earlier research this session (plans page) | Once | SETUP.md |

## ElevenLabs

| Claim | Source | Checked |
| --- | --- | --- |
| Outbound call `POST /v1/convai/sip-trunk/outbound-call` `{agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data?}` → `{success, message, conversation_id, sip_call_id}` | elevenlabs.io/docs/api-reference/sip-trunk/outbound-call | Twice |
| `xi-api-key` auth header on that endpoint | Not shown on the page; standard ElevenLabs header | Unverified on that page |
| Initiation webhook runs for inbound SIP-trunk calls; request `{caller_id, called_number, agent_id, call_sid, conversation_id}`; response `{type: "conversation_initiation_client_data", dynamic_variables}`; must include every custom variable; failure can block the call | elevenlabs.io/docs/eleven-agents/customization/personalization | Twice |
| Webhook auth is static secret headers (no HMAC); configured in Agents settings + agent Security toggle | same + twilio-personalization | Twice |
| Server tool params via `dynamic_variable: "system__caller_id"`; `system__call_id` for SIP | elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools; dynamic-variables page | Twice |
| How Photon formats the caller's number on SIP | Not documented | Unverified: log the first real call |

## Chalk

| Claim | Source | Checked |
| --- | --- | --- |
| Token: `POST /v1/oauth/token` client credentials; query: `POST /v1/query/online` with `X-Chalk-Deployment-Type: engine`, `X-Chalk-Env-Id`; response `data[{field, value}]` | docs.chalk.ai/docs/online-authentication.md; `@chalk-ai/client@1.31.13` source | Twice |
| Token response can carry `primary_environment` and `engines` | `@chalk-ai/client` (`getEngineUrlFromCredentials`) | Twice |
| `@features` / `@online` resolver returning `Features[...]` | docs.chalk.ai/docs/python-resolvers.md, features.md | Twice |
| Evaluations = dataset + task + scorers; scorer params bind to columns plus `output`; must be enabled by Chalk support | docs.chalk.ai/docs/compute/evaluations.md, evaluations/scorers.md, datasets.md | Twice |
| `@chalkcompute.function` bare decorator at module scope | evaluations/tasks.md | Twice; `run_eval.py` avoids the unverified `name=` keyword |
| Resolver matches the TypeScript scorer | `npm run parity`, 5,000 random inputs | Run locally |

## Capital One Nessie

| Claim | Source | Checked |
| --- | --- | --- |
| Endpoints and required fields for customers, accounts, merchants, purchases | nessieisreal.com/nessie-openapi-spec.yaml; live probe with an invalid key (validation errors list required fields) | Twice |
| Create responses: spec documents a plain string; older API returned `objectCreated._id` | Spec vs. older docs | Unverified live (needs a key); client handles both |
| Merchant `category` is a string in the spec, an array in the docs example | Spec vs. docs page | Contradictory; client sends a string |

## Daytona and Anthropic

| Claim | Source | Checked |
| --- | --- | --- |
| `new Daytona({apiKey})`, `create({language, envVars, labels, autoStopInterval, ephemeral})`, `fs.uploadFile`, `process.executeCommand`, `delete` | `node_modules/@daytona/sdk` types | Twice |
| `messages.create` with `tools` + `tool_choice: {type: "tool"}`; client `timeout`, `maxRetries` | `node_modules/@anthropic-ai/sdk` 0.135.0 types | Read from types |
| Model id `claude-sonnet-5-5` | Product information | Once |
| Raw Messages API used by `redteam/adaptive-worker.mjs`: `POST https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json` | [Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages) (curl examples) | Twice (docs page + matches the SDK's own requests) |
| Forcing one tool: `tool_choice: {"type": "tool", "name": ...}`; tool fields `name` (regex `^[a-zA-Z0-9_-]{1,128}$`), `description`, `input_schema` (JSON Schema) | [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) | Twice (docs + SDK types). (Superseded by the correction below.) The page doesn't list supported JSON Schema keywords, so the tool schemas use only `type`, `properties`, `description`, `enum`, `required` (the keywords its examples show); `safety_gap` is an object with a `found` flag rather than a nullable union |
| `temperature` / `top_p` / `top_k` are rejected on newer models, so the red team sends none | Same Messages API page (note at top) | Once |
| The TS SDK reads `ANTHROPIC_BASE_URL` (used by the tests' fake Claude) | `node_modules/@anthropic-ai/sdk/client.js` constructor default | Read from source |
| The LLM red team end to end (scenario writer → attacker → real Andi → judge → scorecard → Droid gap finder) | `backend/test/redteam.test.ts` against a local fake of the Messages API | Runs in `npm test` (3 tests) |
| **Correction (2026-10-17, live test):** Claude Sonnet 5.5 rejects `tool_choice` `{"type":"tool"}` and `"any"` with a 400 ("tool_choice: type \"tool\" and \"any\" are not supported for this model"). The brain, red-team worker and scenario writer now use JSON outputs: `output_config: {format: {type: "json_schema", schema}}`, with `additionalProperties: false` on every object, read from the text block | [Sonnet 5.5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), plus a live 400 and a live 200 against the API with the project key | Twice (two docs pages + live requests) |
| `output_config.effort: "low"` for text replies (live reply in ~2.3s) | Same migration guide (effort replaces thinking budgets); live request | Twice |
| Not yet run against real Claude: no `ANTHROPIC_API_KEY` in this environment. First real run's scorecard is the evidence to add | n/a | Open |

## Apple

| Claim | Source | Checked |
| --- | --- | --- |
| Guideline 4.8: an equivalent login option is required only with third-party/social login | developer.apple.com/app-store/review/guidelines | Earlier this session |
| Guideline 5.1.1(v): apps that support account creation must offer in-app deletion | same | Earlier this session; implemented as `DELETE /api/me` |
| CLMonitor limit of 20 conditions | Apple Core Location docs (region monitoring limit) | From prior knowledge; not re-fetched |

## Product claims made in the docs

| Claim | Evidence |
| --- | --- |
| Red team 18/18 | `backend/redteam/results/latest-scorecard.json` (local run, rule-based fallback; rerun with a Claude key) |
| 76 backend tests pass | `npm run check` |
| Chalk parity 5,000/5,000 | `npm run parity` |
| Docker image runs and persists data across a SIGTERM | Built and run locally (with pre-installed node_modules; the sandbox couldn't reach npm from inside the build) |
| iOS Core files compile | Swift 6.2 on Linux, Swift 5 mode, MainActor default isolation, with stubs for CoreLocation/CoreBluetooth. SwiftUI files not compiled |

## Factory (Droid SDK)

| Claim | Source | Checked | Used in |
| --- | --- | --- | --- |
| Prize rule: "Droid should do real work in the running product, not just help you write code. The repo README should explain where and how Droid is used." $2,000 cash, $200 credits per member | hhuh.io sponsor page (pulled earlier this session) | Re-read from the saved page text | README "Where and how Droid is used" |
| `run()` from `@factory/droid-sdk/node`; options `cwd`, `apiKey`, `autonomyLevel`, `permissionHandler`, `outputFormat` (`OutputFormatType.JsonSchema`), `autoRejectPermissionRequests` | `@factory/droid-sdk@0.9.1` package types and examples (README, run.ts, structured-output.ts, permission-handler.ts) | Typechecked against the installed types | `droid/autofix.ts`, `droid/gaps.ts` |
| Autonomy levels: Off "Ask before every action", Low "Allow file edits and read-only commands", Medium "Allow reversible commands", High "Allow commands without approval prompts" | docs.factory.com/sdk/typescript | Twice | guardrails |
| "By default, the SDK starts the `droid` CLI from `PATH`"; "reads `FACTORY_API_KEY` from the process environment by default" | docs.factory.com/sdk/typescript | Twice | SETUP.md |
| Omitting the permission handler or returning an unavailable value cancels the request | docs.factory.com/sdk/typescript | Twice | permission handler fallback |
| Result subtypes: success, interrupted, error_during_execution, error_structured_output | docs.factory.com/sdk/typescript | Twice | report.json |
| CLI install `curl -fsSL https://app.factory.ai/cli | sh`; API keys at app.factory.ai/settings/api-keys | docs.factory.com/docs/droid-exec/overview | Once; installer ran here (Factory CLI v0.244.0, checksum verified) | SETUP.md, CI |
| Without a key the SDK fails fast: "No Factory API key found…" | Ran here | Observed | — |
| A real Droid session has not been run yet (no key in this session) | — | — | Pipeline proven with a stand-in fixer: verified run, plus rejections for an out-of-scope edit and an incomplete fix |
