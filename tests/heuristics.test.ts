import assert from "node:assert/strict";
import { test } from "node:test";

import { findDuplicateCandidates, findOutdatedProducts, flattenListings } from "../src/heuristics.ts";
import type { JsonRecord } from "../src/heuristics.ts";

const NOW = new Date("2026-09-05T00:00:00+00:00");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function product(overrides: Partial<{
  productId: string;
  name: string;
  brand: string;
  category: string;
  images: string[];
  sellerSku: string;
  variationId: string;
  barcodeEan: string | null;
  status: string;
  qcStatus: string;
  qcUpdatedAt: string | null;
  rejectionReason: string | null;
  productUpdatedAt: string | null;
  createdAt: string;
  businessClientCode: string;
}> = {}): JsonRecord {
  const {
    productId = "ps1",
    name = "Wireless Mouse",
    brand = "B1",
    category = "C1",
    images = ["img1.jpg"],
    sellerSku = "sku1",
    variationId = "v1",
    barcodeEan = null,
    status = "ACTIVE",
    qcStatus = "APPROVED",
    qcUpdatedAt = null,
    rejectionReason = null,
    productUpdatedAt = null,
    createdAt = "2026-01-01",
    businessClientCode = "jumia-ng",
  } = overrides;

  return {
    id: productId,
    name,
    brand: { code: brand },
    category: { code: category },
    images: images.map((u) => ({ url: u })),
    createdAt,
    updatedAt: productUpdatedAt,
    variations: [
      {
        id: variationId,
        sellerSku,
        barcodeEan,
        globalPrice: { currency: "NGN", value: 1000 },
        businessClients: [
          {
            code: businessClientCode,
            countryCode: "NG",
            status,
            qc: { status: qcStatus, updatedAt: qcUpdatedAt, rejectionReason },
            price: { value: 1000, currency: "NGN" },
          },
        ],
      },
    ],
  };
}

test("flattenListings produces one row per business client", () => {
  const rows = flattenListings([product()]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.variation_id, "v1");
  assert.equal(row.seller_sku, "sku1");
  assert.equal(row.business_client_code, "jumia-ng");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.qc_status, "APPROVED");
});

test("flags QC rejected past grace period using QC timestamp", () => {
  const products = [
    product({ variationId: "v1", qcStatus: "REJECTED", qcUpdatedAt: daysAgo(30), rejectionReason: "bad images" }),
    product({ variationId: "v2", qcStatus: "REJECTED", qcUpdatedAt: daysAgo(2) }),
  ];
  const flagged = findOutdatedProducts(products, { now: NOW, qcRejectedGraceDays: 14 });
  const ids = new Set(flagged.map((f) => f.listing.variation_id));
  assert.deepEqual(ids, new Set(["v1"]));
  assert.match(flagged[0].reasons[0], /bad images/);
});

test("flags zero-stock ACTIVE listing", () => {
  const products = [product({ variationId: "v1", status: "ACTIVE", qcStatus: "APPROVED", productUpdatedAt: daysAgo(40) })];
  const flagged = findOutdatedProducts(products, { stockByVariationId: { v1: 0 }, now: NOW, zeroStockGraceDays: 30 });
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].reasons[0], /0 stock/);
});

test("does not flag ACTIVE listing with stock", () => {
  const products = [product({ variationId: "v1", status: "ACTIVE", productUpdatedAt: daysAgo(400) })];
  const flagged = findOutdatedProducts(products, {
    stockByVariationId: { v1: 20 },
    now: NOW,
    staleActiveGraceDays: 1000,
    zeroStockGraceDays: 30,
  });
  assert.deepEqual(flagged, []);
});

test("stale-active rule fires independently of stock", () => {
  const products = [product({ variationId: "v1", status: "ACTIVE", productUpdatedAt: daysAgo(400) })];
  const flagged = findOutdatedProducts(products, { stockByVariationId: { v1: 20 }, now: NOW, staleActiveGraceDays: 180 });
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].reasons[0], /untouched/);
});

test("missing timestamps never crash and are not flagged", () => {
  const products = [product({ qcStatus: "REJECTED", qcUpdatedAt: null, productUpdatedAt: null })];
  const flagged = findOutdatedProducts(products, { now: NOW });
  assert.deepEqual(flagged, []); // no timestamp -> can't compute age -> conservatively not flagged
});

test("GTIN match is authoritative even with different names", () => {
  const products = [
    product({ productId: "ps1", name: "Wireless Mouse", barcodeEan: "12345" }),
    product({ productId: "ps2", name: "Completely Different Title", barcodeEan: "12345" }),
    product({ productId: "ps3", name: "Unrelated product", barcodeEan: "99999" }),
  ];
  const clusters = findDuplicateCandidates(products);
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].products.map((p) => p.id)), new Set(["ps1", "ps2"]));
  assert.ok(clusters[0].reason.startsWith("Same GTIN"));
});

test("fuzzy name match requires same brand, category, and images", () => {
  const products = [
    product({ productId: "ps1", name: "Samsung 55 inch 4K Smart TV" }),
    product({ productId: "ps2", name: "Samsung 55inch 4K Smart TV" }),
    product({ productId: "ps3", name: "Samsung 55 inch 4K Smart TV", brand: "OtherBrand" }),
  ];
  const clusters = findDuplicateCandidates(products, { nameSimilarityThreshold: 0.9 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].products.map((p) => p.id)), new Set(["ps1", "ps2"]));
});

test("no false positive for dissimilar names sharing images", () => {
  const products = [
    product({ productId: "ps1", name: "Phone Case Black" }),
    product({ productId: "ps2", name: "Screen Protector Glass" }),
  ];
  const clusters = findDuplicateCandidates(products);
  assert.deepEqual(clusters, []);
});

test("suggested canonical prefers live, then oldest", () => {
  const olderLive = product({ productId: "ps1", barcodeEan: "555", status: "ACTIVE", qcStatus: "APPROVED" });
  olderLive.createdAt = "2025-01-01";
  const newerRejected = product({ productId: "ps2", barcodeEan: "555", status: "INACTIVE", qcStatus: "REJECTED" });
  newerRejected.createdAt = "2026-01-01";

  const clusters = findDuplicateCandidates([olderLive, newerRejected]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].suggestedCanonical?.id, "ps1");
});
