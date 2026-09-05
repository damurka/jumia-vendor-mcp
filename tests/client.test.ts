import assert from "node:assert/strict";
import { test } from "node:test";

import { CatalogCache } from "../src/catalogCache.ts";
import { VendorApiClient } from "../src/client.ts";
import type { RequestOptions } from "../src/http.ts";

interface RecordedCall {
  method: string;
  path: string;
  params?: Record<string, unknown>;
  jsonBody?: unknown;
}

class FakeResponse {
  private readonly data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
  async json() {
    return this.data;
  }
}

/** Records every call made through it and returns a scripted response. */
class FakeHttp {
  calls: RecordedCall[] = [];
  protected responseData: unknown;
  constructor(responseData: unknown = {}) {
    this.responseData = responseData;
  }

  async request(method: string, path: string, options: RequestOptions = {}) {
    this.calls.push({ method, path, params: options.params, jsonBody: options.jsonBody });
    return new FakeResponse(this.responseData) as unknown as Response;
  }
}

test("createProducts posts shopId and products verbatim", async () => {
  const fake = new FakeHttp({ feedId: "abc-123" });
  const client = new VendorApiClient(fake as never);
  const products = [{ sellerSku: "sku1", name: { value: "Test" } }];

  const result = await client.createProducts("shop-1", products);

  assert.deepEqual(result, { feedId: "abc-123" });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/feeds/products/create");
  assert.deepEqual(call.jsonBody, { shopId: "shop-1", products });
});

test("updateStatus uses correct path and body", async () => {
  const fake = new FakeHttp({ feedId: "f1" });
  const client = new VendorApiClient(fake as never);
  const payload = [
    { id: "sid-1", sellerSku: "sku1", businessClients: [{ businessClientCode: "jumia-ng", status: "INACTIVE" }] },
  ];
  await client.updateStatus(payload);
  const call = fake.calls[0];
  assert.equal(call.path, "/feeds/products/status");
  assert.deepEqual(call.jsonBody, { products: payload });
});

test("getProducts drops undefined filters from params", async () => {
  const fake = new FakeHttp({ products: [], nextToken: null });
  const client = new VendorApiClient(fake as never);
  await client.getProducts({ status: "ACTIVE", qcStatus: undefined, size: 25 });
  const call = fake.calls[0];
  assert.equal(call.method, "GET");
  assert.equal(call.path, "/catalog/products");
  assert.deepEqual(call.params, { size: 25, status: "ACTIVE" });
});

test("iterAllProducts follows nextToken and stops at last page", async () => {
  const pages = [
    { products: [{ id: "p1" }], nextToken: "tok2", isLastPage: false },
    { products: [{ id: "p2" }], nextToken: null, isLastPage: true },
  ];

  class PagedFakeHttp extends FakeHttp {
    private remaining = [...pages];
    async request(method: string, path: string, options: RequestOptions = {}) {
      this.calls.push({ method, path, params: options.params });
      return new FakeResponse(this.remaining.shift()) as unknown as Response;
    }
  }

  const fake = new PagedFakeHttp();
  const client = new VendorApiClient(fake as never);

  const items: unknown[] = [];
  for await (const p of client.iterAllProducts()) items.push(p);

  assert.deepEqual(
    items.map((p) => (p as { id: string }).id),
    ["p1", "p2"],
  );
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].params?.token, "tok2");
});

test("cancelOrderItems uses PUT and the correct path", async () => {
  const fake = new FakeHttp({});
  const client = new VendorApiClient(fake as never);
  await client.cancelOrderItems(["item-1", "item-2"]);
  const call = fake.calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.path, "/orders/cancel");
  assert.deepEqual(call.jsonBody, { orderItemIds: ["item-1", "item-2"] });
});

test("iterAllProducts with cached:true serves a second scan from cache, no extra HTTP calls", async () => {
  class PagedFakeHttp extends FakeHttp {
    private remaining = [{ products: [{ id: "p1" }], nextToken: null, isLastPage: true }];
    async request(method: string, path: string, options: RequestOptions = {}) {
      this.calls.push({ method, path, params: options.params });
      return new FakeResponse(this.remaining.shift() ?? { products: [], isLastPage: true }) as unknown as Response;
    }
  }
  const fake = new PagedFakeHttp();
  const client = new VendorApiClient(fake as never, new CatalogCache());

  const first: unknown[] = [];
  for await (const p of client.iterAllProducts({ cached: true })) first.push(p);
  const second: unknown[] = [];
  for await (const p of client.iterAllProducts({ cached: true })) second.push(p);

  assert.deepEqual(first, [{ id: "p1" }]);
  assert.deepEqual(second, [{ id: "p1" }]);
  assert.equal(fake.calls.length, 1, "second scan should be served from cache, not a new HTTP call");
});

test("iterAllProducts cache is keyed per filter combination", async () => {
  class PagedFakeHttp extends FakeHttp {
    async request(method: string, path: string, options: RequestOptions = {}) {
      this.calls.push({ method, path, params: options.params });
      return new FakeResponse({ products: [{ id: options.params?.categoryCode }], isLastPage: true }) as unknown as Response;
    }
  }
  const fake = new PagedFakeHttp();
  const client = new VendorApiClient(fake as never, new CatalogCache());

  const catA: unknown[] = [];
  for await (const p of client.iterAllProducts({ categoryCode: "A", cached: true })) catA.push(p);
  const catB: unknown[] = [];
  for await (const p of client.iterAllProducts({ categoryCode: "B", cached: true })) catB.push(p);

  assert.deepEqual(catA, [{ id: "A" }]);
  assert.deepEqual(catB, [{ id: "B" }]);
  assert.equal(fake.calls.length, 2, "different filters must not share a cache entry");
});

test("client.invalidateCache() forces the next scan to hit the network again", async () => {
  class PagedFakeHttp extends FakeHttp {
    private call = 0;
    async request(method: string, path: string, options: RequestOptions = {}) {
      this.call += 1;
      this.calls.push({ method, path, params: options.params });
      return new FakeResponse({ products: [{ id: `p${this.call}` }], isLastPage: true }) as unknown as Response;
    }
  }
  const fake = new PagedFakeHttp();
  const client = new VendorApiClient(fake as never, new CatalogCache());

  const first: unknown[] = [];
  for await (const p of client.iterAllProducts({ cached: true })) first.push(p);
  client.invalidateCache();
  const second: unknown[] = [];
  for await (const p of client.iterAllProducts({ cached: true })) second.push(p);

  assert.deepEqual(first, [{ id: "p1" }]);
  assert.deepEqual(second, [{ id: "p2" }], "post-invalidation scan must re-fetch, not reuse the stale entry");
  assert.equal(fake.calls.length, 2);
});

test("iterAllProducts without cached:true never touches the cache", async () => {
  class PagedFakeHttp extends FakeHttp {
    private call = 0;
    async request(method: string, path: string, options: RequestOptions = {}) {
      this.call += 1;
      this.calls.push({ method, path, params: options.params });
      return new FakeResponse({ products: [{ id: `p${this.call}` }], isLastPage: true }) as unknown as Response;
    }
  }
  const fake = new PagedFakeHttp();
  const client = new VendorApiClient(fake as never, new CatalogCache());

  const first: unknown[] = [];
  for await (const p of client.iterAllProducts()) first.push(p);
  const second: unknown[] = [];
  for await (const p of client.iterAllProducts()) second.push(p);

  assert.deepEqual(first, [{ id: "p1" }]);
  assert.deepEqual(second, [{ id: "p2" }], "uncached calls must always hit the network");
  assert.equal(fake.calls.length, 2);
});

test("consignment update uses PATCH and the documented field name", async () => {
  const fake = new FakeHttp({});
  const client = new VendorApiClient(fake as never);
  await client.updateConsignment("PO-1", { nameOf3PL: "DHL", isShipped: true });
  const call = fake.calls[0];
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, "/consignment-order/PO-1");
  // Must be `nameOf3PL`, not `3plName` - the docs note the API silently
  // discards the latter even though it was previously (wrongly) documented.
  assert.deepEqual(call.jsonBody, { isShipped: true, nameOf3PL: "DHL" });
});
