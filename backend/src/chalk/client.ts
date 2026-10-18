// Chalk serves the live risk score. We send the current signals as query inputs and
// ask for person.risk_score / person.risk_level / person.risk_reasons (see chalk/features.py).
// If Chalk isn't configured or the call fails, we compute the same function locally.
//
// REST shapes verified against docs.chalk.ai/docs/online-authentication and Chalk's official
// TypeScript client (@chalk-ai/client): POST /v1/oauth/token (client credentials), then
// POST /v1/query/online with X-Chalk-Deployment-Type: engine and X-Chalk-Env-Id.

import { config, enabled } from "../config.js";
import { fetchWithRetry } from "../http.js";
import { log } from "../log.js";
import { DEFAULT_THRESHOLDS, scoreRisk, type RiskResult, type RiskSignals } from "../risk/score.js";
import { summarizePatterns, type PatternInputs, type PatternSummary } from "../risk/patterns.js";

// The token response can also name the environment and its query engine; used when
// CHALK_ENGINE_URL / CHALK_ENVIRONMENT_ID aren't set (same as Chalk's official TS client).
let cached: { token: string; expiresAt: number; engineUrl?: string; envId?: string } | null = null;

// Circuit breaker: after a failure, use the local score for a minute instead of paying the
// timeout on every signal. Exposed for /health.
const BREAKER_MS = 60_000;
export const chalkStatus = { lastOkAt: null as string | null, lastError: null as string | null, openUntil: 0 };

async function accessToken() {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const res = await fetchWithRetry("chalk", `${config.chalk.apiServer}/v1/oauth/token`, {
    timeoutMs: 5_000,
    retries: 1,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.chalk.clientId,
      client_secret: config.chalk.clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    cached = null;
    throw new Error(`Chalk token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    primary_environment?: string;
    engines?: Record<string, string>;
  };
  const envId = config.chalk.envId || body.primary_environment || undefined;
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    envId,
    engineUrl: config.chalk.engineUrl || (envId ? body.engines?.[envId] : undefined) || undefined,
  };
  return cached.token;
}

const toInputs = (personId: string, s: RiskSignals) => ({
  "person.id": personId,
  "person.hour": s.hour,
  "person.weekday": s.weekday,
  "person.near_risk_place": s.nearRiskPlace,
  "person.minutes_since_place_enter": s.minutesSincePlaceEnter ?? -1,
  "person.minutes_since_alcohol_purchase": s.minutesSinceAlcoholPurchase ?? -1,
  "person.halt_count": s.haltCount,
  "person.hours_since_checkin": s.hoursSinceCheckin ?? -1,
  "person.hours_silent": s.hoursSilent ?? -1,
  "person.days_sober": s.daysSober,
  "person.days_since_slip": s.daysSinceSlip ?? -1,
});

export interface ScoredRisk extends RiskResult {
  source: "chalk" | "local";
}

export async function getRisk(personId: string, s: RiskSignals): Promise<ScoredRisk> {
  if (enabled.chalk() && Date.now() >= chalkStatus.openUntil) {
    try {
      const token = await accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-chalk-deployment-type": "engine",
      };
      const envId = cached?.envId ?? config.chalk.envId;
      if (envId) headers["x-chalk-env-id"] = envId;
      const engine = (cached?.engineUrl ?? config.chalk.engineUrl ?? "") || config.chalk.apiServer;
      // Risk is on the hot path of every signal: keep the timeout short and fall back locally.
      const res = await fetchWithRetry("chalk", `${engine.replace(/\/+$/, "")}/v1/query/online`, {
        timeoutMs: 2_500,
        retries: 0,
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: toInputs(personId, s),
          outputs: ["person.risk_score", "person.risk_level", "person.risk_reasons"],
        }),
      });
      if (res.status === 401) cached = null; // token revoked or expired early
      if (!res.ok) throw new Error(`Chalk query ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: { field: string; value: unknown }[] };
      const get = (f: string) => body.data?.find((d) => d.field === f)?.value;
      const score = Number(get("person.risk_score"));
      const level = String(get("person.risk_level")) as RiskResult["level"];
      const reasonsRaw = get("person.risk_reasons");
      const reasons = Array.isArray(reasonsRaw)
        ? reasonsRaw.map(String)
        : String(reasonsRaw ?? "").split("|").filter(Boolean);
      if (!Number.isNaN(score) && ["low", "elevated", "high"].includes(level)) {
        chalkStatus.lastOkAt = new Date().toISOString();
        return { score, level, reasons, source: "chalk" };
      }
      throw new Error("Unexpected Chalk response shape");
    } catch (err) {
      chalkStatus.lastError = (err as Error).message;
      chalkStatus.openUntil = Date.now() + BREAKER_MS;
      log.warn("chalk", "falling back to local risk for 60s", err);
    }
  }
  return { ...scoreRisk(s, DEFAULT_THRESHOLDS), source: "local" };
}

// MARK: Learned patterns ("Andi learns you")

// Patterns change slowly and aren't on a hot path: a slightly longer timeout, and a failure only
// means this refresh uses the local summary (it doesn't trip the risk breaker).
const encodeWindow = (w: PatternSummary["riskyWindow"]) => (w ? `${w.weekday ?? "*"}:${w.startHour}:${w.hours}` : "");
export function decodeWindow(raw: string): PatternSummary["riskyWindow"] {
  const [w, h, n] = raw.split(":");
  if (h === undefined || n === undefined) return null;
  return { weekday: w === "*" ? null : Number(w), startHour: Number(h), hours: Number(n) };
}

export async function getPatterns(personId: string, i: PatternInputs): Promise<PatternSummary & { source: "chalk" | "local" }> {
  if (enabled.chalk() && Date.now() >= chalkStatus.openUntil) {
    try {
      const token = await accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-chalk-deployment-type": "engine",
      };
      const envId = cached?.envId ?? config.chalk.envId;
      if (envId) headers["x-chalk-env-id"] = envId;
      const engine = (cached?.engineUrl ?? config.chalk.engineUrl ?? "") || config.chalk.apiServer;
      const res = await fetchWithRetry("chalk", `${engine.replace(/\/+$/, "")}/v1/query/online`, {
        timeoutMs: 5_000,
        retries: 0,
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: {
            "person.id": personId,
            "person.history_days": i.historyDays,
            "person.hard_moments": i.hardMoments,
            "person.halt_counts": i.halt,
            "person.place_enters": i.placeEnters,
            "person.interventions": i.interventions,
          },
          outputs: [
            "person.patterns_ready",
            "person.risky_window",
            "person.top_trigger",
            "person.what_helped",
            "person.pattern_confidence",
          ],
        }),
      });
      if (res.status === 401) cached = null;
      if (!res.ok) throw new Error(`Chalk patterns ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: { field: string; value: unknown }[] };
      const get = (f: string) => body.data?.find((d) => d.field === f)?.value;
      const ready = get("person.patterns_ready");
      const confidence = Number(get("person.pattern_confidence"));
      if (typeof ready !== "boolean" || Number.isNaN(confidence)) throw new Error("Unexpected Chalk patterns shape");
      const str = (f: string) => String(get(f) ?? "");
      chalkStatus.lastOkAt = new Date().toISOString();
      return {
        ready,
        riskyWindow: decodeWindow(str("person.risky_window")),
        topTrigger: (str("person.top_trigger") || null) as PatternSummary["topTrigger"],
        whatHelped: (str("person.what_helped") || null) as PatternSummary["whatHelped"],
        confidence,
        source: "chalk",
      };
    } catch (err) {
      log.warn("chalk", "patterns query failed, using the local summary", err);
    }
  }
  return { ...summarizePatterns(i), source: "local" };
}

export { encodeWindow };
