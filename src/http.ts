/**
 * A thin, rate-limited, retrying HTTP layer shared by every Vendor Center call.
 *
 * Two things the published docs call out that this module exists to handle:
 *
 * 1. Rate limits are enforced per Mastershop: 200 requests/minute, capped at
 *    4 requests/second (see "Getting started" in the docs). Blow through that
 *    and you start getting throttled/rejected, which is worse for a bulk sync
 *    job than just pacing requests in the first place.
 *
 * 2. Error response bodies are NOT consistent across services, even though
 *    they're all part of the same document:
 *      - Catalog and Consignment endpoints return   {code, message}
 *      - Shops and Feeds endpoints return            {timestamp, status, error, path}
 *      - Payments endpoints return                   {message, status}
 *      - GOP (orders) endpoints return either         {message, status}
 *                                               or     {timestamp, status, error, message}
 *      - Auth (login/token) endpoints return the OAuth2 shape {error, error_description}
 *    `normalizeError` below picks a human-readable message out of whichever
 *    shape actually comes back, so callers don't have to special-case this
 *    per endpoint.
 */
import type { TokenManager } from "./auth.ts";

export class ApiError extends Error {
  statusCode: number;
  body: Record<string, unknown>;

  constructor(statusCode: number, message: string, body: Record<string, unknown> = {}) {
    super(`HTTP ${statusCode}: ${message}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

export function normalizeError(statusCode: number, body: Record<string, unknown>): string {
  for (const key of ["error_description", "message", "error"]) {
    if (typeof body[key] === "string") {
      return body[key] as string;
    }
  }
  const inner = body["error"];
  if (inner && typeof inner === "object") {
    for (const key of ["message", "description"]) {
      const val = (inner as Record<string, unknown>)[key];
      if (typeof val === "string") {
        return val;
      }
    }
  }
  return `request failed with no parseable error body (HTTP ${statusCode})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple sliding-window limiter: N requests per second and per minute. */
class RateLimiter {
  private readonly perSecond: number;
  private readonly perMinute: number;
  private recent: number[] = [];

  constructor(perSecond: number, perMinute: number) {
    this.perSecond = perSecond;
    this.perMinute = perMinute;
  }

  // No explicit Mutex needed here (unlike Python's asyncio.Lock-guarded
  // version): the check-then-push below has no `await` between them, and
  // JS/Node run synchronous code to completion before yielding to any
  // other queued async task - so two concurrent callers can never both
  // read a stale `this.recent` and both push past the limit. The retry
  // loop's `await sleep(...)` is the only yield point, and each resumption
  // re-runs the whole check+push atomically again from there.
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t <= 60_000);

      const lastSecond = this.recent.filter((t) => now - t <= 1_000).length;
      if (this.recent.length < this.perMinute && lastSecond < this.perSecond) {
        this.recent.push(now);
        return;
      }

      let wait: number;
      if (lastSecond >= this.perSecond) {
        const earliestInLastSecond = this.recent.filter((t) => now - t <= 1_000)[0];
        wait = 1_000 - (now - earliestInLastSecond);
      } else {
        wait = 60_000 - (now - this.recent[0]);
      }
      await sleep(Math.max(wait, 50));
    }
  }
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  jsonBody?: unknown;
}

/**
 * Wraps a fetch-based HTTP client with auth, rate limiting, and
 * retry/backoff. One instance should be shared across an entire server
 * process.
 */
export class VendorApiHttp {
  private readonly baseUrl: string;
  private readonly tokens: TokenManager;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    apiBaseUrl: string,
    tokenManager: TokenManager,
    options: { rateLimitRps?: number; rateLimitRpm?: number; maxRetries?: number; fetchFn?: typeof fetch } = {},
  ) {
    this.baseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.tokens = tokenManager;
    this.limiter = new RateLimiter(options.rateLimitRps ?? 4, options.rateLimitRpm ?? 200);
    this.maxRetries = options.maxRetries ?? 4;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.limiter.acquire();
      const token = await this.tokens.getAccessToken();
      const resp = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      if (resp.status < 400) {
        return resp;
      }

      const retryable = resp.status === 429 || resp.status >= 500;
      if (retryable && attempt <= this.maxRetries) {
        let backoff = Math.min(2 ** (attempt - 1), 20);
        const retryAfter = resp.headers.get("Retry-After");
        if (retryAfter) {
          const parsed = Number(retryAfter);
          if (!Number.isNaN(parsed)) {
            backoff = Math.max(backoff, parsed);
          }
        }
        await sleep(backoff * 1000);
        continue;
      }

      const body = await safeJson(resp);
      throw new ApiError(resp.status, normalizeError(resp.status, body), body);
    }
  }
}

async function safeJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return await resp.json();
  } catch {
    return { raw: (await resp.text()).slice(0, 500) };
  }
}
