/**
 * Per-user credential storage, Firebase-CLI style.
 *
 * Firebase's CLI stores its OAuth refresh token in a JSON file under the
 * user's home directory (~/.config/configstore/firebase-tools.json) - never
 * in the project being worked on, so it can't be accidentally committed.
 * Every `firebase` subcommand (Crashlytics uploads included) just reads that
 * one shared file; there's no separate per-tool auth step.
 *
 * This module is the same pattern for this project: one JSON file at
 * CREDENTIALS_PATH, populated once by `node src/setup.ts`, read by every
 * server process afterward. It deliberately lives outside the project
 * directory.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CREDENTIALS_PATH = path.join(os.homedir(), ".config", "jumia-vendor-mcp", "credentials.json");

export interface Credentials {
  client_id: string;
  refresh_token: string;
  saved_at: number;
}

export async function readCredentials(credentialsPath: string = CREDENTIALS_PATH): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    return null;
  }
  let data: Partial<Credentials>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data.client_id || !data.refresh_token) {
    return null;
  }
  return data as Credentials;
}

export async function writeCredentials(
  clientId: string,
  refreshToken: string,
  credentialsPath: string = CREDENTIALS_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  const tmp = `${credentialsPath}.tmp`;
  const payload: Credentials = { client_id: clientId, refresh_token: refreshToken, saved_at: Date.now() / 1000 };
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, credentialsPath);
  try {
    await fs.chmod(credentialsPath, 0o600); // owner read/write only - best-effort
  } catch {
    // Not all platforms/filesystems support this; not fatal.
  }
}
