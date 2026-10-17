// Central config. Every sponsor integration is optional: when its keys are
// missing the backend falls back to a local implementation so the demo still runs.

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

const isProd = env("NODE_ENV") === "production";

export const config = {
  isProd,
  version: env("FLY_IMAGE_REF", env("APP_VERSION", "dev")),
  port: Number(env("PORT", "8080")),
  publicUrl: env("PUBLIC_URL", "http://localhost:8080").replace(/\/+$/, ""),
  dataDir: env("DATA_DIR", "./data"),
  timezone: env("APP_TIMEZONE", "America/New_York"),
  // Demo and red-team routes are disabled in production unless a real key is set.
  demoKey: env("DEMO_KEY", isProd ? "" : "dev-demo-key"),
  testKey: env("AGENT_TEST_KEY", isProd ? "" : "dev-test-key"),
  // Quiet hours (local time) for proactive nudges and milestone texts. Replies are never delayed.
  quietStartHour: Number(env("QUIET_START_HOUR", "2")),
  quietEndHour: Number(env("QUIET_END_HOUR", "9")),

  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
  },

  photon: {
    apiKey: env("PHOTON_API_KEY"),
    projectId: env("PHOTON_PROJECT_ID"),
    origin: env("PHOTON_API_ORIGIN", "https://api.photon.codes"),
    apiVersion: env("PHOTON_API_VERSION", "2026-07-01"),
    // The number Photon assigned to the agent (shown in the iOS app so the user can text it first).
    agentHandle: env("PHOTON_AGENT_HANDLE"),
    // Voice-capable Photon number (SIP to the ElevenLabs agent). Andi calls from it and people can call it.
    voiceNumber: env("PHOTON_VOICE_NUMBER"),
  },

  nessie: {
    apiKey: env("NESSIE_API_KEY"),
    baseUrl: env("NESSIE_BASE_URL", "https://api.nessieisreal.com"),
  },

  chalk: {
    clientId: env("CHALK_CLIENT_ID"),
    clientSecret: env("CHALK_CLIENT_SECRET"),
    apiServer: env("CHALK_API_SERVER", "https://api.chalk.ai"),
    // Query engine URL from the Chalk dashboard; defaults to the API server.
    engineUrl: env("CHALK_ENGINE_URL"),
    envId: env("CHALK_ENVIRONMENT_ID"),
  },

  elevenlabs: {
    apiKey: env("ELEVENLABS_API_KEY"),
    agentId: env("ELEVENLABS_AGENT_ID"),
    agentPhoneNumberId: env("ELEVENLABS_PHONE_NUMBER_ID"),
    // Shared secret ElevenLabs sends to our webhooks (personalization / tools). Optional.
    webhookSecret: env("ELEVENLABS_WEBHOOK_SECRET"),
  },

  // Advanced iMessage SDK line credentials, used only for Find My locations.
  findmy: {
    address: env("FINDMY_IMESSAGE_ADDRESS"), // host:port, no https://
    token: env("FINDMY_IMESSAGE_TOKEN"),
  },

  daytona: {
    apiKey: env("DAYTONA_API_KEY"),
  },
};

export const enabled = {
  anthropic: () => Boolean(config.anthropic.apiKey),
  photon: () => Boolean(config.photon.apiKey && config.photon.projectId),
  nessie: () => Boolean(config.nessie.apiKey),
  chalk: () => Boolean(config.chalk.clientId && config.chalk.clientSecret),
  elevenlabs: () =>
    Boolean(config.elevenlabs.apiKey && config.elevenlabs.agentId && config.elevenlabs.agentPhoneNumberId),
  findmy: () => Boolean(config.findmy.address && config.findmy.token),
  demo: () => Boolean(config.demoKey),
  agentTest: () => Boolean(config.testKey),
};

// Warnings printed at boot so a misconfigured deploy is obvious in `fly logs`.
export function configWarnings() {
  const w: string[] = [];
  if (enabled.photon() && !config.photon.agentHandle)
    w.push("PHOTON_AGENT_HANDLE is empty: the app can't show people which number to text.");
  if (config.isProd && config.publicUrl.startsWith("http://"))
    w.push("PUBLIC_URL is http:// in production: sponsor links and the chip WebSocket URL will be wrong.");
  if (config.isProd && !process.env.DATA_DIR) w.push("DATA_DIR not set in production: data won't survive a deploy.");
  if (!enabled.anthropic()) w.push("ANTHROPIC_API_KEY not set: Andi uses rule-based replies.");
  if (config.chalk.clientId && !config.chalk.engineUrl)
    w.push("CHALK_ENGINE_URL not set: querying the API server directly (fine if your environment routes queries there).");
  return w;
}
