# ElevenLabs Agents + Photon voice: verified integration facts

Researched 2026-10-17. Sources are the official docs, fetched as raw markdown (`<page>.md`, the same content as the HTML page). Each quote below was **re-fetched in a second pass and string-matched against the live page**. Every quote matched. One Photon quote first failed to match only because of a line break; I re-checked it by hand.

Legend: **VERIFIED** = stated verbatim in the docs. **INFERRED** = follows from the docs' schemas but isn't stated in prose. **NOT VERIFIED** = the docs don't cover it.

---

## 1. Conversation initiation client data webhook (inbound personalization)

Sources:
- https://elevenlabs.io/docs/eleven-agents/customization/personalization (section "Conversation initiation webhooks")
- https://elevenlabs.io/docs/eleven-agents/customization/personalization/twilio-personalization
- https://elevenlabs.io/docs/api-reference/workspace/update (`PATCH /v1/convai/settings`)
- https://elevenlabs.io/docs/api-reference/agents/create (`platform_settings.overrides`, `platform_settings.workspace_overrides`)
- https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking (section "Client Data and Personalization")

### Works for SIP trunk? VERIFIED: yes
> "The webhook runs for a new inbound conversation on Twilio voice, Exotel, SIP trunk, WhatsApp, or Twilio SMS when initiation client data is not already present." (personalization)

Outbound calls trigger it too, unless you pass initiation data yourself:
> "Outbound Twilio voice, Exotel, SIP, and WhatsApp calls trigger it only if the outbound request did not include `conversation_initiation_client_data`." (personalization)

It never runs in dashboard Preview:
> "Preview conversations started from the agent settings page do not trigger conversation initiation webhooks."

### Request ElevenLabs POSTs to us. VERIFIED
> "ElevenAgents sends caller context in the request body:"
```json
{
  "caller_id": "+15551234567",
  "called_number": "+15557654321",
  "agent_id": "agent_7101k5zvyjhmfg983brhmhkd98n6",
  "call_sid": "CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "conversation_id": "conv_8901k5zvyjhmfg983brhmhkd98n6"
}
```
> "`caller_id` and `called_number` are phone numbers on Twilio, Exotel, SIP, and SMS. ... On outbound calls, `caller_id` is your number and `called_number` is the person being dialed. `call_sid` is the provider call SID on telephony ... SIP calls may also include `call_id` and `sip_headers`."

- The docs don't show the shape of `sip_headers`. Code should treat it as optional, probably an object. **NOT VERIFIED**
- For SIP, caller metadata comes from SIP headers. From the SIP trunking page: "include the following custom SIP headers in your webhook payload and SIP INVITE request: **X-CALL-ID** ... **X-CALLER-ID**". Without them, "the system will automatically look for the Twilio-specific SIP header: **sip.twilio.callSid**".
- The Photon docs don't say whether Photon sets `X-CALLER-ID`/`X-CALL-ID` or how the From header is populated. **NOT VERIFIED**: on SIP calls through Photon, `call_sid` could be empty, and `caller_id` could be in a format other than E.164. Log the first real payload before relying on it.

### Response we must return. VERIFIED
> "Your response must use the `conversation_initiation_client_data` shape above. Include every custom dynamic variable the agent defines. Overrides are optional and must be enabled in **Security**. The HTTP response body must be 256 KB or smaller (262,144 bytes)."

> "System dynamic variables (those prefixed with `system__`) cannot be sent or overridden in the client initiation payload."

> "A failed or timed-out webhook can prevent the conversation from starting."

The full documented shape (personalization page):
```json
{
  "type": "conversation_initiation_client_data",
  "conversation_config_override": {
    "agent": { "prompt": { "prompt": "...", "llm": "..." }, "first_message": "...", "language": "en" },
    "tts": { "voice_id": "..." },
    "conversation": { "text_only": false },
    "asr": { "keywords": ["..."] }
  },
  "custom_llm_extra_body": { "temperature": 0.7, "max_tokens": 100 },
  "dynamic_variables": { "string_var": "text value", "number_var": 1.2, "integer_var": 123, "boolean_var": true },
  "user_id": "your_custom_user_id",
  "branch_id": "agtbrch_xxxx",
  "environment": "production"
}
```
Dynamic variable values must be strings, numbers or booleans: "Values are strings, numbers, or booleans only" (dynamic-variables page). The docs give no timeout value. They say only "Ensure your webhook responds within a reasonable timeout period".

### Where it's configured. VERIFIED
1. **Workspace settings** hold the webhook URL and header secrets: "Configure the webhook URL and header secrets in [Agents settings](https://elevenlabs.io/app/agents/settings)." The API equivalent is `PATCH https://api.elevenlabs.io/v1/convai/settings` with `conversation_initiation_client_data_webhook: { url (required), request_headers (required) }`.
2. **Per agent**, on the Security tab: "enable **Fetch initiation client data from a webhook** and any override fields your response may include." The API field is `platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook` ("boolean, optional, default: false").
3. An agent can also override the workspace URL through `platform_settings.workspace_overrides.conversation_initiation_client_data_webhook`, documented as "The webhook to send conversation initiation client data to" (agents/create). The dashboard location for this per-agent override is **NOT VERIFIED**.

### Authentication. VERIFIED: static header secrets, no HMAC
- "In the settings page of ElevenAgents, configure the webhook URL and add any secrets needed for authentication." / "Click on the webhook to modify which secrets are sent in the headers." (twilio-personalization)
- Security section: "Use HTTPS endpoints only · Implement authentication using request headers · Store sensitive values as secrets through the ElevenLabs secrets manager · Validate the incoming request parameters".
- The docs **do not** document an HMAC signature for this webhook. HMAC (`ElevenLabs-Signature`) is documented only for post-call webhooks.
- Recommendation: store a secret in ElevenLabs, send it as a header such as `X-Webhook-Secret` (the header name is our choice), and compare it in constant time on our side. Optionally also check that `agent_id` matches ours.

---

## 2. Server tools (webhook tools)

Sources:
- https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools
- https://elevenlabs.io/docs/api-reference/tools/create (`WebhookToolApiSchemaConfig-Input`, `LiteralJsonSchemaProperty`)
- https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables

### HTTP config. VERIFIED
- `tool_config.type = "webhook"`, plus `name`, `description` and `api_schema` (all required).
- `api_schema` fields:
  - `url`: required. "May include path parameters, e.g. https://example.com/agents/{agent_id}".
  - `method`: "default: GET". Allowed values: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
  - `request_headers`: map of headers.
  - `path_params_schema` and `query_params_schema`: these take literal properties only.
  - `request_body_schema`: an object schema "sent as the json body".
  - `content_type`: `application/json` (default) or `application/x-www-form-urlencoded`.
  - `auth_connection`, `response_filter`.
- Other tool-level fields: `response_timeout_secs` ("default: 20", "Must be between 5 and 300 seconds (inclusive)"), `execution_mode` (`immediate` | `post_tool_speech` | `async`), `assignments` (extracts response values into dynamic variables using dot paths), `pre_tool_speech`, `interruption_mode`, `tool_call_sound`.
- Each parameter has exactly one value source: "Only ONE of the following fields can be set: description (LLM provides value), dynamic_variable (value from variable), is_system_provided (system provides value), constant_value (fixed value), or is_omitted". So:
  - an LLM-filled parameter is `{"type":"string","description":"..."}`
  - a caller-ID parameter is `{"type":"string","dynamic_variable":"system__caller_id"}`
- The webhook-tools page: "the assistant generates query, body, and path parameters dynamically based on the conversation and parameter descriptions you provide."
- `{{var}}` templating is also documented in prompts, first messages and "Tool parameters and headers".
- Auth for tools: header type **Secret** ("selecting **Secret** as the header type, and clicking **Create New Secret**"), custom headers, Basic, OAuth2 client credentials, or OAuth2 JWT.
- **INFERRED:** a header value can be a plain string, `{"secret_id": "..."}` (`ConvAISecretLocator`) or `{"variable_name": "..."}` (`ConvAIDynamicVariable`). Both types appear on the tools/create page, but the header union is rendered empty in the markdown.

### System dynamic variables. VERIFIED (verbatim list, dynamic-variables page)
| Variable | Doc text |
|---|---|
| `system__agent_id` | Unique identifier of the agent that initiated the conversation |
| `system__current_agent_id` | Currently active agent (changes after transfers) |
| `system__caller_id` | "Caller's phone number (voice calls only)" |
| `system__called_number` | "Destination phone number (voice calls only)" |
| `system__call_duration_secs` | Call duration in seconds |
| `system__time_utc` / `system__time` / `system__timezone` | Time values |
| `system__conversation_id` | "ElevenLabs' unique conversation identifier" |
| `system__call_sid` | "Call SID (twilio calls only)" |
| `system__call_id` | "Unique identifier for the SIP trunk call (SIP trunk calls only)" |
| `system__agent_turns`, `system__current_agent_turns`, `system__current_subagent_turns` | Turn counters |
| `system__is_text_only` | Text-only flag |
| `system__conversation_history` | JSON conversation history |

Notes:
- **Use `system__call_id`, not `system__call_sid`, for SIP trunk (Photon) calls.**
- Inbound SIP `X-` headers become `{{sip_<name>}}`, e.g. "`X-Contact-ID` becomes `{{sip_contact_id}}`" (sip-trunking).
- `secret__`-prefixed variables are never sent to the LLM and are "returned redacted as `<REDACTED>`".

---

## 3. Outbound call via SIP trunk. VERIFIED
Source: https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call (also mirrored at /docs/eleven-agents/api-reference/sip-trunk/outbound-call)

> "POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"

Body:
- `agent_id` (string, required)
- `agent_phone_number_id` (string, required)
- `to_number` (string, required)
- `conversation_initiation_client_data` (optional, nullable). It contains `dynamic_variables` ("map from string to any"), `conversation_config_override`, `user_id`, `branch_id`, `environment`, `source_info`, `custom_llm_extra_body`, and others.
- `telephony_call_config` (optional): `ringing_timeout_secs`, default 60.

Note that the request-side type (`ConversationInitiationClientDataRequest-Input`) does **not** list a `type` field. Leave `"type"` out here. That field belongs in the webhook response.

Response (200):
```json
{ "success": true, "message": "string", "conversation_id": "string", "sip_call_id": "string" }
```
`conversation_id` and `sip_call_id` are nullable. A 422 response contains `detail[]`.

The auth header isn't shown in the page's generated samples. The usual ElevenLabs `xi-api-key` header is **NOT VERIFIED on this page**.

---

## 4. Post-call webhooks. VERIFIED
Source: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks

- Event types: `post_call_transcription`, `post_call_audio`, `call_initiation_failure`. The workspace settings `events` enum also lists `answering_machine_detection`, `unredacted_transcript` and `unredacted_audio`.
- Envelope: `{ "type", "event_timestamp", "data" }`. For transcription events, `data` includes `agent_id`, `conversation_id`, `status`, `transcript`, `metadata`, `analysis` and `conversation_initiation_client_data`.
- A SIP `call_initiation_failure` event has `data.metadata.type = "sip"` with `body.{from_number,to_number,sip_status_code,error_reason,call_sid,sip_status}`.
- Configured at workspace level: "Post-call webhooks can be enabled for all agents in your workspace through the ElevenAgents settings page".
- Auth: "Webhooks currently support authentication via HMAC signatures." Verify the `ElevenLabs-Signature` header with the SDK's `constructEvent` / `construct_event`. Requires the raw body.
- "Post-call webhooks must return a 200 status code to be considered successful."

---

## 5. Photon voice to ElevenLabs over SIP (Beta docs)
Sources:
- https://photon.codes/docs/beta/cookbooks/voice/elevenlabs ("Set up Photon with ElevenLabs")
- https://photon.codes/docs/beta/get-started/voice ("Build a voice agent")

The HTML index at https://photon.codes/docs/beta could not be opened with WebFetch (the permission prompt timed out). The pages were read through their `.md` endpoints, found via https://photon.codes/docs/llms.txt.

Steps, all **VERIFIED**:
1. **Photon side: create or open the Voice profile.** Go to Photon project → **Voice** → **Lines** → **Set up default** → **SIP** → **Create profile**. Eligible numbers: "SMS number, WhatsApp number, or dedicated iMessage line. Shared iMessage assignments do not support Voice."
2. **Photon outbound credentials.** Open **Outbound calls** → "**SHA-256 (recommended)** under **Digest algorithm**" → **Enable outbound**. Save the password: "Photon displays this password once." Note the SIP connection server and port (example `sip.photon.codes:5061`, TLS) and the **Username**.
3. **Import the number in ElevenLabs.** Go to **Deploy → Phone Numbers → Import number → From SIP Trunk**. Enter a Label and the Photon number in E.164.
   - Inbound settings: Media Encryption **Allowed**; Allowed Numbers empty; Allowed Source IPs `0.0.0.0/0`; Remote Domains empty; inbound SIP username and password empty (optional).
   - Outbound settings: Address = Photon server and TLS port, e.g. `sip.photon.codes:5061` ("Omit the `sip:` or `sips:` URI prefix."). Transport **TLS**, Media Encryption **Allowed**, codecs "Keep **G.722**, **PCMU**, and **PCMA** selected". SIP Trunk Username and Password = the Photon outbound credentials.
4. **Assign the agent.** On the imported number, set **Agent** (and **Branch** / "Follow traffic split").
5. **Photon inbound destination.** Under **Inbound calls** → **Enable inbound**, set SIP address `sips:sip.rtc.elevenlabs.io:5061` with Transport **TLS**. Leave credentials empty unless inbound auth was set in ElevenLabs; if it was, enter the same pair here.
6. **Test.** Call the number. For outbound, use ElevenLabs **Outbound call** → **Send Test Call**. The API equivalent is section 3, with `agent_phone_number_id` = the imported number's ID.
7. **Media encryption.** "use **Auto** in Photon and **Allowed** in ElevenLabs". To require SRTP, use Photon "Require encrypted calls" together with ElevenLabs "Required".
8. **TLS troubleshooting.** If BYE or REFER fails certificate validation, add the domain on Photon's SIP certificate to **Remote Domains** in ElevenLabs.

ElevenLabs' side of this matches: "**TLS**: `sip:sip.rtc.elevenlabs.io:5061;transport=tls`", and "ElevenLabs presents a valid certificate for `sip.rtc.elevenlabs.io`" (sip-trunking page).

NOT VERIFIED: the Photon docs don't cover whether Photon forwards the original caller ID or sets `X-CALLER-ID` / `X-CALL-ID`, or whether it lets you add custom X- headers on inbound INVITEs.

---

## Recommended JSON (concrete)

### A. Initiation webhook: request we should expect (Photon SIP inbound)
```json
{
  "caller_id": "+13055551234",
  "called_number": "+13055550000",
  "agent_id": "agent_xxx",
  "call_sid": "",
  "conversation_id": "conv_xxx",
  "call_id": "<sip call id, may be present>",
  "sip_headers": { "...": "may be present; shape not documented" }
}
```
Headers: `Content-Type: application/json` plus our configured secret header, e.g. `X-Webhook-Secret: <secret>`. Treat `call_sid`, `call_id` and `sip_headers` as optional.

### B. Initiation webhook: response we return
```json
{
  "type": "conversation_initiation_client_data",
  "dynamic_variables": {
    "user_name": "Kush",
    "user_id": "usr_123",
    "is_known_caller": true
  },
  "conversation_config_override": {
    "agent": { "first_message": "Hey Kush, good to hear from you. How are you doing today?" }
  },
  "user_id": "usr_123"
}
```
Rules:
- Include **every** custom dynamic variable the agent defines, using fallback values for unknown callers.
- Values must be string, number or boolean.
- No `system__` keys.
- Only send override fields that are enabled on the agent's Security tab.
- Keep the body under 256 KB.
- Always answer quickly with a 200. A failure can stop the call from starting.

### C. Server (webhook) tool definition
```json
{
  "type": "webhook",
  "name": "log_checkin",
  "description": "Record how the caller is doing when they share a check-in.",
  "response_timeout_secs": 10,
  "api_schema": {
    "url": "https://api.example.com/elevenlabs/tools/log-checkin",
    "method": "POST",
    "content_type": "application/json",
    "request_headers": { "X-Tool-Secret": { "secret_id": "<elevenlabs secret id>" } },
    "request_body_schema": {
      "type": "object",
      "required": ["mood", "note"],
      "properties": {
        "mood":            { "type": "string", "description": "Caller's mood in one word" },
        "note":            { "type": "string", "description": "Short summary of what the caller said" },
        "caller_id":       { "type": "string", "dynamic_variable": "system__caller_id" },
        "conversation_id": { "type": "string", "dynamic_variable": "system__conversation_id" },
        "call_id":         { "type": "string", "dynamic_variable": "system__call_id" }
      }
    }
  }
}
```
The `{ "secret_id": ... }` header form is INFERRED from `ConvAISecretLocator`. If the dashboard doesn't accept it, use the dashboard's Secret header type.

The body our endpoint receives (INFERRED from the schema):
```json
{ "mood": "okay", "note": "...", "caller_id": "+13055551234", "conversation_id": "conv_xxx", "call_id": "..." }
```

### D. Outbound call via SIP trunk
```http
POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call
xi-api-key: <key>            (header name not shown on the reference page)
Content-Type: application/json
```
```json
{
  "agent_id": "agent_xxx",
  "agent_phone_number_id": "phnum_xxx",
  "to_number": "+13055551234",
  "conversation_initiation_client_data": {
    "dynamic_variables": { "user_name": "Kush", "user_id": "usr_123", "is_known_caller": true },
    "user_id": "usr_123"
  }
}
```
Response:
```json
{ "success": true, "message": "...", "conversation_id": "conv_xxx", "sip_call_id": "..." }
```
Passing `conversation_initiation_client_data` here means the initiation webhook will **not** fire for this outbound call.

### E. Post-call webhook (optional)
```json
{ "type": "post_call_transcription", "event_timestamp": 1760000000, "data": { "agent_id": "...", "conversation_id": "...", "status": "done", "transcript": [], "metadata": {}, "analysis": {}, "conversation_initiation_client_data": {} } }
```
Verify `ElevenLabs-Signature` (HMAC) against the raw body. Return 200.

---

## Evidence catalog (internal)
| # | Claim | URL | Pass 1 | Pass 2 |
|---|---|---|---|---|
| 1 | Webhook runs for SIP trunk inbound | elevenlabs.io/docs/eleven-agents/customization/personalization | read | string-matched |
| 2 | Request body fields + SIP `call_id`/`sip_headers` | same | read | matched |
| 3 | 256 KB limit; failure can block call | same | read | matched |
| 4 | Outbound triggers only without client data | same | read | matched |
| 5 | URL + header secrets in Agents settings; Security tab toggle | same + /personalization/twilio-personalization | read | matched |
| 6 | `dynamic_variables` must include all agent vars | /personalization/twilio-personalization | read | matched |
| 7 | Settings API `conversation_initiation_client_data_webhook{url,request_headers}` | elevenlabs.io/docs/api-reference/workspace/update | read | matched |
| 8 | Agent flag `enable_conversation_initiation_client_data_from_webhook`, `workspace_overrides` | elevenlabs.io/docs/api-reference/agents/create | read | matched |
| 9 | System variables list incl. `system__call_id` (SIP), `system__call_sid` (Twilio) | /personalization/dynamic-variables | read | matched |
| 10 | X-CALLER-ID / X-CALL-ID, `sip_` header vars, TLS 5061 address | elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking | read | matched |
| 11 | Webhook tool schema (method enum, dynamic_variable, timeout 5–300) | elevenlabs.io/docs/api-reference/tools/create | read | matched |
| 12 | LLM generates params; Secret header type | elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools | read | matched |
| 13 | SIP outbound endpoint, body, response | elevenlabs.io/docs/api-reference/sip-trunk/outbound-call | read | matched |
| 14 | Post-call types + HMAC `ElevenLabs-Signature` | elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks | read | matched |
| 15 | Photon steps: SHA-256, one-time password, `sip.photon.codes:5061`, `sips:sip.rtc.elevenlabs.io:5061`, TLS, codecs, Auto/Allowed | photon.codes/docs/beta/cookbooks/voice/elevenlabs | read | matched (SHA-256 line checked by hand because of a line break) |
| 16 | Photon get-started voice confirms inbound destination + TLS | photon.codes/docs/beta/get-started/voice | read | read |

Unverified items:
- the shape of `sip_headers`
- whether Photon sets X-CALLER-ID or forwards caller ID
- an exact timeout for the initiation webhook
- the auth header name on the SIP outbound reference page
- the dashboard location of the per-agent webhook URL override
- the object form for tool header values
