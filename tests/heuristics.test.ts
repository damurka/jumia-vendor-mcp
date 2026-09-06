import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildVariantMergePayload,
  classifyListingType,
  findDuplicateCandidates,
  findOutdatedProducts,
  findVariantFragments,
  flattenListings,
  normalizeColorValue,
  scanContentPolicy,
} from "../src/heuristics.ts";
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

// ---------------------------------------------------------------------
// Variant fragments
// ---------------------------------------------------------------------

function caseProduct(overrides: Partial<{
  id: string;
  name: string;
  description: string;
  color: string;
  price: number;
  variationId: string;
  sellerSku: string;
  categoryCode: string;
  weight: string;
  images: string[];
}> = {}): JsonRecord {
  const {
    id = "ps1",
    name = "Silicone Back Cover for iPhone 13",
    description = "Protect your Apple iPhone 13 with this sleek Silicone Case.",
    color = "Black",
    price = 950,
    variationId = "v1",
    sellerSku = "sku1",
    categoryCode = "1000624",
    weight = "0.02",
    images = ["img1.jpg"],
  } = overrides;

  return {
    id,
    name,
    description,
    brand: { code: "1045133", name: "Generic" },
    category: { code: categoryCode, name: "Cases" },
    images: images.map((url) => ({ url, primary: true })),
    attributes: [
      { name: "color", value: color },
      { name: "product_weight", value: weight },
      { name: "main_material", value: "Silicone" },
      { name: "short_description", value: `Compatible with iPhone 13 (${color})` },
      { name: "package_content", value: `1 x cover - ${color}` },
    ],
    variations: [{ id: variationId, sellerSku, globalPrice: { value: price } }],
  };
}

test("findVariantFragments clusters same brand/model/type by color, ignoring name similarity", () => {
  const products = [
    caseProduct({ id: "p1", name: "Silicone back cover for iPhone 13", color: "Black", variationId: "v1", price: 900 }),
    caseProduct({ id: "p2", name: "Shockproof Silicone Back Cover for iPhone 13-Blue", color: "Blue", variationId: "v2", price: 950 }),
    caseProduct({ id: "p3", name: "Sleek,Shock proof Silicone back cover for iPhone 13 -Maroon", color: "Maroon", variationId: "v3", price: 950 }),
  ];
  const clusters = findVariantFragments(products);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].colors.sort(), ["Black", "Blue", "Maroon"]);
  assert.equal(clusters[0].brand, "iphone");
});

test("findVariantFragments excludes a garbage/comma-list color from the cluster's color count", () => {
  const products = [
    caseProduct({ id: "p1", name: "Silicone case for iPhone 13", color: "Black", variationId: "v1" }),
    caseProduct({ id: "p2", name: "Silicone case for iPhone 13", color: "black,grey,white", variationId: "v2" }),
  ];
  // only 1 recognized color ("Black") - below the default minColors of 2
  assert.deepEqual(findVariantFragments(products), []);
});

test("findVariantFragments never mixes different case types (MagSafe vs plain) into one cluster", () => {
  const products = [
    caseProduct({ id: "p1", name: "Silicone case for iPhone 13", color: "Black", variationId: "v1" }),
    caseProduct({ id: "p2", name: "MagSafe Silicone case for iPhone 13", color: "Blue", variationId: "v2" }),
  ];
  const clusters = findVariantFragments(products);
  assert.equal(clusters.length, 0); // each type only has 1 color on its own
});

test("findVariantFragments flags a price outlier within a cluster", () => {
  const products = [
    caseProduct({ id: "p1", name: "Silicone case for iPhone 13", color: "Black", variationId: "v1", price: 900 }),
    caseProduct({ id: "p2", name: "Silicone case for iPhone 13", color: "Blue", variationId: "v2", price: 2500 }),
  ];
  const [cluster] = findVariantFragments(products);
  assert.ok(cluster.flags.some((f) => f.startsWith("PRICE_OUTLIER")));
});

test("findVariantFragments flags a bundle listing hiding inside an otherwise-plain cluster", () => {
  const products = [
    caseProduct({ id: "p1", name: "Silicone case for iPhone 13", color: "Black", variationId: "v1" }),
    caseProduct({
      id: "p2",
      name: "Silicone case for iPhone 13",
      color: "Blue",
      variationId: "v2",
      description: "3-in-1 bundle: case plus 2 tempered glass screen protectors.",
    }),
  ];
  const [cluster] = findVariantFragments(products);
  assert.ok(cluster.flags.some((f) => f.startsWith("BUNDLE_KEYWORD")));
});

test("normalizeColorValue returns null for comma-lists and unrecognized values, never guesses", () => {
  assert.equal(normalizeColorValue("black,grey,white"), null);
  assert.equal(normalizeColorValue("mauve-ish"), null);
  assert.equal(normalizeColorValue("burgundy"), "Maroon");
  assert.equal(normalizeColorValue("BLACK"), "Black");
});

test("classifyListingType never lets a MagSafe/Nillkin/leather case classify as plain silicone", () => {
  assert.equal(classifyListingType("Silicone case for iPhone 13"), "PLAIN-SILICONE");
  assert.equal(classifyListingType("iPhone 13 MagSafe Case"), "MAGSAFE/MAGNETIC");
  assert.equal(classifyListingType("Nillkin CamShield Pro Case"), "HARD-CASE-BRANDED");
  assert.equal(classifyListingType("Leather Flip Wallet Case"), "LEATHER/WALLET/FLIP");
});

test("buildVariantMergePayload keeps the highest price per color and deactivates the rest", () => {
  const cluster = {
    key: "iphone | iphone 13 | PLAIN-SILICONE",
    brand: "iphone",
    model: "iphone 13",
    type: "PLAIN-SILICONE",
    colors: ["Black", "Blue"],
    flags: [],
    items: [
      { product: caseProduct({ id: "p1", color: "Black", variationId: "v1", sellerSku: "sku1", price: 900 }), name: "n1", color: "Black", price: 900, variationId: "v1", sellerSku: "sku1", categoryCode: "1000624" },
      { product: caseProduct({ id: "p2", color: "Black", variationId: "v2", sellerSku: "sku2", price: 850 }), name: "n2", color: "Black", price: 850, variationId: "v2", sellerSku: "sku2", categoryCode: "1000624" },
      { product: caseProduct({ id: "p3", color: "Blue", variationId: "v3", sellerSku: "sku3", price: 950 }), name: "n3", color: "Blue", price: 950, variationId: "v3", sellerSku: "sku3", categoryCode: "1000624" },
    ],
  };

  const result = buildVariantMergePayload(cluster, "jumia-ke");

  assert.equal(result.createPayload.length, 2); // one per color
  const blackEntry = result.createPayload.find((e: JsonRecord) => e.variation === "Black");
  assert.ok(blackEntry);
  assert.equal(blackEntry.price.value, 900); // v1 (900) beat v2 (850)

  // all 3 originals (both Black listings + the Blue winner) get deactivated
  assert.equal(result.deactivateList.length, 3);
  assert.deepEqual(
    result.deactivateList.map((d: JsonRecord) => d.id).sort(),
    ["v1", "v2", "v3"],
  );
});

test("buildVariantMergePayload never leaks one color's copy into another variant's attributes", () => {
  const cluster = {
    key: "iphone | iphone 13 | PLAIN-SILICONE",
    brand: "iphone",
    model: "iphone 13",
    type: "PLAIN-SILICONE",
    colors: ["Black", "Blue"],
    flags: [],
    items: [
      { product: caseProduct({ id: "p1", color: "Black", variationId: "v1", sellerSku: "sku1" }), name: "n1", color: "Black", price: 900, variationId: "v1", sellerSku: "sku1", categoryCode: "1000624" },
      { product: caseProduct({ id: "p2", color: "Blue", variationId: "v2", sellerSku: "sku2" }), name: "n2", color: "Blue", price: 950, variationId: "v2", sellerSku: "sku2", categoryCode: "1000624" },
    ],
  };

  const result = buildVariantMergePayload(cluster, "jumia-ke");

  for (const entry of result.createPayload) {
    const ownColor = (entry.variation as string).toLowerCase();
    const shortDescAttr = (entry.attributes as JsonRecord[]).find((a) => a.name === "short_description");
    assert.ok(shortDescAttr);
    const shortDesc = String(shortDescAttr.value).toLowerCase();
    const otherColor = ownColor === "black" ? "blue" : "black";
    assert.ok(!shortDesc.includes(otherColor), `short_description for ${ownColor} should not mention ${otherColor}`);
  }
});

test("buildVariantMergePayload combines images from every listing in the cluster, deduped", () => {
  const cluster = {
    key: "iphone | iphone 13 | PLAIN-SILICONE",
    brand: "iphone",
    model: "iphone 13",
    type: "PLAIN-SILICONE",
    colors: ["Black", "Blue"],
    flags: [],
    items: [
      { product: caseProduct({ id: "p1", color: "Black", variationId: "v1", sellerSku: "sku1", images: ["a.jpg", "b.jpg"] }), name: "n1", color: "Black", price: 900, variationId: "v1", sellerSku: "sku1", categoryCode: "1000624" },
      { product: caseProduct({ id: "p2", color: "Blue", variationId: "v2", sellerSku: "sku2", images: ["b.jpg", "c.jpg"] }), name: "n2", color: "Blue", price: 950, variationId: "v2", sellerSku: "sku2", categoryCode: "1000624" },
    ],
  };

  const result = buildVariantMergePayload(cluster, "jumia-ke");
  const urls = (result.createPayload[0].images as JsonRecord[]).map((i) => i.url).sort();
  assert.deepEqual(urls, ["a.jpg", "b.jpg", "c.jpg"]);
});

// ---------------------------------------------------------------------
// Content policy pre-check
// ---------------------------------------------------------------------

test("scanContentPolicy flags a known-blacklisted phrase with its field name", () => {
  const issues = scanContentPolicy({ short_description: "Raised edges for camera and screen protection" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "short_description");
  assert.equal(issues[0].phrase, "screen protection");
});

test("scanContentPolicy is case-insensitive and returns nothing for clean text", () => {
  assert.equal(scanContentPolicy({ description: "SCREEN PROTECTION included" }).length, 1);
  assert.deepEqual(scanContentPolicy({ description: "A perfectly ordinary description." }), []);
});
