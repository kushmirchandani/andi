// Imported first by every test file: isolate state and silence the outside world.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "andi-test-"));
process.env.TYPING_DELAY = "0";
process.env.LOG_LEVEL = "error";
process.env.DEMO_KEY = "test-demo";
process.env.AGENT_TEST_KEY = "test-agent";
process.env.ELEVENLABS_WEBHOOK_SECRET = "test-11";
process.env.APP_TIMEZONE = "America/New_York";
// The chip is paused in production, but the suite keeps testing it so it can come back by
// flipping a switch. test/features.test.ts covers the paused behavior.
process.env.FEATURE_CHIP = "1";
for (const k of [
  "PHOTON_API_KEY",
  "PHOTON_PROJECT_ID",
  "ANTHROPIC_API_KEY",
  "NESSIE_API_KEY",
  "CHALK_CLIENT_ID",
  "CHALK_CLIENT_SECRET",
  "ELEVENLABS_API_KEY",
  "FINDMY_IMESSAGE_ADDRESS",
  "FINDMY_IMESSAGE_TOKEN",
])
  delete process.env[k];
