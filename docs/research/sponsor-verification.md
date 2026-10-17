# Sponsor API verification (Andi backend)

Checked on 2026-10-17 against the live vendor docs, the vendors' published OpenAPI specs, the live Nessie API (read-only probes with an invalid key), and the installed package types in `backend/node_modules`. No code was changed.

How this was checked: each page was downloaded as raw text with curl (most vendors serve a `.md` variant), then re-downloaded in a separate second pass, and every quote below was string-matched against the fresh copy. Where a docs site renders only in the browser (docs.chalk.ai for endpoint paths, nessieisreal.com), the vendor's own published client or spec was used instead, and the report says so.

## Summary

| Vendor | Verdict | Action |
| --- | --- | --- |
| Photon V2 REST (send, edit, unsend, react, poll, typing) | Correct | None |
| Photon V2 mark-read | Minor mismatch | Stop sending a JSON body |
| Photon V2 Socket.IO events | Correct | None |
| Photon edit/unsend/react targeting via `parentMessageId` | Unverifiable (consistent with schema) | Test once on a real line |
| Photon voice → ElevenLabs routing | Correct (setup constraint) | Voice number must not be a shared iMessage line |
| Photon Advanced iMessage SDK (Find My) | Correct | Optional: `createClient` → `createGrpcClient` |
| ElevenLabs SIP-trunk outbound call | Correct | Optional: check `success` in the body |
| Chalk OAuth + online query (REST) | Correct | Optional: engine discovery from the token response |
| Chalk `features.py` | Correct | None |
| Chalk Evaluations (`chalk/evals/scorers.py`) | **Mismatch** | Rewrite the scorer signatures and the dataset shape |
| Nessie create responses (`objectCreated._id`) | **Mismatch with current spec** | Read the id defensively, with a fallback lookup |
| Nessie merchant `category` | **Mismatch with current spec** | Send a string, not an array |
| Nessie purchases (create/list) | Correct (live), undocumented | None |
| Daytona TS SDK | Correct | None |
| Anthropic SDK + `claude-sonnet-5-5` | Correct | None |

---

## 1. Photon V2 (Beta) REST API

**What our code does** (`src/photon/client.ts`):
- `POST {origin}/v1/projects/{projectId}/messages` with body `{ spaceId, senderId, content, parentMessageId? }`, a Bearer key, and an `idempotency-key` header on every send.
- Content variants it sends: `text` (`format: "plain"`), `text.update`, `message.delete`, `reaction` (`reaction`, `action: "add"`), and `poll` (`question`, `options[{id,text}]`, `selectionMode: "multiple"`).
- Edit, unsend and react all pass the target message in `parentMessageId`.
- Typing: `POST /spaces/{spaceId}/typing` with `{ senderId, typing }`.
- Mark read: `POST /messages/{messageId}/read` with an idempotency key, sending a `{}` JSON body.

**What the docs say** (spec: https://api.photon.codes/openapi.json; guide: https://photon.codes/docs/beta/get-started/imessage.md):
- The send request has the properties `content`, `email`, `parentMessageId`, `senderId`, `spaceId`, `telegram`. The required ones are `content`, `senderId` and `spaceId`, and `idempotency-key` is a required header.
- `SendContent` is `anyOf` with these variants: `SendTextContent`, `SendTextUpdateContent`, `SendAttachmentContent`, `SendVoiceContent`, `SendReactionContent`, `SendMessageDeleteContent`, `SendMessageReadContent`, `SendSpaceParticipantsUpdateContent`, `SendSpaceTypingUpdateContent`, `SendPollContent`, `SendPollVoteContent`, `SendPollUpdateContent`, `SendGroupContent`.
- Field rules for each variant we use:
  - `text` and `text.update`: require `type`, `format`, `text`.
  - `reaction`: requires `type`, `reaction`, `action` (enum `add`/`remove`).
  - `message.delete`: requires only `type`.
  - `poll`: requires `type`, `question`, `options` (each `{id, text}`), `selectionMode` (enum `single`/`multiple`).
  - All of these have `additionalProperties: false`.
- Send operation description: "A shared iMessage line sends only in direct Spaces, only to a peer with an active Assignment who has messaged it since that Assignment."
- Typing: body `{ senderId, typing }`, both required, no idempotency header. "True starts or refreshes typing; false stops it."
- Mark read: "Requires Idempotency-Key." The operation defines **no requestBody** (`requestBody: null` in the spec).
- Reply pattern in the quickstart: "The reply reuses the incoming message's `space.id`, `receivedBy.id`, and `id` as `spaceId`, `senderId`, and `parentMessageId`."
- The `x-photon-version` header is defined only on the three `/metrics` endpoints, so the messaging calls don't need it.

**VERDICT:**
- Send, poll, typing: **correct**.
- Edit/unsend/react targeting: **unverifiable but consistent**. None of the `text.update`, `message.delete` or `reaction` schemas has a target-id field, and they forbid extra properties, so `parentMessageId` is the only place a target can go. No page states this outright. Confirm it once against a real line.
- Mark read: **minor mismatch**. We send a JSON body to an operation that declares none. It may be accepted, but it isn't in the contract.

**Fix (mark read)** in `src/photon/client.ts`:

old:
```ts
async function post(path: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.photon.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(`${base()}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
```
new:
```ts
async function post(path: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.photon.apiKey}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
```
and

old: `await post(\`/messages/${messageId}/read\`, {}, \`read:${messageId}\`)`
new: `await post(\`/messages/${messageId}/read\`, undefined, \`read:${messageId}\`)`

## 2. Photon V2 Socket.IO event stream

**What our code does** (`src/photon/events.ts`, `src/config.ts`):
- Connects with `io(origin, { path: /v1/projects/{id}/events/ws, addTrailingSlash: false, transports: ["websocket"], extraHeaders: { Authorization: Bearer … }, autoConnect: false })`.
- On `connect`, emits `subscribe` with `{ startSeq: savedCursor, apiVersion: "2026-07-01" }`.
- Handles `delivery(event, {seq})` serially with an epoch/pending queue capped at 128, and saves `seq` only after the handler succeeds.
- Reads `event.type`, `event.data.object` as a Message with `space`, `sentBy`, `receivedBy`, `content`, `parentMessageId`.

**What the docs say:**
- https://photon.codes/docs/beta/websocket/connect.md: the connect snippet uses exactly ``path: `/v1/projects/${projectId}/events/ws` ``. "Polling and Socket.IO session recovery are disabled."
- https://photon.codes/docs/beta/websocket/session.md: "Include `apiVersion` to pin a selectable customer contract date". The example is `emit("subscribe", { startSeq: savedCursor, apiVersion: "2026-07-01" }, …)`.
- https://photon.codes/docs/beta/websocket/cursors.md: "If your last processed cursor is `42`, subscribe with `42`; do not add one."
- https://photon.codes/docs/beta/websocket/events.md: "Listen for `delivery(event, metadata)`".
- https://photon.codes/docs/beta/websocket/example.md: our handler is the official example almost line for line (epoch, `pending > 128`, `seq <= cursor` guard, close the engine on failure).
- In the OpenAPI spec, `ImessageMessageReceivedEvent` has `type` const `"message.received"`, `apiVersion` const `"2026-07-01"`, and `data.object` as a Message. The Message properties include `space`, `sentBy`, `receivedBy`, `content`, `parentMessageId`, `status`, `platform`, `createdAt`. A poll vote arrives as `poll.vote` with `selectedOptions`.

**VERDICT: correct.** No change.

## 3. Photon voice → ElevenLabs (routing)

**What our code does:** the comments in `src/services/calls.ts` and `config.photon.voiceNumber` assume a Photon number SIP-trunked to an ElevenLabs agent.

**What the docs say** (https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md):
- "Incoming call: caller → Photon number → Voice profile → ElevenLabs agent."
- "Outgoing call: ElevenLabs agent → Photon SIP connection → recipient's phone."
- The Photon inbound destination is `sips:sip.rtc.elevenlabs.io:5061` over TLS.
- In ElevenLabs, you import the number with "Choose **From SIP Trunk**." Its outbound Address is the Photon SIP server, such as `sip.photon.codes:5061`, with TLS and Photon's outbound username and password (SHA-256 digest).
- "Shared iMessage assignments do not support Voice." The number must be an SMS number, a WhatsApp number, or a dedicated iMessage line.
- https://photon.codes/docs/beta/plans-and-billing.md: "Business uses dedicated lines rather than shared assignments." Dedicated iMessage lines are $250 per line per month on Business only.

**VERDICT: correct**, with one setup constraint. `PHOTON_VOICE_NUMBER` must be a voice-capable SMS/WhatsApp number or a dedicated line, not the shared iMessage assignment that Andi texts from.

## 4. Photon Advanced iMessage SDK (Find My)

**What our code does** (`src/findmy/watcher.ts`):
- Creates the client with `createClient({ address, token })` from `@photon-ai/advanced-imessage/grpc`.
- `chats.create([phone])` → `chat.guid`.
- `locations.request(chat.guid, phone, { clientMessageId })`.
- `locations.list()`, then `for await (const update of locations.watch())` reading `update.location`.
- Guards for missing `latitude`/`longitude`, and reconnects with backoff.

**What the docs and types say:**
- Installed types (`node_modules/@photon-ai/advanced-imessage/dist/grpc.d.ts`, v2.3.0):
  - `ClientOptions { address: string; token: string | (() => Promise<string>); tls?; retry?; … }`
  - `request(chat: string, address: string, options?: IdempotencyOptions): Promise<LocationRequestReceipt>`
  - `list(): Promise<SharedFriendLocation[]>`
  - `watch(address?: string): TypedEventStream<SharedFriendLocationUpdated>`
  - `SharedFriendLocationUpdated { location; sourceSequence }`
  - `createClient` is "@deprecated v1 alias". Use `createGrpcClient`.
  - "streaming RPCs are never retried automatically."
- https://photon.codes/docs/advanced-kits/imessage/locations.md:
  - "Pass a direct or group `chat.guid`, not an email or phone number."
  - "Updates missed while disconnected cannot be replayed"
  - "Check both `latitude` and `longitude` before plotting a point"
- https://photon.codes/docs/advanced-kits/imessage/chats.md: `const { chat } = await im.chats.create(["alice@example.com"]);`
- Docs drift: https://photon.codes/docs/advanced-kits/imessage/getting-started.md still shows `import { createClient } from "@photon-ai/advanced-imessage";`. In the installed v2.3.0, the root entry exports only `createGrpcClient` and `createHttpClient`. The package README says to import gRPC from `/grpc`. Our import is the right one for the installed version, and the docs page is stale.

**VERDICT: correct.** Optional tidy-up:
- old: `import { createClient, type SharedFriendLocation } from "@photon-ai/advanced-imessage/grpc";`
- new: `import { createGrpcClient as createClient, type SharedFriendLocation } from "@photon-ai/advanced-imessage/grpc";`

## 5. ElevenLabs outbound call over a SIP trunk

**What our code does** (`src/services/calls.ts`):
- `POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call`
- Header `xi-api-key`.
- Body `{ agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data: { dynamic_variables: {…} } }`.
- Treats any non-2xx as a failure.

**What the docs say:**
- https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call.md:
  - "POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"
  - "`agent_id` (string, required)", "`agent_phone_number_id` (string, required)", "`to_number` (string, required)"
  - `conversation_initiation_client_data` is optional and contains "`dynamic_variables` (map from string to any, optional)"
  - The 200 response has "`success` (boolean, required)", `message`, `conversation_id`, `sip_call_id`.
- https://elevenlabs.io/docs/api-reference/authentication.md: "xi-api-key: ELEVENLABS_API_KEY"
- Importing the trunk number (https://elevenlabs.io/docs/api-reference/phone-numbers/create.md):
  - "POST https://api.elevenlabs.io/v1/convai/phone-numbers"
  - "Import Phone Number from provider configuration (Twilio, Exotel, or SIP trunk)"
  - Body `CreateSIPTrunkPhoneNumberRequestV2`: `phone_number`, `label`, `provider` ("sip_trunk"), `agent_id?`, `inbound_trunk_config?`, `outbound_trunk_config?` (`address` required, `transport` with `tls`, `credentials {username, password}`).
  - The response returns `phone_number_id`. That value is what `ELEVENLABS_PHONE_NUMBER_ID` (our `agent_phone_number_id`) should hold.

**VERDICT: correct.** Optional hardening, because a 200 response can still carry `success: false`:

old:
```ts
  if (!res.ok) throw new Error(`ElevenLabs outbound call ${res.status}: ${(await res.text()).slice(0, 200)}`);
```
new:
```ts
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs outbound call ${res.status}: ${text.slice(0, 200)}`);
  const out = JSON.parse(text) as { success?: boolean; message?: string };
  if (out.success === false) throw new Error(`ElevenLabs outbound call rejected: ${out.message ?? ""}`);
```

## 6. Chalk: online query client (`src/chalk/client.ts`)

**What our code does:**
- Gets a token with `POST {apiServer}/v1/oauth/token`, body `{ client_id, client_secret, grant_type: "client_credentials" }`, reading `access_token` and `expires_in`.
- Queries with `POST {engineUrl || apiServer}/v1/query/online`.
  - Headers: `Authorization: Bearer`, `x-chalk-deployment-type: engine`, and `x-chalk-env-id` when configured.
  - Body: `{ inputs: {"person.x": …}, outputs: [...] }`.
  - Reads `body.data[]` as `{ field, value }`.

**What the docs say:**
- https://docs.chalk.ai/docs/online-authentication.md: "fetch an access_token using the OAuth Client Credentials grant flow"; "The grant_type field must always be "client_credentials"."; "Number of seconds until the access_token expires." This page doesn't render the endpoint path as text, so the path and headers come from Chalk's official TS client below.
- Official `@chalk-ai/client@1.31.13`, linked from https://docs.chalk.ai/docs/client-typescript.md:
  - `build/_services/_http.js`: `path: "/v1/oauth/token"`, sent with body `{ client_id, client_secret, grant_type: "client_credentials" }`, and `path: "/v1/query/online"`.
  - `build/_client_http.js`: headers `"X-Chalk-Deployment-Type": "engine"` and `X-Chalk-Env-Id`. The body is `{ inputs, outputs, … }`.
  - `build/_response.js`: the response is parsed from `rawResult.data.map(d => [d.field, { value: d.value, … }])`.
  - Default API server: `DEFAULT_API_SERVER = "https://api.chalk.ai"`.
- Engine URL discovery: the token response carries `primary_environment` and an `engines` map keyed by environment ID (`getEngineUrlFromCredentials`). The client uses it only when `useQueryServerFromCredentialExchange` is true. Otherwise it falls back to `queryServer || apiServer`, which is what our code does.

**VERDICT: correct.** Optional: when `CHALK_ENGINE_URL` and `CHALK_ENVIRONMENT_ID` are unset, take them from the token response, as the official client can:
```ts
// in accessToken(): widen the type
const body = (await res.json()) as { access_token: string; expires_in?: number; primary_environment?: string; engines?: Record<string, string> };
// then: engine = config.chalk.engineUrl || body.engines?.[config.chalk.envId || body.primary_environment || ""] || config.chalk.apiServer
// and send x-chalk-env-id = config.chalk.envId || body.primary_environment
```

## 7. Chalk: `chalk/features.py`

**What our code does:**
- Imports `from chalk import online` and `from chalk.features import Features, features`.
- `@features class Person` with scalar features.
- One `@online` resolver taking `Person.*` inputs, returning `-> Features[Person.risk_score, Person.risk_level, Person.risk_reasons]` and `Person(risk_score=…, …)`.
- Queried as `person.risk_score` and so on.

**What the docs say:**
- https://docs.chalk.ai/docs/python-resolvers.md: "To return multiple features, return an instance of the feature class." The example is `def resolve(u: User.id) -> Features[User.name, User.employer]:` returning `User(...)`. Both `from chalk.features import features, online` and `from chalk import online, …` appear in the docs.
- https://docs.chalk.ai/docs/features.md: "Features are namespaced by their containing FeatureSet," for example `user.id`, so `Person` gives `person.*`.

**VERDICT: correct.** The code doesn't use `DataFrame`, so it needs no check.

## 8. Chalk Evaluations (`chalk/evals/scorers.py`)

**What our code does:**
- Defines plain Python scorers `fn(row: dict) -> float | None`, which return `None` when a scorer doesn't apply.
- Takes the dataset as red-team JSONL rows `{persona, turns[{user, andi{reply, route, intent}}], score}`.
- The docstring says to wrap each scorer with `@chalkcompute.function`.

**What the docs say:**
- The product exists. https://docs.chalk.ai/docs/compute/evaluations.md: "An evaluation is defined by three things: a completed dataset revision, one task, and one or more scorers." Also: "Before your first run, ask Chalk support to enable Evaluations and the async Function queue in your environment."
- You run it with `chalkcompute`: `chalkcompute.DatasetClient().upload(...)`, then `chalkcompute.Evaluation.create(name, dataset=..., task=..., scorers=[...])`, then `.run().wait()` (https://docs.chalk.ai/docs/evaluations/quick-start.md).
- https://docs.chalk.ai/docs/evaluations/scorers.md:
  - A scorer's "parameters bind to dataset columns by name, plus one argument the runner supplies: output".
  - "A scorer must return a floating point number between 0 and 1 inclusive, one EvaluationScorerResult, or a list[EvaluationScorerResult]… An empty list emits no scores for that row."
- https://docs.chalk.ai/docs/evaluations/datasets.md:
  - "Upload a dataset with DatasetClient.upload(name, data)." It accepts CSV/Parquet paths, PyArrow tables, or "a mapping of column name to values, or a sequence of row mappings". JSONL files are not listed.
  - Reserved column names are `output` and `trace`, among others.

**VERDICT: mismatch.** Wrapped as-is, each scorer's `row` parameter would bind to a dataset column named `row`, and the `None` returns aren't an allowed result.

**Fix:**
- Keep the plain functions for local runs.
- Add thin Chalk wrappers that bind to named columns and return `[]` when a scorer doesn't apply.
- Upload flattened rows.
- Use an identity task, because Andi's replies are already in the dataset.

In `chalk/evals/scorers.py`, add:
```python
import chalkcompute

def _row(replies, route, expect_route, expect_medical, expect_human):
    return {"turns": [{"andi": {"reply": r, "route": route if i == 0 else None}} for i, r in enumerate(replies)],
            "persona": {"expect": {"route": expect_route, "mentionsMedical": expect_medical, "offerHuman": expect_human}}}

@chalkcompute.function
def replay(replies: list[str]) -> str:          # task: transcripts are precomputed
    return "\n".join(replies)

def _wrap(fn):
    @chalkcompute.function(name=fn.__name__)
    def scorer(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str) -> list[chalkcompute.EvaluationScorerResult]:
        v = fn(_row(replies, first_route, expect_route, expect_medical, expect_human))
        return [] if v is None else [chalkcompute.EvaluationScorerResult(score=float(v))]
    return scorer

CHALK_SCORERS = [_wrap(s) for s in SCORERS]
```
and in `__main__`, upload flattened mappings instead of the raw JSONL:
```python
rows = [{"replies": [t["andi"]["reply"] for t in r.get("turns", [])],
         "first_route": (r.get("turns") or [{"andi": {}}])[0]["andi"].get("route") or "",
         "expect_route": r["persona"]["expect"].get("route") or "",
         "expect_medical": bool(r["persona"]["expect"].get("mentionsMedical")),
         "expect_human": bool(r["persona"]["expect"].get("offerHuman"))} for r in rows]
ds = chalkcompute.DatasetClient().upload("andi-redteam", rows)
chalkcompute.Evaluation.create("andi-safety", dataset=ds, task=replay, scorers=CHALK_SCORERS).run().wait()
```
The `@chalkcompute.function(name=...)` keyword form is an assumption. The docs show the bare decorator, and attaching by reference is covered at https://docs.chalk.ai/docs/evaluations/tasks.md. If the keyword isn't accepted, define each wrapper at module scope under its own name. The docs require functions to be importable at module scope.

## 9. Capital One Nessie (`src/nessie/client.ts`)

**What our code does:**
- Base URL `https://api.nessieisreal.com`, with the key in the `?key=` query parameter.
- `POST /customers` with `{first_name, last_name, address{street_number, street_name, city, state, zip}}`, then reads `objectCreated._id`.
- `POST /customers/{id}/accounts` with `{type: "Checking", nickname, rewards, balance}`, then reads `objectCreated._id`.
- `POST /merchants` with `{name, category: string[], address, geocode{lat,lng}}`, then reads `objectCreated._id`.
- `POST /accounts/{id}/purchases` with `{merchant_id, medium: "balance", purchase_date, amount, description}`, then reads `objectCreated`.
- `GET /accounts/{id}/purchases` and `GET /merchants/{id}`.

**What the docs and live API say:**
- Current spec, loaded by the docs page at https://nessieisreal.com/documentation: https://nessieisreal.com/nessie-openapi-spec.yaml.
  - Servers: "url: https://prod-api.nessieisreal.com" for production.
  - Auth: `ApiKeyAuth`, `in: query`, `name: key`.
  - Required fields:
    - `CustomerCreate`: `first_name`, `last_name`, `address` (all five address fields).
    - `AccountCreate`: `type`, `nickname`, `rewards`, `balance`, where `type` is `enum: [Credit Card, Savings, Checking]`.
    - `MerchantCreate`: only `name`; `category` is `type: string`.
  - **The 201 responses are a plain string**, such as `example: "Customer created"` or `example: "Merchant created"`. The string `objectCreated` appears nowhere in the spec or in the docs bundle.
  - The docs page's own merchant example shows `category:["food"]` (an array), which contradicts the schema.
  - Purchases: the spec lists only `/purchase/{purchase_id}` (get, put, delete). It has no `/accounts/{id}/purchases`.
- Live probes, read-only and with an invalid key, so nothing was created:
  - `POST https://api.nessieisreal.com/accounts/000000000000000000000000/purchases?key=invalid` with `{}` returned `"3 validation errors for PurchaseCreate\nmerchant_id\n  field required … medium\n  field required … amount\n  field required"`. The endpoint exists, and the required fields are `merchant_id`, `medium`, `amount`. We send all three.
  - `GET /merchants?key=invalid` returned `200 []` on both `api.` and `prod-api.nessieisreal.com`. Both hosts are live.
  - `POST /customers` and `POST /merchants` with an invalid key returned `Invalid API key.`. A real key would be needed to see the success body.

**VERDICT:**
- Endpoints and required fields: **correct**. Purchase routes are confirmed live but undocumented.
- **`objectCreated._id`: mismatch with the current spec.** It is unverified live, because that needs a real key. If the API now returns the documented string, `createCustomer`, `createAccount` and `createMerchant` throw `Cannot read properties of undefined`.
- **Merchant `category` array: mismatch with the spec**, and the docs contradict themselves.

**Fix A (create ids)** in `src/nessie/client.ts`. Add this helper below `call`:
```ts
async function createdId(res: unknown, lookup: () => Promise<{ _id: string }[]>, match: (x: any) => boolean) {
  const id = (res as { objectCreated?: { _id?: string } } | null)?.objectCreated?._id;
  if (id) return id;
  const found = (await lookup()).filter(match).at(-1)?._id; // spec: 201 body may be a plain string
  if (!found) throw new Error("Nessie create returned no id");
  return found;
}
```
Then change each create:

- `createCustomer`
  - old: `return r.objectCreated._id;`
  - new: `return createdId(r, () => call("GET", "/customers"), (c) => c.first_name === firstName && c.last_name === "Demo");`
- `createAccount`
  - old: `return r.objectCreated._id;`
  - new: `return createdId(r, () => call("GET", \`/customers/${customerId}/accounts\`), (a) => a.nickname === "Everyday");`
- `createMerchant`
  - old: `return r.objectCreated._id;`
  - new: `return createdId(r, () => call("GET", "/merchants"), (m) => m.name === name);`
- `createPurchase`
  - old: `return r.objectCreated;`
  - new: `return (r as any)?.objectCreated ?? { _id: "", merchant_id: merchantId, amount, purchase_date: new Date().toISOString().slice(0, 10), description };`
  - `routes/demo.ts:180` already falls back to `merchantId`.

In all four, change the generic `call<{ objectCreated: … }>` to `call<unknown>`.

**Fix B (category)** in `createMerchant`:
- old: `category,`
- new: `category: category.join(", "),`
- `isAlcoholSeller` already accepts a string.

**Optional:** set the default `NESSIE_BASE_URL` to `https://prod-api.nessieisreal.com`, the production server the spec names. `api.nessieisreal.com` responds the same today.

## 10. Daytona TS SDK (`redteam/run-redteam.ts`, `redteam/tune.ts`)

**What our code does:**
- `new Daytona({ apiKey })`.
- `daytona.create({ language: "javascript", envVars, labels, autoStopInterval: 15, ephemeral: true })`.
- `sandbox.fs.uploadFile(Buffer, "persona.json")`.
- `sandbox.process.executeCommand("node worker.cjs", undefined, env, 180)` and reads `res.result`.
- `daytona.delete(sandbox)`.

**What the docs and types say:**
- https://www.daytona.io/docs/en/typescript-sdk/daytona.md:
  - `new Daytona(config?: DaytonaConfig): Daytona;` with `apiKey?`.
  - The create params include `envVars?`, `labels?`, and "`autoStopInterval?` _number_ - Auto-stop interval in minutes". `ephemeral?`: "Whether the Sandbox should be ephemeral. If true, autoDeleteInterval will be set to 0."
  - `CodeLanguage` includes `JAVASCRIPT = "javascript"`.
  - Delete: `delete(sandbox: Sandbox, timeout?: number, wait?: boolean)`, with the example `await daytona.delete(sandbox);`.
- https://www.daytona.io/docs/en/typescript-sdk/file-system.md: `uploadFile(file: Buffer, remotePath: string, timeout?: number)`. The buffer comes first.
- https://www.daytona.io/docs/en/typescript-sdk/process.md:
  - `executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<ExecuteResponse>`. The timeout is in seconds.
  - Installed `types/ExecuteResponse.d.ts`: `{ exitCode: number; result: string; artifacts? }`.
- https://www.daytona.io/docs/en/snapshots.md: "Default snapshots include pre-installed Python and Node.js packages." So `node` is available.
- The installed `node_modules/@daytona/sdk@0.225.0` `.d.ts` files match all of the above.

**VERDICT: correct.** One nit: the SDK's own JSDoc example `executeCommand('sleep 10', undefined, 5)` puts 5 in the `env` slot. Our call uses the correct positions.

## 11. Anthropic SDK (`src/agent/brain.ts`)

**What our code does:** `new Anthropic({ apiKey })`, then `messages.create({ model: "claude-sonnet-5-5", max_tokens: 400, system: string, messages: [...history, {role:"user", content}] })`, and reads `content[].type === "text"`.

**What the docs and types say:**
- https://docs.claude.com/en/docs/about-claude/models/overview.md lists the Claude API ID `` `claude-sonnet-5-5` `` for Claude Sonnet 5.5.
- https://docs.claude.com/en/api/messages.md: "you can use the top-level `system` parameter". Also: "Consecutive `user` or `assistant` turns in your request will be combined into a single turn." So a trimmed history that starts on an assistant turn is tolerated.
- Installed `@anthropic-ai/sdk@0.135.0` `resources/messages/messages.d.ts`: `MessageCreateParamsBase` has `max_tokens: number`, `messages: Array<MessageParam>`, `model: Model`, `system?: string | Array<TextBlockParam>`. The `Model` union includes `'claude-sonnet-5-5'`.

**VERDICT: correct.**

---

## Blocked or partial sources

- `WebFetch` of https://docs.chalk.ai/docs/online-authentication was refused (permission prompt not answered). The `.md` variant was read with curl instead. That variant omits the token path, so the path comes from Chalk's official npm client.
- `http://api.nessieisreal.com/documentation` (the legacy Swagger UI) returns 503 upstream. The current docs are https://nessieisreal.com/documentation, which loads `/nessie-openapi-spec.yaml`.
- The GitHub org `nessieisreal` couldn't be searched from this session, because GitHub API access is scoped to this session's repositories.

## Evidence catalog

| Claim | Source URL | Quote | Verified twice |
| --- | --- | --- | --- |
| Photon send needs idempotency-key | https://api.photon.codes/openapi.json | `"name":"idempotency-key"` (required: true on POST /v1/projects/{id}/messages) | yes |
| Shared line limitation | https://api.photon.codes/openapi.json | "A shared iMessage line sends only in direct Spaces" | yes |
| text.update / message.delete / poll content types exist | https://api.photon.codes/openapi.json | `"const":"text.update"`, `"const":"message.delete"`, `"const":"poll"` | yes |
| Typing body semantics | https://api.photon.codes/openapi.json | "True starts or refreshes typing; false stops it." | yes |
| Mark read requires an idempotency key and has no body | https://api.photon.codes/openapi.json | "Requires Idempotency-Key." / requestBody: None | yes |
| Event apiVersion 2026-07-01 | https://api.photon.codes/openapi.json | `"const":"2026-07-01"` | yes |
| Socket.IO path | https://photon.codes/docs/beta/websocket/connect.md | ``path: `/v1/projects/${projectId}/events/ws` `` | yes |
| No session recovery | https://photon.codes/docs/beta/websocket/connect.md | "Polling and Socket.IO session recovery are disabled." | yes |
| subscribe with startSeq + apiVersion | https://photon.codes/docs/beta/websocket/session.md | `emit("subscribe", { startSeq: savedCursor, apiVersion: "2026-07-01" }` | yes |
| Cursor semantics | https://photon.codes/docs/beta/websocket/cursors.md | "If your last processed cursor is `42`, subscribe with `42`; do not add one." | yes |
| delivery event | https://photon.codes/docs/beta/websocket/events.md | "Listen for `delivery(event, metadata)`" | yes |
| Reply uses receivedBy.id as senderId | https://photon.codes/docs/beta/get-started/imessage.md | "The reply reuses the incoming message's `space.id`, `receivedBy.id`, and `id`" | yes |
| Shared line can't start a conversation | https://photon.codes/docs/beta/get-started/imessage.md | "a shared line cannot send an unsolicited first message." | yes |
| Voice not on shared iMessage | https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | "Shared iMessage assignments do not support Voice." | yes |
| Inbound voice routing | https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | "Incoming call: caller → Photon number → Voice profile → ElevenLabs agent." | yes |
| Outbound voice routing | https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | "Outgoing call: ElevenLabs agent → Photon SIP connection → recipient's phone." | yes |
| Photon inbound SIP destination | https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | `` `sips:sip.rtc.elevenlabs.io:5061` `` | yes |
| ElevenLabs import method | https://photon.codes/docs/beta/cookbooks/voice/elevenlabs.md | "Choose **From SIP Trunk**." | yes |
| Business uses dedicated lines | https://photon.codes/docs/beta/plans-and-billing.md | "Business uses dedicated lines rather than shared assignments." | yes |
| locations.request takes chat.guid | https://photon.codes/docs/advanced-kits/imessage/locations.md | "Pass a direct or group `chat.guid`, not an email or phone number." | yes |
| watch() is not replayed | https://photon.codes/docs/advanced-kits/imessage/locations.md | "Updates missed while disconnected cannot be replayed" | yes |
| Coordinates optional | https://photon.codes/docs/advanced-kits/imessage/locations.md | "Check both `latitude` and `longitude` before plotting a point" | yes |
| chats.create returns { chat } | https://photon.codes/docs/advanced-kits/imessage/chats.md | `const { chat } = await im.chats.create(["alice@example.com"]);` | yes |
| Docs page still shows the v1 root import | https://photon.codes/docs/advanced-kits/imessage/getting-started.md | `import { createClient } from "@photon-ai/advanced-imessage";` | yes |
| SDK signatures (request/list/watch, deprecated createClient) | node_modules/@photon-ai/advanced-imessage/dist/grpc.d.ts (v2.3.0) | `request(chat: string, address: string, options?: IdempotencyOptions): Promise<LocationRequestReceipt>;` / "@deprecated v1 alias" | yes |
| ElevenLabs endpoint | https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call.md | "POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call" | yes |
| ElevenLabs required body fields | https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call.md | "`agent_id` (string, required)" / "`agent_phone_number_id` (string, required)" / "`to_number` (string, required)" | yes |
| ElevenLabs dynamic variables | https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call.md | "`dynamic_variables` (map from string to any, optional)" | yes |
| ElevenLabs response has success | https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call.md | "`success` (boolean, required)" | yes |
| ElevenLabs auth header | https://elevenlabs.io/docs/api-reference/authentication.md | "xi-api-key: ELEVENLABS_API_KEY" | yes |
| ElevenLabs SIP number import | https://elevenlabs.io/docs/api-reference/phone-numbers/create.md | "POST https://api.elevenlabs.io/v1/convai/phone-numbers" / "Import Phone Number from provider configuration (Twilio, Exotel, or SIP trunk)" / "`provider` ("sip_trunk", optional, default: sip_trunk)" / "`phone_number_id` (string, required)" | yes |
| Chalk client-credentials grant | https://docs.chalk.ai/docs/online-authentication.md | "The grant_type field must always be "client_credentials"." | yes |
| Chalk token path, query path, deployment header | npm @chalk-ai/client@1.31.13, build/_services/_http.js and build/_client_http.js (linked from https://docs.chalk.ai/docs/client-typescript.md) | `path: "/v1/oauth/token"`, `path: "/v1/query/online"`, `"X-Chalk-Deployment-Type": "engine"` | yes |
| Chalk response data array | npm @chalk-ai/client@1.31.13, build/_response.js | `rawResult.data.map((d) => { return [d.field, { value: …` | yes |
| Chalk engine discovery | npm @chalk-ai/client@1.31.13, build/_services/_credentials.js | `const { engines } = yield this.get(); … engines[environmentId]` | yes |
| Chalk multi-output resolver | https://docs.chalk.ai/docs/python-resolvers.md | `def resolve(u: User.id) -> Features[User.name, User.employer]:` | yes |
| Chalk namespacing | https://docs.chalk.ai/docs/features.md | "Features are namespaced by their containing FeatureSet," | yes |
| Chalk Evaluations exists | https://docs.chalk.ai/docs/compute/evaluations.md | "An evaluation is defined by three things: a completed dataset revision, one task, and one or more scorers." | yes |
| Evaluations needs enablement | https://docs.chalk.ai/docs/compute/evaluations.md | "Before your first run, ask Chalk support to enable Evaluations and the async Function queue" | yes |
| Scorer params bind to columns | https://docs.chalk.ai/docs/evaluations/scorers.md | "Its parameters bind to dataset columns by name, plus one argument the runner supplies: output" | yes |
| Scorer return contract | https://docs.chalk.ai/docs/evaluations/scorers.md | "A scorer must return a floating point number between 0 and 1 inclusive, one EvaluationScorerResult, or a list[EvaluationScorerResult]" / "empty list emits no scores for that row." | yes |
| Dataset upload forms | https://docs.chalk.ai/docs/evaluations/datasets.md | "Upload a dataset with DatasetClient.upload(name, data)." / "a CSV or Parquet path, or a sequence of them, whose Arrow schemas match exactly," | yes |
| Nessie prod server | https://nessieisreal.com/nessie-openapi-spec.yaml | "url: https://prod-api.nessieisreal.com" | yes |
| Nessie create returns a string | https://nessieisreal.com/nessie-openapi-spec.yaml | `example: "Customer created"` / `example: "Merchant created"` (0 occurrences of objectCreated) | yes |
| Nessie required create fields | https://nessieisreal.com/nessie-openapi-spec.yaml | CustomerCreate required: first_name, last_name, address; AccountCreate required: type, nickname, rewards, balance; `enum: [Credit Card, Savings, Checking]` | yes |
| Nessie merchant category is a string | https://nessieisreal.com/nessie-openapi-spec.yaml | `category:` / `type: string` / "Category associated with the merchant" | yes |
| Nessie purchases endpoint is live, with required fields | live: POST https://api.nessieisreal.com/accounts/000000000000000000000000/purchases?key=invalid | "3 validation errors for PurchaseCreate … merchant_id … medium … amount … field required" | yes |
| Daytona constructor | https://www.daytona.io/docs/en/typescript-sdk/daytona.md | `new Daytona(config?: DaytonaConfig): Daytona;` | yes |
| Daytona ephemeral | https://www.daytona.io/docs/en/typescript-sdk/daytona.md | "Whether the Sandbox should be ephemeral. If true, autoDeleteInterval will be set to 0." | yes |
| Daytona autoStopInterval | https://www.daytona.io/docs/en/typescript-sdk/daytona.md | "`autoStopInterval?` _number_ - Auto-stop interval in minutes" | yes |
| Daytona delete | https://www.daytona.io/docs/en/typescript-sdk/daytona.md | `await daytona.delete(sandbox);` | yes |
| Daytona uploadFile argument order | https://www.daytona.io/docs/en/typescript-sdk/file-system.md | `uploadFile(file: Buffer, remotePath: string, timeout?: number)` | yes |
| Daytona executeCommand | https://www.daytona.io/docs/en/typescript-sdk/process.md | `executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number)` / "Maximum time in seconds to wait for the command to complete." | yes |
| Node in default snapshot | https://www.daytona.io/docs/en/snapshots.md | "Default snapshots include pre-installed Python and Node.js packages." | yes |
| Model ID exists | https://docs.claude.com/en/docs/about-claude/models/overview.md | `` `claude-sonnet-5-5` `` (Claude API ID row) | yes |
| system is top-level; turns merge | https://docs.claude.com/en/api/messages.md | "you can use the top-level `system` parameter" / "Consecutive `user` or `assistant` turns in your request will be combined into a single turn." | yes |
| SDK accepts the model and params | node_modules/@anthropic-ai/sdk (0.135.0) resources/messages/messages.d.ts | `'claude-sonnet-5-5'`; `system?: string \| Array<TextBlockParam>;` | yes |
| Edit/unsend/react target via parentMessageId | https://api.photon.codes/openapi.json (inferred: no target field, additionalProperties false) | not stated in the docs | no (inference) |
