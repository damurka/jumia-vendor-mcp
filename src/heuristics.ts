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

// ---------------------------------------------------------------------
// Variant fragments: the same real item posted as separate PRODUCT SETS
// per color, instead of one product set with a color variation under a
// shared parentSku. findDuplicateCandidates() above deliberately does NOT
// catch most of these - its fuzzy-name match requires near-identical names,
// but two color-variant listings of the same case are routinely posted with
// completely different titles by different sellers/times. Built from a live
// audit of a real catalog (~700 phone-case listings; only ~50 were caught by
// exact-title-after-color-strip matching, ~400+ more were genuine fragments
// once brand+model+case-type clustering was used instead).
//
// This is intentionally domain-informed (phone-case brands/models/types),
// not a universal heuristic - extend BRAND_PATTERNS/MODEL_PATTERNS/
// CASE_TYPE_PATTERNS for other product categories rather than expecting this
// to work unmodified on, say, apparel or electronics accessories in general.
// ---------------------------------------------------------------------

export const DEFAULT_COLOR_CANONICAL: Record<string, string> = {
  black: "Black", blue: "Blue", purple: "Purple", maroon: "Maroon", burgundy: "Maroon",
  "red/maroon": "Maroon", blacl: "Black", green: "Green", pink: "Pink", grey: "Grey",
  gray: "Grey", "thin grey": "Grey", beige: "Beige", "beige nude": "Beige Nude",
  "dark blue": "Dark Blue", "navy blue": "Navy Blue", navy: "Navy Blue", peach: "Peach",
  white: "White", gold: "Gold", silver: "Silver", yellow: "Yellow", orange: "Orange",
  brown: "Brown", teal: "Teal", red: "Red", "light pink": "Light Pink", clear: "Clear",
  transparent: "Transparent",
};

/**
 * Normalizes a raw color attribute value to a canonical display form, or
 * `null` for garbage/ambiguous values (comma-lists like "black,grey,white",
 * unrecognized strings) - callers should EXCLUDE the whole cluster a `null`
 * came from rather than silently dropping just that listing or guessing at
 * its color; a wrong guess here means merging the wrong photo/copy into a
 * variant a customer actually ordered.
 */
export function normalizeColorValue(raw: unknown, canonical: Record<string, string> = DEFAULT_COLOR_CANONICAL): string | null {
  if (!raw) return null;
  const c = String(raw).toLowerCase().trim();
  if (c.includes(",")) return null;
  return canonical[c] ?? null;
}

function colorAttrOf(product: JsonRecord): string | undefined {
  const attr = (product.attributes ?? []).find((a: JsonRecord) => a.name?.toLowerCase() === "color");
  return attr?.value;
}

const BRAND_PATTERNS: Record<string, RegExp> = {
  iphone: /iphone/i,
  samsung: /samsung|\bgalaxy\b/i,
  oppo: /\boppo\b/i,
  xiaomi: /xiaomi|redmi|\bpoco\b/i,
  realme: /\brealme\b/i,
  infinix: /\binfinix\b/i,
  tecno: /\btecno\b/i,
  pixel: /\bpixel\b/i,
};

/** One capturing pattern per brand for its model number/name. */
const MODEL_PATTERNS: Record<string, RegExp> = {
  iphone: /iphone\s*(se\s*(2020|2022)?|\d{1,2}\s*(pro\s*max|promax|pro|plus|mini)?)/i,
  samsung: /galaxy\s*(z\s*fold\s*\d+|z\s*flip\s*\d+|note\s*\d+\s*(ultra)?|a\d{2}[a-z]?\s*(5g|4g)?|s\d{2}\s*(ultra|plus|\+)?|m\d{2}\s*(5g)?)/i,
  oppo: /(reno\s*\d+[a-z]*\s*(5g|4g|f)?|a\d{2,3}\s*(5g|4g)?|find\s*x\d*)/i,
  xiaomi: /(redmi\s*(note\s*)?\d+[a-z]*\s*(pro|5g|4g)?|poco\s*[a-z]?\d+|mi\s*\d+[a-z]*)/i,
  realme: /(c\d{2}s?|\d{1,2}\s*(pro)?)/i,
  infinix: /(smart\s*\d+|camon\s*\d+\s*(pro)?|spark\s*\d+|note\s*\d+|hot\s*\d+)/i,
  tecno: /(camon\s*\d+\s*(pro)?|spark\s*\d+|pova\s*\d+)/i,
  pixel: /pixel\s*\d+[a-z]*\s*(pro)?/i,
};

function extractBrandModel(name: string): { brand: string; model: string } | null {
  const lower = name.toLowerCase();
  for (const [brand, brandRe] of Object.entries(BRAND_PATTERNS)) {
    if (!brandRe.test(lower)) continue;
    const modelRe = MODEL_PATTERNS[brand];
    const m = lower.match(modelRe);
    return { brand, model: m ? m[0].replace(/\s+/g, " ").trim() : "UNKNOWN" };
  }
  return null;
}

/**
 * Case "type" - a physically/functionally different product, never a color
 * of another type (a MagSafe case is not a "color variant" of a plain
 * silicone one, and merging them would misrepresent both). Order matters:
 * first match wins, so more specific brand-hardware terms are checked before
 * generic ones.
 */
const CASE_TYPE_PATTERNS: Array<[string, RegExp]> = [
  ["HARD-CASE-BRANDED", /nillkin|nilkin|camshield/i],
  ["LEATHER/WALLET/FLIP", /leather|wallet|flip cover|book cover/i],
  ["MAGSAFE/MAGNETIC", /magsafe|magnetic|wireless charging|electroplat/i],
  ["STAND/HOLDER", /\bstand\b|\bholder\b/i],
  ["MILITARY-GRADE", /military[- ]grade|drop[- ]proof|\barmor\b/i],
  ["LIQUID-SILICONE", /liquid silicone|liquid slim|liquid case/i],
  ["MICROFIBER-LINED", /microfib|micro fibre|micro fiber/i],
  ["CLEAR/TRANSPARENT", /\bclear\b|transparent/i],
  ["GLASS-SCREEN-ADJACENT", /\bglass\b|tempered/i],
];

export function classifyListingType(name: string): string {
  for (const [type, re] of CASE_TYPE_PATTERNS) {
    if (re.test(name)) return type;
  }
  return "PLAIN-SILICONE";
}

const BUNDLE_KEYWORDS = /bundle|screen protector|tempered glass|3-in-1|3 in 1|combo|kit\b/i;
const DIFFERENT_MATERIAL_KEYWORDS = /carbon fiber|leather|wallet|flip cover|electroplat/i;

/**
 * Anomalies worth a human's attention before merging a candidate cluster -
 * every one of these was a REAL bug caught this way in a live catalog (a
 * carbon-fiber case hiding under a color name in a "plain silicone" cluster,
 * a 3-in-1 bundle mixed in with single cases, a weight field in the wrong
 * unit, one listing priced 2x its cluster-mates because it was secretly a
 * different product). None of these are proof of a real problem by
 * themselves - `DIFFERENT_MATERIAL`/`BUNDLE_KEYWORD` in particular fire on
 * marketing copy that merely *mentions* an accessory (e.g. "attaches to
 * MagSafe wallets") - so read the flagged item's actual description before
 * excluding it, don't auto-exclude on the flag alone.
 */
function detectAnomalies(items: Array<{ name: string; price?: number; product: JsonRecord }>): string[] {
  const flags: string[] = [];
  const prices = items.map((it) => it.price).filter((p): p is number => typeof p === "number");
  if (prices.length >= 2) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min > 0 && max / min > 1.8) flags.push(`PRICE_OUTLIER: range ${min}-${max} (ratio ${(max / min).toFixed(1)})`);
  }
  for (const it of items) {
    const desc: string = it.product.description ?? "";
    const bundleMatch = desc.match(BUNDLE_KEYWORDS);
    if (bundleMatch) flags.push(`BUNDLE_KEYWORD in "${it.name}": ${bundleMatch[0]}`);
    const materialMatch = desc.match(DIFFERENT_MATERIAL_KEYWORDS);
    if (materialMatch) flags.push(`DIFFERENT_MATERIAL in "${it.name}": ${materialMatch[0]}`);
    const weight = (it.product.attributes ?? []).find((a: JsonRecord) => a.name?.toLowerCase() === "product_weight")?.value;
    if (weight && (String(weight).includes("g") || Number(weight) > 0.15 || Number(weight) < 0.005)) {
      flags.push(`WEIGHT_ANOMALY in "${it.name}": ${weight}`);
    }
  }
  return flags;
}

export interface VariantFragmentItem {
  product: JsonRecord;
  name: string;
  color: string;
  price: number | undefined;
  variationId: string | undefined;
  sellerSku: string | undefined;
  categoryCode: string | undefined;
}

export interface VariantFragmentCluster {
  key: string; // "brand | model | type"
  brand: string;
  model: string;
  type: string;
  colors: string[];
  items: VariantFragmentItem[];
  flags: string[];
}

export interface FindVariantFragmentsOptions {
  colorCanonical?: Record<string, string>;
  minColors?: number;
}

/**
 * Groups product SETS that look like the same case posted once per color,
 * by (brand, model, case-type) rather than by name similarity - see the
 * module comment above for why findDuplicateCandidates' fuzzy-name match
 * misses most of these. Returns candidate clusters only (>= minColors
 * distinct, recognized colors) with anomaly flags for human review; this
 * NEVER merges or writes anything. Feed a cluster (after you've resolved its
 * flags, and dropped/fixed any bad items) into buildVariantMergePayload() to
 * get an actual create_products/deactivate payload.
 */
export function findVariantFragments(products: JsonRecord[], options: FindVariantFragmentsOptions = {}): VariantFragmentCluster[] {
  const canonical = options.colorCanonical ?? DEFAULT_COLOR_CANONICAL;
  const minColors = options.minColors ?? 2;

  const buckets = new Map<string, { brand: string; model: string; type: string; items: VariantFragmentItem[] }>();

  for (const product of products) {
    const name: string = product.name ?? "";
    const bm = extractBrandModel(name);
    if (!bm || bm.model === "UNKNOWN") continue;
    const type = classifyListingType(name);
    const key = `${bm.brand} | ${bm.model} | ${type}`;
    const variation = product.variations?.[0];
    const item: VariantFragmentItem = {
      product,
      name,
      color: colorAttrOf(product) ?? "",
      price: variation?.globalPrice?.value,
      variationId: variation?.id,
      sellerSku: variation?.sellerSku,
      categoryCode: product.category?.code,
    };
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(item);
    else buckets.set(key, { brand: bm.brand, model: bm.model, type, items: [item] });
  }

  const clusters: VariantFragmentCluster[] = [];
  for (const [key, bucket] of buckets) {
    const colors = new Set<string>();
    for (const it of bucket.items) {
      const c = normalizeColorValue(it.color, canonical);
      if (c) colors.add(c);
    }
    if (colors.size < minColors) continue;
    clusters.push({
      key,
      brand: bucket.brand,
      model: bucket.model,
      type: bucket.type,
      colors: [...colors],
      items: bucket.items,
      flags: detectAnomalies(bucket.items),
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------
// Building a merge payload from a (human-reviewed) variant fragment cluster
// ---------------------------------------------------------------------

const COLOR_WORDS_FOR_STRIP = [...new Set(Object.values(DEFAULT_COLOR_CANONICAL).map((c) => c.toLowerCase()).concat(Object.keys(DEFAULT_COLOR_CANONICAL)))].sort(
  (a, b) => b.length - a.length,
);

function stripColorAndPunct(title: string): string {
  let s = title.replace(/[–—]/g, "-");
  for (const c of COLOR_WORDS_FOR_STRIP) {
    s = s.replace(new RegExp(`\\b${c}\\b`, "gi"), " ");
  }
  s = s.replace(/\(\s*\)/g, " ");
  s = s.replace(/[-,]\s*$/g, "");
  s = s.replace(/^[-,\s]+/, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s.replace(/[-,]\s*$/g, "").trim();
}

/** Strips any mention of the cluster's OTHER colors from shared body copy before it's reused across every variant. */
export function genericizeBodyText(text: string | undefined, colorsInCluster: string[]): string {
  if (!text) return "";
  const colors = [...colorsInCluster].sort((a, b) => b.length - a.length);
  let s = text;
  for (const c of colors) {
    s = s.replace(new RegExp(`\\(\\s*${c}\\s*\\)`, "gi"), "");
    s = s.replace(new RegExp(`[-–]\\s*${c}\\b`, "gi"), "");
    s = s.replace(new RegExp(`\\b${c}\\s+(finish|case|cover)\\b`, "gi"), "$1");
    s = s.replace(new RegExp(`\\b${c}\\b`, "gi"), "");
  }
  return s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

function attrValueOf(p: JsonRecord, name: string): string | undefined {
  return (p.attributes ?? []).find((a: JsonRecord) => a.name?.toLowerCase() === name.toLowerCase())?.value;
}

export interface BuildVariantMergePayloadOptions {
  category?: { code: string; name: string };
  nameOverride?: string;
  weightOverride?: string;
}

export interface VariantMergeResult {
  createPayload: JsonRecord[];
  deactivateList: Array<{ id: string; sellerSku: string; business_client_code: string }>;
  genericName: string;
}

/**
 * Turns one (already human-reviewed) VariantFragmentCluster into a ready-to-
 * submit create_products payload plus the deactivate list for everything it
 * supersedes. Per color: highest price wins as the kept listing, everything
 * else at that color becomes a deactivation entry alongside every other
 * color's loser. The shared description/short_description/package_content
 * come from whichever winner's (color-stripped) body text is the MODAL
 * match across all winners - not simply the longest one - so an outlier
 * listing's one-off claim (an extra feature, a wrong model mention) can't
 * become the copy every color inherits. Does NOT include `stock` - look
 * that up per winning variationId (get_stock) and set it before calling
 * create_products, same as every other consolidation this session.
 */
export function buildVariantMergePayload(
  cluster: VariantFragmentCluster,
  businessClientCode: string,
  options: BuildVariantMergePayloadOptions = {},
): VariantMergeResult {
  const byColor = new Map<string, VariantFragmentItem[]>();
  for (const it of cluster.items) {
    const color = normalizeColorValue(it.color) ?? it.color;
    if (!color) continue;
    const list = byColor.get(color);
    if (list) list.push(it);
    else byColor.set(color, [it]);
  }

  const winners: Array<{ color: string; item: VariantFragmentItem }> = [];
  const losers: VariantFragmentItem[] = [];
  for (const [color, items] of byColor) {
    const sorted = [...items].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    winners.push({ color, item: sorted[0] });
    losers.push(...sorted.slice(1));
  }

  const colors = winners.map((w) => w.color);
  const normDescCounts = new Map<string, Array<{ color: string; item: VariantFragmentItem }>>();
  for (const w of winners) {
    const norm = genericizeBodyText(w.item.product.description, colors).toLowerCase().replace(/\s+/g, " ").trim();
    const list = normDescCounts.get(norm);
    if (list) list.push(w);
    else normDescCounts.set(norm, [w]);
  }
  let bestGroup: Array<{ color: string; item: VariantFragmentItem }> = [];
  for (const grp of normDescCounts.values()) if (grp.length > bestGroup.length) bestGroup = grp;
  const template = (bestGroup[0] ?? winners[0]).item.product;

  const genericName = options.nameOverride ?? stripColorAndPunct(template.name ?? "");
  const genericDescription = genericizeBodyText(template.description, colors);
  const shortDesc = genericizeBodyText(attrValueOf(template, "short_description"), colors);
  const packageContent = genericizeBodyText(attrValueOf(template, "package_content"), colors);
  const weight = options.weightOverride ?? attrValueOf(template, "product_weight") ?? "0.02";
  const material = attrValueOf(template, "main_material") ?? "Silicone";
  const modelAttr = attrValueOf(template, "model") ?? genericName;
  const category = options.category ?? template.category ?? { code: "", name: "" };
  const brand = template.brand ?? {};

  const seenUrls = new Set<string>();
  const images: JsonRecord[] = [];
  for (const it of cluster.items) {
    for (const img of it.product.images ?? []) {
      if (!img.url || seenUrls.has(img.url)) continue;
      seenUrls.add(img.url);
      images.push({ url: img.url, primary: images.length === 0 });
    }
  }

  const parentSku = `${genericName} - ${winners[0].color}`;
  const createPayload = winners.map((w) => ({
    name: { value: genericName, translations: [{ language: "en", value: genericName }] },
    description: { value: genericDescription, translations: [{ language: "en", value: genericDescription }] },
    sellerSku: `${genericName} - ${w.color}`,
    parentSku,
    variation: w.color,
    brand,
    category,
    images,
    price: { currency: "KES", value: w.item.price },
    attributes: [
      { name: "short_description", value: shortDesc },
      { name: "product_weight", value: weight },
      { name: "main_material", value: material },
      { name: "model", value: modelAttr },
      { name: "package_content", value: packageContent },
      { name: "color", value: w.color },
    ],
  }));

  const deactivateList = [...winners.map((w) => w.item), ...losers]
    .filter((it) => it.variationId && it.sellerSku)
    .map((it) => ({ id: it.variationId as string, sellerSku: it.sellerSku as string, business_client_code: businessClientCode }));

  return { createPayload, deactivateList, genericName };
}

// ---------------------------------------------------------------------
// Content policy pre-check
// ---------------------------------------------------------------------

/**
 * Phrases confirmed LIVE to be on Jumia Kenya's word blacklist - discovered
 * the hard way (a create_products call rejected with "The highlighted word
 * has been placed on the blacklist, prohibiting its usage in Kenya", the
 * exact same phrase tripping two unrelated listings' short_description on
 * the same day). This is NOT an exhaustive list of Jumia's actual blacklist
 * (which isn't published) - it only grows as new rejections are observed
 * live. Treat a clean scan as "nothing we've seen before", not "guaranteed
 * to pass".
 */
export const KNOWN_CONTENT_BLACKLIST: string[] = ["screen protection"];

export interface ContentPolicyIssue {
  field: string;
  phrase: string;
}

/**
 * Scans the text fields Jumia actually validates (name, description, and
 * any attribute value) against KNOWN_CONTENT_BLACKLIST before you spend an
 * API round-trip finding out live. `fields` should be {name: text}, e.g.
 * {description: "...", short_description: "...", package_content: "..."}.
 */
export function scanContentPolicy(fields: Record<string, string | undefined>, blacklist: string[] = KNOWN_CONTENT_BLACKLIST): ContentPolicyIssue[] {
  const issues: ContentPolicyIssue[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const phrase of blacklist) {
      if (lower.includes(phrase.toLowerCase())) issues.push({ field, phrase });
    }
  }
  return issues;
}
