/**
 * Interactive first-run credential setup.
 *
 * Stores your Vendor Center Client Id and Refresh Token in a per-user JSON
 * file outside this project (see credentials.ts for the exact path/format -
 * the same pattern Firebase's CLI uses for its own OAuth refresh token), and
 * validates them against the live token endpoint before saving anything.
 *
 * Run with:  node src/setup.ts
 *
 * Each user of this MCP server runs this against their OWN Vendor Center
 * account - register your own Self Authorization application (Settings ->
 * Applications -> Create Application -> Self Authorization) and generate a
 * Refresh Token from it first. There is no way to script that step; it is a
 * manual action in Vendor Center's UI, by design of their platform - exactly
 * like Firebase's `firebase login` needing a real browser session once.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { CREDENTIALS_PATH, writeCredentials } from "./credentials.ts";

const DEFAULT_AUTH_BASE_URL = "https://vendor-api.jumia.com";

// Char codes used by the hidden-input reader below. Compared numerically
// rather than as embedded control-character string literals, which are
// easy to get subtly wrong/invisible in source.
const CHAR_CODE_ENTER_CR = 13;
const CHAR_CODE_ENTER_LF = 10;
const CHAR_CODE_CTRL_C = 3;
const CHAR_CODE_BACKSPACE_DEL = 127;
const CHAR_CODE_BACKSPACE_BS = 8;

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Node has no built-in equivalent of Python's `getpass.getpass()`. This
 * reads keystrokes directly from stdin in raw mode, without echoing them to
 * the screen, so the Refresh Token is never visible on-screen or captured
 * in shell/terminal scrollback.
 */
async function promptHidden(question: string): Promise<string> {
  stdout.write(question);

  if (!stdin.isTTY) {
    // Piped/non-interactive input (e.g. CI, or this being driven
    // programmatically) - fall back to a plain line read, same as Python's
    // getpass falling back when stdin isn't a real terminal.
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    try {
      const line = await rl.question("");
      return line.trim();
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    function onData(chunk: string): void {
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        if (code === CHAR_CODE_ENTER_CR || code === CHAR_CODE_ENTER_LF) {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (code === CHAR_CODE_CTRL_C) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Aborted"));
          return;
        }
        if (code === CHAR_CODE_BACKSPACE_DEL || code === CHAR_CODE_BACKSPACE_BS) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    stdin.on("data", onData);
  });
}

async function validate(clientId: string, refreshToken: string, authBaseUrl: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${authBaseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
  });
  if (!resp.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await resp.json();
    } catch {
      // ignore, fall through to text
    }
    const detail = body.error_description ?? (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${resp.status}: ${body.error ?? "?"} - ${detail}`);
  }
  return resp.json();
}

async function main(): Promise<void> {
  console.log("jumia-vendor-mcp setup");
  console.log(`Stores your credentials in ${CREDENTIALS_PATH}, not a project .env file.`);
  console.log(
    "You'll need a Self Authorization application's Client Id, and a freshly-generated Refresh Token, " +
      "from YOUR OWN Vendor Center account: Settings -> Applications.\n",
  );

  const clientId = await prompt("Client Id: ");
  const refreshToken = await promptHidden("Refresh Token (input hidden): ");
  const authBaseUrlInput = await prompt(`Auth base URL [${DEFAULT_AUTH_BASE_URL}]: `);
  const authBaseUrl = authBaseUrlInput || DEFAULT_AUTH_BASE_URL;

  if (!clientId || !refreshToken) {
    console.error("Both values are required. Aborting - nothing was saved.");
    process.exit(1);
  }

  console.log("\nValidating against the live API...");
  let body: Record<string, unknown>;
  try {
    body = await validate(clientId, refreshToken, authBaseUrl);
  } catch (e) {
    console.error(`Validation failed: ${(e as Error).message}\nNothing was saved.`);
    return process.exit(1);
  }

  // The token endpoint rotates the refresh token on every call, including
  // this validation one - store the NEW one, not the one that was typed.
  const newRefreshToken = (body.refresh_token as string | undefined) ?? refreshToken;
  await writeCredentials(clientId, newRefreshToken);

  console.log(`Validated and saved to ${CREDENTIALS_PATH}.`);
  console.log("You can now run the server normally.");
  if (authBaseUrl !== DEFAULT_AUTH_BASE_URL) {
    console.log(
      `\nNote: ${authBaseUrl} is not stored anywhere - set JUMIA_AUTH_BASE_URL=${authBaseUrl} (and ` +
        "JUMIA_API_BASE_URL, if different) as a real environment variable, since only the two secrets " +
        "above are persisted by this command.",
    );
  }
}

main();
