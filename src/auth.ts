/**
 * OAuth2 token management for a Self Authorization Vendor Center application.
 *
 * Per the Vendor Center docs (Step-by-Step Authentication):
 *
 * - Self Authorization apps only ever use grant_type=refresh_token.
 * - Every successful call to POST /token returns a NEW refresh_token, which
 *   replaces the one that was sent. If you keep reusing the original token
 *   instead of the newest one, it eventually expires and the integration
 *   stops authenticating.
 * - Token lifetimes (expires_in, refresh_expires_in) are not fixed - always
 *   read them from the response instead of hardcoding a duration.
 *
 * This module never logs or prints the token values themselves.
 */
import type { Settings } from "./config.ts";
import {
  readCredentials as defaultReadCredentials,
  writeCredentials as defaultWriteCredentials,
} from "./credentials.ts";
import { Mutex } from "./util/mutex.ts";

export class AuthError extends Error {}

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms epoch, safety margin already applied
  refreshToken: string;
}

export interface TokenManagerDeps {
  readCredentials: typeof defaultReadCredentials;
  writeCredentials: typeof defaultWriteCredentials;
  fetchFn: typeof fetch;
}

const DEFAULT_DEPS: TokenManagerDeps = {
  readCredentials: defaultReadCredentials,
  writeCredentials: defaultWriteCredentials,
  fetchFn: fetch,
};

/**
 * Holds the current Access Token / Refresh Token pair for one Self
 * Authorization application, refreshing and rotating as needed.
 *
 * Safe for concurrent use from multiple async tool calls: refreshes are
 * serialized behind a Mutex so two requests never race to spend the same
 * refresh_token (which would invalidate one of them, since it's rotated on
 * every use).
 */
export class TokenManager {
  // Refresh this many ms before the access token's stated expiry, to
  // absorb clock skew and in-flight request latency.
  private static readonly SAFETY_MARGIN_MS = 60_000;

  private readonly settings: Settings;
  private readonly deps: TokenManagerDeps;
  private readonly lock = new Mutex();
  private state: TokenState | null = null;

  constructor(settings: Settings, deps: Partial<TokenManagerDeps> = {}) {
    this.settings = settings;
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Return a currently-valid Access Token, refreshing if needed. */
  async getAccessToken(): Promise<string> {
    if (this.state && Date.now() < this.state.expiresAt) {
      return this.state.accessToken;
    }
    return this.lock.runExclusive(async () => {
      // Re-check after acquiring the lock: another call may have already
      // refreshed while we were waiting.
      if (this.state && Date.now() < this.state.expiresAt) {
        return this.state.accessToken;
      }
      return this.refresh();
    });
  }

  private async loadPersistedRefreshToken(): Promise<string> {
    // The per-user credentials file (populated by `node src/setup.ts`)
    // holds whatever the last rotation wrote - it's the authoritative
    // current value once it exists. settings.refreshToken is only ever the
    // seed used to populate that file in the first place (a
    // JUMIA_REFRESH_TOKEN env var override, if set - see config.ts).
    const stored = await this.deps.readCredentials();
    if (stored?.refresh_token) {
      return stored.refresh_token;
    }
    return this.settings.refreshToken;
  }

  private async persistRefreshToken(refreshToken: string): Promise<void> {
    // Losing a rotated refresh token means losing the ability to
    // authenticate at all until a human generates a fresh one in Vendor
    // Center - always persist immediately.
    await this.deps.writeCredentials(this.settings.clientId, refreshToken);
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.state ? this.state.refreshToken : await this.loadPersistedRefreshToken();

    const resp = await this.deps.fetchFn(`${this.settings.authBaseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.settings.clientId,
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const body = await safeJson(resp);
      throw new AuthError(
        `Token refresh failed with HTTP ${resp.status}: ${body.error ?? "?"} - ` +
          `${body.error_description ?? (await safeText(resp))}. ` +
          "See the troubleshooting table in Step-by-Step Authentication: a 400 invalid_grant usually means " +
          "the refresh token was already used/rotated elsewhere or has expired and a new one must be " +
          "generated in Vendor Center.",
      );
    }

    const body = await resp.json();
    const newRefreshToken: string = body.refresh_token ?? refreshToken;

    this.state = {
      accessToken: body.access_token,
      expiresAt: Date.now() + Math.max((body.expires_in ?? 0) * 1000 - TokenManager.SAFETY_MARGIN_MS, 5000),
      refreshToken: newRefreshToken,
    };
    // Always persist immediately, before returning: losing a rotated
    // refresh token means losing the ability to authenticate at all until
    // a human generates a fresh one in Vendor Center.
    await this.persistRefreshToken(newRefreshToken);
    return this.state.accessToken;
  }
}

async function safeJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return await resp.clone().json();
  } catch {
    return {};
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "";
  }
}
