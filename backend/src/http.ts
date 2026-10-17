// Shared HTTP helpers: typed API errors, an in-memory rate limiter, and outbound fetch
// with a timeout and retries (for Photon, Chalk, Nessie, ElevenLabs).

import type { Context, MiddlewareHandler } from "hono";
import { log } from "./log.js";

// Every error the API returns has this shape: { error: "<code>", message: "<safe to show>" }.
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string, extra?: Record<string, unknown>) => ({ error: code, message, ...extra });

// Fixed-window limiter keyed by client IP (Fly sets Fly-Client-IP) or a custom key.
export function rateLimit(opts: { windowMs: number; max: number; key?: (c: Context) => string }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs).unref();
  return async (c, next) => {
    const key = opts.key?.(c) ?? clientIp(c);
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.resetAt <= now) hits.set(key, { count: 1, resetAt: now + opts.windowMs });
    else if (++h.count > opts.max) {
      c.header("retry-after", String(Math.ceil((h.resetAt - now) / 1000)));
      return c.json(errorBody("rate_limited", "Too many requests. Give it a moment and try again."), 429);
    }
    await next();
  };
}

export function clientIp(c: Context) {
  return (
    c.req.header("fly-client-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local"
  );
}

export class UpstreamError extends Error {
  constructor(
    public service: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// fetch with a timeout, and retries on network errors / 429 / 5xx. Callers pass an
// idempotency key in headers when the upstream supports it, so retries never double-send.
export async function fetchWithRetry(
  service: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, retries = 2, ...rest } = init;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = retryAfterMs(res) ?? backoff(attempt);
        log.warn(service, `${res.status} from upstream, retrying in ${wait} ms`);
        await res.body?.cancel();
        await sleep(wait);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw new UpstreamError(service, 0, `${service} unreachable: ${(err as Error).message}`);
      const wait = backoff(attempt);
      log.warn(service, `network error, retrying in ${wait} ms`, err);
      await sleep(wait);
      attempt++;
    }
  }
}

const backoff = (attempt: number) => Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 150);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response) {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const s = Number(h);
  return Number.isFinite(s) ? Math.min(10_000, s * 1000) : null;
}
