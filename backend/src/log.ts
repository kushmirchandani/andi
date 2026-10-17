// Minimal structured logger. One line per entry: time, level, area, message.
// LOG_LEVEL=debug|info|warn|error (default info). Never log tokens, keys or message bodies at info.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) || "info"] ?? ORDER.info;

function fmtErr(e: unknown) {
  if (e instanceof Error) return process.env.LOG_LEVEL === "debug" ? (e.stack ?? e.message) : e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

function emit(level: Level, area: string, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${area}] ${msg}${extra === undefined ? "" : ` ${fmtErr(extra)}`}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (area: string, msg: string, extra?: unknown) => emit("debug", area, msg, extra),
  info: (area: string, msg: string, extra?: unknown) => emit("info", area, msg, extra),
  warn: (area: string, msg: string, extra?: unknown) => emit("warn", area, msg, extra),
  error: (area: string, msg: string, extra?: unknown) => emit("error", area, msg, extra),
};

// Mask a phone number or email for logs: +1617•••4567, m•••@icloud.com
export function mask(handle: string | undefined) {
  if (!handle) return "?";
  if (handle.includes("@")) {
    const [u, d] = handle.split("@");
    return `${u.slice(0, 1)}•••@${d}`;
  }
  return handle.length > 8 ? `${handle.slice(0, 5)}•••${handle.slice(-4)}` : "•••";
}
