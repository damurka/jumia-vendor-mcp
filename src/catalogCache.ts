/**
 * A short-lived, in-memory cache for full (or filtered) catalog scans.
 *
 * find_outdated_products, find_duplicate_products, and any similar
 * ad-hoc analysis all page through the ENTIRE catalog via
 * VendorApiClient.iterAllProducts - repeating that within one work
 * session just to run a second heuristic over the same data is wasted
 * time and API quota. This cache stores one entry per distinct filter
 * combination (keyed by the JSON-serialized filters), with a short TTL
 * so it never risks serving meaningfully stale data across a session,
 * and is invalidated wholesale on every write action (create/update/
 * price/stock/status) so a scan run right after a write never sees
 * cached pre-write state.
 *
 * Opt-in only (see iterAllProducts's `cached` option) - callers that
 * need the live catalog every time are unaffected.
 */
import type { JsonRecord } from "./heuristics.ts";

interface CacheEntry {
  products: JsonRecord[];
  fetchedAt: number;
}

export interface CatalogCacheOptions {
  /** How long a cached scan stays valid. Default 3 minutes. */
  ttlMs?: number;
}

export class CatalogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(options: CatalogCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 180_000;
  }

  get(key: string): JsonRecord[] | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.products;
  }

  set(key: string, products: JsonRecord[]): void {
    this.entries.set(key, { products, fetchedAt: Date.now() });
  }

  /** Called after any write action - a stale cached scan is worse than no cache at all. */
  invalidateAll(): void {
    this.entries.clear();
  }
}
