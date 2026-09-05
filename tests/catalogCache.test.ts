import assert from "node:assert/strict";
import { test } from "node:test";

import { CatalogCache } from "../src/catalogCache.ts";

test("returns null for a key that was never set", () => {
  const cache = new CatalogCache();
  assert.equal(cache.get("missing"), null);
});

test("returns what was set for the same key", () => {
  const cache = new CatalogCache();
  const products = [{ id: "p1" }];
  cache.set("key1", products);
  assert.deepEqual(cache.get("key1"), products);
});

test("expires an entry once its TTL has elapsed", async () => {
  const cache = new CatalogCache({ ttlMs: 10 });
  cache.set("key1", [{ id: "p1" }]);
  assert.notEqual(cache.get("key1"), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cache.get("key1"), null);
});

test("invalidateAll clears every entry regardless of key", () => {
  const cache = new CatalogCache();
  cache.set("key1", [{ id: "p1" }]);
  cache.set("key2", [{ id: "p2" }]);
  cache.invalidateAll();
  assert.equal(cache.get("key1"), null);
  assert.equal(cache.get("key2"), null);
});
