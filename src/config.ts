/**
 * Configuration for the Jumia Vendor Center MCP server.
 *
 * Credentials (Client Id, Refresh Token) come from a per-user file, not a
 * project-local .env - the same pattern Firebase's CLI uses for its own
 * OAuth refresh token (~/.config/configstore/firebase-tools.json). Run
 * `node src/setup.ts` once per Vendor Center account to populate it; see
 * credentials.ts for the file format/location.
 *
 * Real environment variables can override either value, for CI/automation -
 * the same role Firebase CLI's FIREBASE_TOKEN env var plays there. This is
 * also how a Claude Code plugin install of this server can skip the
 * terminal-based `node src/setup.ts` step entirely: `.claude-plugin/
 * plugin.json` declares `userConfig.client_id`/`refresh_token`, which a user
 * fills in via the in-session `/plugin configure jumia-vendor-mcp` slash
 * command (Refresh Token
 * goes into Claude Code's own secure credential storage, never a plaintext
 * file), and the plugin manifest's `mcpServers.jumia-vendor-center.env`
 * substitutes those values into exactly these two env vars at launch. An
 * unset/empty override here is treated as absent and falls back to the
 * stored credentials file, so the two setup paths don't conflict.
 * Everything else below is a plain, non-secret environment variable; there
 * is no .env file support at all.
 *
 * Optional:
 *   JUMIA_CLIENT_ID       - overrides the stored Client Id
 *   JUMIA_REFRESH_TOKEN   - overrides the stored Refresh Token
 *   JUMIA_AUTH_BASE_URL   - defaults to https://vendor-api.jumia.com
 *   JUMIA_API_BASE_URL    - defaults to https://vendor-api.jumia.com
 *   JUMIA_SHOP_ID         - default shopId used by tools that need one and
 *                           aren't given one explicitly
 *   JUMIA_AUDIT_LOG       - path to the JSONL audit log of write actions
 *                           (default: ./data/audit.log)
 *   JUMIA_RATE_LIMIT_RPM  - requests/minute cap (default: 200, per the docs)
 *   JUMIA_RATE_LIMIT_RPS  - requests/second cap (default: 4, per the docs)
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readCredentials as defaultReadCredentials } from "./credentials.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(name: string, fallback?: string): string | undefined {
  const val = process.env[name];
  return val ? val : fallback;
}

export interface Settings {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly authBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly defaultShopId: string | undefined;
  readonly auditLogPath: string;
  readonly rateLimitRpm: number;
  readonly rateLimitRps: number;
}

export interface LoadSettingsDeps {
  readCredentials: typeof defaultReadCredentials;
}

export async function loadSettings(deps: LoadSettingsDeps = { readCredentials: defaultReadCredentials }): Promise<Settings> {
  const stored = (await deps.readCredentials()) ?? undefined;
  // A real (shell-exported) env var overrides the stored file, for CI use -
  // the same role Firebase CLI's FIREBASE_TOKEN env var plays.
  const clientId = env("JUMIA_CLIENT_ID") ?? stored?.client_id;
  const refreshToken = env("JUMIA_REFRESH_TOKEN") ?? stored?.refresh_token;

  const missing = [
    ["JUMIA_CLIENT_ID", clientId],
    ["JUMIA_REFRESH_TOKEN", refreshToken],
  ].filter(([, val]) => !val).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required credential(s): ${missing.join(", ")}. Either run \`/plugin configure ` +
        "jumia-vendor-mcp\` inside a Claude Code session and fill in the Client Id / Refresh Token fields " +
        "(if installed as a Claude Code plugin), or run `node src/setup.ts` in a terminal to store them in " +
        "your home directory instead - see credentials.ts. Never commit or paste the real values anywhere.",
    );
  }

  return Object.freeze({
    clientId: clientId as string,
    refreshToken: refreshToken as string,
    authBaseUrl: env("JUMIA_AUTH_BASE_URL", "https://vendor-api.jumia.com") as string,
    apiBaseUrl: env("JUMIA_API_BASE_URL", "https://vendor-api.jumia.com") as string,
    defaultShopId: env("JUMIA_SHOP_ID"),
    auditLogPath: env("JUMIA_AUDIT_LOG", path.join(PROJECT_ROOT, "data", "audit.log")) as string,
    rateLimitRpm: Number(env("JUMIA_RATE_LIMIT_RPM", "200")),
    rateLimitRps: Number(env("JUMIA_RATE_LIMIT_RPS", "4")),
  });
}
