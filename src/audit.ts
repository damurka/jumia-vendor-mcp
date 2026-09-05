/**
 * Append-only audit log of every write action this server takes against
 * Vendor Center (create/update/status/price/stock feeds, order cancellations,
 * consignments, etc).
 *
 * Automating catalog and order changes is exactly the kind of thing you want
 * a paper trail for later ("why is this product inactive", "who cancelled
 * this order item, and when") - especially since several of these actions
 * are effectively irreversible from the seller side (see the "what's left
 * out" notes in the README about there being no true delete/undo on most of
 * these). This is intentionally a dumb, dependency-free JSONL file rather
 * than a database: easy to `tail -f`, easy to grep, easy to ship elsewhere.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export class AuditLog {
  private readonly filePath: string;
  private readonly ready: Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ready = fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined);
  }

  async record(action: string, request: unknown, result: unknown, ok: boolean, error?: string): Promise<void> {
    await this.ready;
    const entry = { ts: Date.now() / 1000, action, ok, request, result, error: error ?? null };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      // JS's JSON.stringify throws on circular refs (unlike Python's
      // json.dumps(default=str), which never fails) - fall back to a
      // best-effort String() of each field so a bad audit entry can never
      // crash the write path it's supposed to be protecting.
      line = JSON.stringify({
        ts: entry.ts,
        action,
        ok,
        request: safeStringify(request),
        result: safeStringify(result),
        error: entry.error,
      });
    }
    await fs.appendFile(this.filePath, `${line}\n`);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
