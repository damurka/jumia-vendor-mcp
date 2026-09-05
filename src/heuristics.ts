/**
 * Pure, network-free logic for the two tools that the Vendor Center API has
 * no native concept of: "find products that are outdated" and "find products
 * that were posted twice as separate listings." Both are heuristics over
 * whatever GET /catalog/products (+ GET /catalog/stock) return - not
 * first-class API features - so they live here, separately from client.ts,
 * specifically so they can be unit-tested without touching the network (see
 * tests/heuristics.test.ts).
 *
 * Read the README's "what's left out" section before trusting these blindly:
 * neither "outdated" nor "duplicate" is something Jumia's API defines, so
 * these encode a reasonable default definition that you should tune (or
 * override) for your own catalog.
 *
 * Shape of what GET /catalog/products actually returns - confirmed against a
 * live response, which for "name" disagrees with the published OpenAPI schema
 * (documented as {"value": ...}, but the live API returns a plain string).
 * This matters because it's a 3-level nest, not a flat product list:
 *
 *     {
 *       "id": <product-set id>, "name": "...", "brand": {"code","name"},
 *       "category": {"code","name"}, "images": [{"url","originalUrl","primary"}],
 *       "createdAt", "updatedAt",
 *       "variations": [
 *         {
 *           "id": <productSid - what update/price/stock/status feeds key on>,
 *           "sellerSku", "barcodeEan", "variation",
 *           "globalPrice": {"currency","value","salePrice"},
 *           "businessClients": [
 *             {
 *               "code", "countryCode", "sku", "visible", "status",
 *               "qc": {"status","updatedAt","lastApprovedAt","rejectionReason","rejectionComment"},
 *               "price": {"currency","value","localCurrency","localValue","salePrice"}
 *             }, ...
 *           ]
 *         }, ...
 *       ]
 *     }
 *
 * Status and QC are per (variation, businessClient), NOT on the top-level
 * product - a product can be live and QC-approved in one country and
 * rejected in another at the same time. flattenListings() below turns this
 * into one row per real listing, which is the level "outdated" actually
 * needs to be evaluated at.
 */
import { ratio } from "./stringSimilarity.ts";

// biome-ignore lint: Jumia's API returns loosely-typed JSON; matching the
// Python version's `dict[str, Any]` rather than modeling every field.
export type JsonRecord = Record<string, any>;

export function parseDt(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  let text = String(value);
  // Handle both date-only (YYYY-MM-DD) and full ISO date-times. If there's
  // no timezone offset at all, assume UTC - matching the Python port's
  // `replace(tzinfo=timezone.utc)` fallback; JS's Date does NOT default a
  // bare date-only or offset-less date-time string to UTC consistently
  // across engines the way that explicit fallback does.
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if (!hasOffset && !isDateOnly) {
    text = `${text}Z`;
  } else if (isDateOnly) {
    text = `${text}T00:00:00Z`;
  }
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// ---------------------------------------------------------------------
// Flattening: one row per (product, variation, businessClient) listing
// ---------------------------------------------------------------------

/**
 * Turn GET /catalog/products' nested Product Set -> variations ->
 * businessClients response into one flat dict per real, sellable listing.
 * Each row carries everything needed to both evaluate heuristics AND build
 * a deactivateProducts/updatePrice/updateStock payload straight from it
 * (variationId is the productSid those feeds expect).
 */
export function flattenListings(products: JsonRecord[]): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const product of products) {
    const name = product.name;
    const brandCode = product.brand?.code;
    const categoryCode = product.category?.code;
    const images: string[] = (product.images ?? []).map((img: JsonRecord) => img.url).filter(Boolean);
    const productUpdatedAt = product.updatedAt;

    for (const variation of product.variations ?? []) {
      const varCommon = {
        product_set_id: product.id,
        name,
        brand_code: brandCode,
        category_code: categoryCode,
        images,
        product_updated_at: productUpdatedAt,
        variation_id: variation.id, // == productSid for feed calls
        seller_sku: variation.sellerSku,
        barcode_ean: variation.barcodeEan,
        variation: variation.variation,
        global_price: variation.globalPrice?.value,
      };
      const businessClients = variation.businessClients ?? [];
      if (businessClients.length === 0) {
        rows.push({ ...varCommon, business_client_code: null });
        continue;
      }
      for (const bc of businessClients) {
        const qc = bc.qc ?? {};
        rows.push({
          ...varCommon,
          business_client_code: bc.code,
          country_code: bc.countryCode,
          status: bc.status,
          visible: bc.visible,
          qc_status: qc.status,
          qc_updated_at: qc.updatedAt,
          qc_last_approved_at: qc.lastApprovedAt,
          qc_rejection_reason: qc.rejectionReason,
          qc_rejection_comment: qc.rejectionComment,
          price: bc.price?.value,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// Outdated listings
// ---------------------------------------------------------------------

export interface OutdatedListing {
  listing: JsonRecord;
  reasons: string[];
}

export interface FindOutdatedProductsOptions {
  stockByVariationId?: Record<string, number>;
  now?: Date;
  qcRejectedGraceDays?: number;
  zeroStockGraceDays?: number;
  staleActiveGraceDays?: number;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Flattens `products` (as returned by GET /catalog/products) into one row
 * per (variation, businessClient) listing, then flags a listing as an
 * "outdated" candidate - for human review, then deactivateProducts - when
 * ANY of these hold:
 *
 *   - qc_status == REJECTED and it's been that way for more than
 *     qcRejectedGraceDays, measured from qc.updatedAt (the actual QC
 *     decision timestamp - much more precise than falling back to the
 *     product's updatedAt). The rejection reason/comment ride along in the
 *     result so you don't have to look them up separately.
 *   - status == ACTIVE, stock (from stockByVariationId, keyed by
 *     variation_id == productSid) is 0, and the product hasn't been touched
 *     in zeroStockGraceDays - i.e. not just a momentary stockout.
 *   - status == ACTIVE and the product's updatedAt is older than
 *     staleActiveGraceDays - nothing about the listing has changed in a
 *     very long time, often a sign it was forgotten.
 *
 * None of this is a Jumia concept - it's a starting point. Adjust the grace
 * periods (or add your own rule) to match how your catalog actually
 * behaves. Each returned `listing` already has variation_id (productSid),
 * seller_sku and business_client_code, i.e. exactly what deactivateProducts
 * needs - no extra lookup required.
 */
export function findOutdatedProducts(products: JsonRecord[], options: FindOutdatedProductsOptions = {}): OutdatedListing[] {
  const now = options.now ?? new Date();
  const stockByVariationId = options.stockByVariationId ?? {};
  const qcRejectedGraceDays = options.qcRejectedGraceDays ?? 14;
  const zeroStockGraceDays = options.zeroStockGraceDays ?? 30;
  const staleActiveGraceDays = options.staleActiveGraceDays ?? 180;

  const flagged: OutdatedListing[] = [];

  for (const listing of flattenListings(products)) {
    const reasons: string[] = [];
    const qcStatus = listing.qc_status;
    const status = listing.status;

    let qcAgeDays: number | null = null;
    const qcUpdatedAt = parseDt(listing.qc_updated_at);
    if (qcUpdatedAt) {
      qcAgeDays = daysBetween(now, qcUpdatedAt);
    }

    if (qcStatus === "REJECTED" && qcAgeDays !== null && qcAgeDays >= qcRejectedGraceDays) {
      const reasonDetail = listing.qc_rejection_reason || "no reason given by Jumia";
      reasons.push(`QC REJECTED for ${qcAgeDays} days (>= ${qcRejectedGraceDays}); reason: ${reasonDetail}`);
    }

    let productAgeDays: number | null = null;
    const productUpdatedAt = parseDt(listing.product_updated_at);
    if (productUpdatedAt) {
      productAgeDays = daysBetween(now, productUpdatedAt);
    }

    const stock = stockByVariationId[listing.variation_id];
    if (status === "ACTIVE" && stock === 0 && productAgeDays !== null && productAgeDays >= zeroStockGraceDays) {
      reasons.push(`ACTIVE with 0 stock and not updated in ${productAgeDays} days (>= ${zeroStockGraceDays})`);
    }

    if (status === "ACTIVE" && productAgeDays !== null && productAgeDays >= staleActiveGraceDays) {
      reasons.push(`ACTIVE but untouched for ${productAgeDays} days (>= ${staleActiveGraceDays})`);
    }

    if (reasons.length > 0) {
      flagged.push({ listing, reasons });
    }
  }

  return flagged;
}

// ---------------------------------------------------------------------
// Duplicate / "posted twice" products
// ---------------------------------------------------------------------

export interface DuplicateCluster {
  key: string;
  reason: string;
  products: JsonRecord[];
  suggestedCanonical: JsonRecord | null;
}

function normalizeName(name: string | undefined): string {
  // NFKD-decompose (e.g. "é" -> "e" + a combining acute accent, U+0301),
  // then strip everything outside ASCII - which removes the now-detached
  // combining marks along with anything else non-ASCII in one pass. Mirrors
  // Python's unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().
  const asciiOnly = (name ?? "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const lowered = asciiOnly.toLowerCase();
  return lowered.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** barcodeEan lives per-variation; a product can have several (one per variation). */
function gtinsOf(product: JsonRecord): Set<string> {
  const gtins = new Set<string>();
  for (const variation of product.variations ?? []) {
    const ean = variation.barcodeEan;
    if (ean) gtins.add(String(ean).trim());
  }
  return gtins;
}

function imageSignature(product: JsonRecord): string | null {
  const urls = (product.images ?? [])
    .map((img: JsonRecord) => img.url ?? "")
    .filter((u: string) => u)
    .sort();
  return urls.length > 0 ? urls.join("|") : null;
}

/** True if ANY variation is ACTIVE + QC APPROVED on ANY business client. */
function isLive(product: JsonRecord): boolean {
  for (const variation of product.variations ?? []) {
    for (const bc of variation.businessClients ?? []) {
      if (bc.status === "ACTIVE" && bc.qc?.status === "APPROVED") return true;
    }
  }
  return false;
}

/** Prefer: live somewhere (ACTIVE + QC APPROVED), then oldest createdAt (the original listing). */
function pickCanonical(products: JsonRecord[]): JsonRecord | null {
  if (products.length === 0) return null;
  const scored = products.map((p) => ({ p, liveOk: isLive(p) ? 0 : 1, created: p.createdAt ?? "" }));
  scored.sort((a, b) => a.liveOk - b.liveOk || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return scored[0].p;
}

export interface FindDuplicateCandidatesOptions {
  nameSimilarityThreshold?: number;
}

/**
 * Groups product SETS (the top-level records from GET /catalog/products,
 * each of which may itself have several legitimate variations) that look
 * like the same real-world item was listed more than once, using two
 * independent signals:
 *
 *   1. Exact match on barcodeEan (GTIN/EAN/UPC), when present on any
 *      variation - the strongest signal, since two listings sharing a real
 *      barcode are almost certainly the same product.
 *   2. Same brand + same category + near-identical normalized name (string
 *      similarity ratio >= nameSimilarityThreshold) + the same set of image
 *      URLs - a softer signal for catalogs that don't populate a barcode.
 *
 * This does NOT merge anything - Jumia's seller API has no merge operation
 * (see the README). It only reports clusters, each with a suggestedCanonical
 * pick (live somewhere + oldest wins) so a human can decide, then call
 * deactivateProducts() on the ones being dropped.
 */
export function findDuplicateCandidates(products: JsonRecord[], options: FindDuplicateCandidatesOptions = {}): DuplicateCluster[] {
  const nameSimilarityThreshold = options.nameSimilarityThreshold ?? 0.92;
  const clusters: DuplicateCluster[] = [];

  // Pass 1: exact GTIN/EAN match.
  const byGtin = new Map<string, JsonRecord[]>();
  for (const p of products) {
    for (const gtin of gtinsOf(p)) {
      const list = byGtin.get(gtin);
      if (list) list.push(p);
      else byGtin.set(gtin, [p]);
    }
  }
  const clusteredSet = new Set<JsonRecord>();
  for (const [gtin, group] of byGtin) {
    // A single product can legitimately appear under >1 GTIN (one per
    // variation); only cluster distinct product sets, not the same one
    // against itself.
    const distinct = Array.from(new Set(group));
    if (distinct.length > 1) {
      clusters.push({
        key: `gtin:${gtin}`,
        reason: "Same GTIN/EAN (barcodeEan) on a variation",
        products: distinct,
        suggestedCanonical: pickCanonical(distinct),
      });
      for (const p of distinct) clusteredSet.add(p);
    }
  }

  // Pass 2: brand + category + fuzzy name + identical image set, for
  // whatever wasn't already caught by GTIN.
  const remaining = products.filter((p) => !clusteredSet.has(p));
  const buckets = new Map<string, JsonRecord[]>();
  for (const p of remaining) {
    const brand = p.brand?.code;
    const category = p.category?.code;
    const images = imageSignature(p);
    const bucketKey = JSON.stringify([brand ?? null, category ?? null, images]);
    const list = buckets.get(bucketKey);
    if (list) list.push(p);
    else buckets.set(bucketKey, [p]);
  }

  for (const [bucketKey, group] of buckets) {
    const [brand, category, images] = JSON.parse(bucketKey);
    if (group.length < 2 || images === null) continue;

    // Within a bucket every product already shares brand+category+images;
    // only cluster the ones whose names are ALSO near-identical, so we
    // don't lump together e.g. a phone and its case just because a seller
    // reused one photo.
    const used = new Array(group.length).fill(false);
    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue;
      const nameI = normalizeName(group[i].name);
      const clusterGroup = [group[i]];
      used[i] = true;
      for (let j = i + 1; j < group.length; j++) {
        if (used[j]) continue;
        const nameJ = normalizeName(group[j].name);
        if (ratio(nameI, nameJ) >= nameSimilarityThreshold) {
          clusterGroup.push(group[j]);
          used[j] = true;
        }
      }
      if (clusterGroup.length > 1) {
        clusters.push({
          key: `fuzzy:${brand}:${category}:${nameI}`,
          reason: "Same brand, category and images, near-identical name",
          products: clusterGroup,
          suggestedCanonical: pickCanonical(clusterGroup),
        });
      }
    }
  }

  return clusters;
}
