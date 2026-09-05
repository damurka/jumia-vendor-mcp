/**
 * Tests for the per-user credential file precedence (config.ts) and
 * rotation persistence (auth.ts).
 *
 * ESM import bindings are live, read-only views - you cannot reassign an
 * imported name the way Python's `config_module.read_credentials = fake`
 * monkeypatching works. So instead of patching module state, both
 * loadSettings() and TokenManager accept the relevant function as an
 * injectable dependency, defaulting to the real implementation. No real
 * credentials file or network is touched by these tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { TokenManager } from "../src/auth.ts";
import { loadSettings, type Settings } from "../src/config.ts";
import type { Credentials } from "../src/credentials.ts";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) original[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Must await here, not `return fn()` - otherwise the `finally` below
    // runs as soon as fn() yields its first pending promise (i.e.
    // immediately, before fn's internal awaits resolve), restoring env
    // vars before fn ever gets to observe them.
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return Object.freeze({
    clientId: "cid",
    refreshToken: "env-seed-token",
    authBaseUrl: "https://example.invalid",
    apiBaseUrl: "https://example.invalid",
    defaultShopId: undefined,
    auditLogPath: "/tmp/does-not-matter.log",
    rateLimitRpm: 200,
    rateLimitRps: 4,
    ...overrides,
  });
}

test("loadSettings prefers a real env var over the stored credentials file", async () => {
  await withEnv({ JUMIA_CLIENT_ID: "env-client", JUMIA_REFRESH_TOKEN: "env-refresh" }, async () => {
    const s = await loadSettings({
      readCredentials: async () => ({ client_id: "stored-client", refresh_token: "stored-refresh", saved_at: 0 }),
    });
    assert.equal(s.clientId, "env-client");
    assert.equal(s.refreshToken, "env-refresh");
  });
});

test("loadSettings falls back to the stored credentials file when env vars are absent", async () => {
  await withEnv({ JUMIA_CLIENT_ID: undefined, JUMIA_REFRESH_TOKEN: undefined }, async () => {
    const s = await loadSettings({
      readCredentials: async () => ({ client_id: "stored-client", refresh_token: "stored-refresh", saved_at: 0 }),
    });
    assert.equal(s.clientId, "stored-client");
    assert.equal(s.refreshToken, "stored-refresh");
  });
});

test("loadSettings throws when neither env vars nor the stored file has credentials", async () => {
  await withEnv({ JUMIA_CLIENT_ID: undefined, JUMIA_REFRESH_TOKEN: undefined }, async () => {
    await assert.rejects(
      () => loadSettings({ readCredentials: async () => null }),
      (err: Error) => err.message.includes("JUMIA_CLIENT_ID") && err.message.includes("JUMIA_REFRESH_TOKEN"),
    );
  });
});

test("TokenManager persists a rotated refresh token via writeCredentials", async () => {
  const writes: Array<{ clientId: string; refreshToken: string }> = [];
  const manager = new TokenManager(settings(), {
    readCredentials: async () => null,
    writeCredentials: async (clientId: string, refreshToken: string) => {
      writes.push({ clientId, refreshToken });
    },
    fetchFn: (async () =>
      new Response(JSON.stringify({ access_token: "at1", expires_in: 3600, refresh_token: "rotated-token" }), {
        status: 200,
      })) as unknown as typeof fetch,
  });

  const token = await manager.getAccessToken();

  assert.equal(token, "at1");
  assert.deepEqual(writes, [{ clientId: "cid", refreshToken: "rotated-token" }]);
});

test("TokenManager reads the stored refresh token over the settings seed", async () => {
  let usedRefreshToken: string | undefined;
  const stored: Credentials = { client_id: "cid", refresh_token: "file-token", saved_at: 0 };
  const manager = new TokenManager(settings({ refreshToken: "settings-seed" }), {
    readCredentials: async () => stored,
    writeCredentials: async () => undefined,
    fetchFn: (async (_url: string, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      usedRefreshToken = body.get("refresh_token") ?? undefined;
      return new Response(JSON.stringify({ access_token: "at1", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  await manager.getAccessToken();

  assert.equal(usedRefreshToken, "file-token");
});

test("TokenManager raises AuthError with a troubleshooting message on a non-200 response", async () => {
  const manager = new TokenManager(settings(), {
    readCredentials: async () => null,
    writeCredentials: async () => undefined,
    fetchFn: (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "token expired" }), { status: 400 })) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => manager.getAccessToken(),
    (err: Error) => err.message.includes("invalid_grant") && err.message.includes("token expired"),
  );
});
