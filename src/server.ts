/**
 * MCP server exposing Jumia Vendor Center's GPM (catalog) and GOP (orders)
 * APIs as tools.
 *
 * Run with:  node src/server.ts
 * (or point an MCP client - Claude Desktop, Claude Code, etc - at this
 * module; see README.md for the client config snippet.)
 *
 * Tool naming maps directly to the requirements this was built for:
 *   1. find_outdated_products      - flag stale/rejected/dead listings (heuristic, read-only)
 *   2. deactivate_products         - the closest thing to "remove" a product (see NOTE below)
 *   3. update_products             - update the mutable subset of product fields
 *   4. create_products             - create new products, incl. images, price, stock, attributes
 *   5. sync_products               - diff a desired catalog state against the live one and push only what changed
 *   6. find_duplicate_products     - flag likely-duplicate listings (heuristic, read-only, no auto-merge)
 *   7. list_orders / get_order_items / cancel_order_items  - order management
 *   8. print_shipping_labels (+ pack/ready-to-ship/shipment-providers)   - fulfillment
 *   + everything else discovered while building this: shops, brands, categories,
 *     attributes, stock, consignment (warehouse inbound), payouts, feed status polling.
 *
 * IMPORTANT / read before wiring this into anything automated:
 *
 *   * There is NO delete endpoint for products in the published API. `status`
 *     can only be set to ACTIVE or INACTIVE by a seller; DELETED is a
 *     read-only value Jumia's own catalog ops can set. `deactivate_products`
 *     is therefore a deactivation, not a deletion - the listing still
 *     exists, just hidden/unsellable. Say so to anyone who asks this server
 *     to "delete" or "remove" a product.
 *
 *   * There is NO merge endpoint. `find_duplicate_products` only reports
 *     candidate clusters (by GTIN match, or by brand+category+images+fuzzy
 *     name) with a suggested canonical listing. Resolving a real duplicate
 *     (moving reviews/ranking/stock history to one SID) is a Jumia catalog
 *     ops action outside this API's surface - what this tool can do is help
 *     you decide which of the two to deactivate.
 *
 *   * Every write tool logs to a local JSONL audit file (see config.ts /
 *     audit.ts) before returning - useful given how much of this is
 *     effectively irreversible from the seller side.
 *
 *   * Before calling create_products for a real-world branded product,
 *     SEARCH for the manufacturer's actual spec sheet, description copy,
 *     and product image URLs rather than inventing content - a fabricated
 *     spec risks a QC rejection or a listing that doesn't match what ships.
 *
 *   * deactivate_products / update_stock / update_price need the
 *     *variation* id (variations[].id from list_products), NOT the
 *     top-level product-set id - passing the product-set id fails with
 *     "Product by Sid [...] not found." find_outdated_products rows already
 *     carry the right one as variation_id.
 *
 *   * create_products' parentSku is REQUIRED even for a standalone product
 *     with no variants, despite the published schema marking it optional -
 *     set it equal to sellerSku for a non-variant listing.
 */
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

import { AuditLog } from "./audit.ts";
import { TokenManager } from "./auth.ts";
import { CatalogCache } from "./catalogCache.ts";
import { VendorApiClient } from "./client.ts";
import { loadSettings, type Settings } from "./config.ts";
import * as heuristics from "./heuristics.ts";
import type { JsonRecord } from "./heuristics.ts";
import { VendorApiHttp } from "./http.ts";
import { Mutex } from "./util/mutex.ts";

export const server = new McpServer(
  { name: "jumia-vendor-center", version: "0.1.0" },
  {
    instructions:
      "Tools for Jumia Vendor Center (GPM catalog + GOP order APIs). Read each tool's description before " +
      "using it - several document real limitations of the underlying API (no delete, no merge, which " +
      "product fields are actually updatable) that change what 'success' looks like.",
  },
);

// -- Lazy singleton: built on first tool call, not at import time (matters
// for the smoke test, which imports this module without real credentials
// present). Guarded by a Mutex the same way the Python version used a
// double-checked-locking asyncio.Lock.
let ctx: { client: VendorApiClient; audit: AuditLog } | null = null;
const ctxLock = new Mutex();

async function getCtx(): Promise<{ client: VendorApiClient; audit: AuditLog }> {
  if (ctx) return ctx;
  return ctxLock.runExclusive(async () => {
    if (ctx) return ctx;
    const settings: Settings = await loadSettings();
    const tokenManager = new TokenManager(settings);
    const http = new VendorApiHttp(settings.apiBaseUrl, tokenManager, {
      rateLimitRps: settings.rateLimitRps,
      rateLimitRpm: settings.rateLimitRpm,
    });
    const catalogCache = new CatalogCache();
    const client = new VendorApiClient(http, catalogCache);
    const audit = new AuditLog(settings.auditLogPath);
    ctx = { client, audit };
    return ctx;
  });
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Wraps a write tool's client call: logs both success and failure to the
 * audit log, invalidates the catalog scan cache on success (a cached scan
 * served right after a write must never show pre-write state), then
 * re-throws on failure.
 */
async function withAudit<T>(client: VendorApiClient, audit: AuditLog, action: string, request: unknown, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    client.invalidateCache();
    await audit.record(action, request, result, true);
    return result;
  } catch (e) {
    await audit.record(action, request, null, false, (e as Error).message);
    throw e;
  }
}

// ======================================================================
// Reference data
// ======================================================================

server.registerTool(
  "list_shops",
  { description: "List every shop under the authenticated Vendor Center account.", inputSchema: z.object({}) },
  async () => {
    const { client } = await getCtx();
    return jsonResult(await client.getShops());
  },
);

server.registerTool(
  "list_brands",
  {
    description: "List brand codes/names known to the catalog (paginated).",
    inputSchema: z.object({ page: z.number().int().optional() }),
  },
  async ({ page }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getBrands(page));
  },
);

server.registerTool(
  "list_categories",
  {
    description:
      "List categories. Each category includes `attributeSet.sid`, which you need before create_products/" +
      "update_products for a product in that category - pass it to get_attribute_set to see required/" +
      "optional attributes and their allowed values.",
    inputSchema: z.object({
      page: z.number().int().optional(),
      size: z.number().int().optional(),
      attribute_set_name: z.string().optional(),
    }),
  },
  async ({ page, size, attribute_set_name }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getCategories({ page, size, attributeSetName: attribute_set_name }));
  },
);

server.registerTool(
  "get_attribute_set",
  {
    description:
      "List the attributes (required or not, allowed values/options, validation rules) for a category's " +
      "attribute set. Get `attribute_set_id` from list_categories()'s attributeSet.sid field.",
    inputSchema: z.object({ attribute_set_id: z.string() }),
  },
  async ({ attribute_set_id }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getAttributes(attribute_set_id));
  },
);

// ======================================================================
// 1. Find outdated products
// ======================================================================

server.registerTool(
  "find_outdated_products",
  {
    description:
      "Scan the catalog for products that look outdated: QC-rejected and never fixed, ACTIVE with zero " +
      "stock for a long time, or ACTIVE and untouched for a very long time. This is a HEURISTIC - the " +
      "Vendor Center API has no \"outdated\" concept - so treat the result as a review list, not an " +
      "automatic deletion queue. Nothing is changed by calling this; pair it with deactivate_products() " +
      "after a human (or you, deliberately) has looked at the list.\n\n" +
      "Returns {scanned, flagged: [{listing, reasons}], truncated}. Each `listing` is a flattened " +
      "(variation, businessClient) row that already carries `variation_id` (== productSid), `seller_sku` " +
      "and `business_client_code` - i.e. exactly what deactivate_products needs, with no extra lookup required.",
    inputSchema: z.object({
      status: z.string().nullable().optional().default("ACTIVE"),
      qc_status: z.string().optional(),
      shop_id: z.string().optional(),
      category_code: z.string().optional(),
      max_products_scanned: z.number().int().default(2000),
      qc_rejected_grace_days: z.number().int().default(14),
      zero_stock_grace_days: z.number().int().default(30),
      stale_active_grace_days: z.number().int().default(180),
    }),
  },
  async ({
    status,
    qc_status,
    shop_id,
    category_code,
    max_products_scanned,
    qc_rejected_grace_days,
    zero_stock_grace_days,
    stale_active_grace_days,
  }) => {
    const { client } = await getCtx();

    const products: JsonRecord[] = [];
    for await (const p of client.iterAllProducts({
      status: status ?? undefined,
      qcStatus: qc_status,
      shopId: shop_id,
      categoryCode: category_code,
      cached: true,
    })) {
      products.push(p);
      if (products.length >= max_products_scanned) break;
    }
    const truncated = products.length >= max_products_scanned;

    const variationIds = products.flatMap((product) => (product.variations ?? []).map((v: JsonRecord) => v.id)).filter(Boolean);
    const stockByVariationId: Record<string, number> = {};
    const CHUNK = 100;
    for (let i = 0; i < variationIds.length; i += CHUNK) {
      const chunk = variationIds.slice(i, i + CHUNK);
      const page = await client.getStock({ productSids: chunk, size: chunk.length || 1 });
      for (const item of page.products ?? []) {
        if (item.id !== undefined && item.globalStock !== undefined) {
          stockByVariationId[item.id] = item.globalStock;
        }
      }
    }

    const flagged = heuristics.findOutdatedProducts(products, {
      stockByVariationId,
      qcRejectedGraceDays: qc_rejected_grace_days,
      zeroStockGraceDays: zero_stock_grace_days,
      staleActiveGraceDays: stale_active_grace_days,
    });

    return jsonResult({
      scanned: products.length,
      truncated,
      flagged: flagged.map((f) => ({ listing: f.listing, reasons: f.reasons })),
    });
  },
);

// ======================================================================
// 2. "Remove" (deactivate) products
// ======================================================================

const deactivateProductItem = z.object({
  id: z.string(),
  sellerSku: z.string(),
  business_client_codes: z.array(z.string()).optional(),
  business_client_code: z.string().optional(),
});

server.registerTool(
  "deactivate_products",
  {
    description:
      'The closest thing to "removing" a product from Jumia: sets status to INACTIVE per business client. ' +
      "THIS DOES NOT DELETE THE LISTING - there is no delete endpoint in the published API; INACTIVE just " +
      "makes it unsellable/hidden. If you actually need a listing permanently gone, that's a request to " +
      "your Jumia account manager, not something this tool (or any seller-facing API call) can do.\n\n" +
      '`products`: [{"id": "<productSid, i.e. variation_id>", "sellerSku": "...", ' +
      '"business_client_codes": ["jumia-ng", ...]}] (accepts a singular "business_client_code" string too, ' +
      "for convenience when acting on one find_outdated_products listing at a time - those rows already " +
      'have "variation_id"/"seller_sku"/"business_client_code" under exactly those names, just rename ' +
      "variation_id -> id).\n\nLogs every call to the local audit log before returning.",
    inputSchema: z.object({ products: z.array(deactivateProductItem) }),
  },
  async ({ products }) => {
    const { client, audit } = await getCtx();
    const payload = products.map((p) => {
      const codes = p.business_client_codes ?? (p.business_client_code ? [p.business_client_code] : undefined);
      if (!codes) {
        throw new Error(
          `products entry for sellerSku=${JSON.stringify(p.sellerSku)} is missing business_client_codes ` +
            "(or business_client_code) - fetch the product (find_outdated_products or list_products) to " +
            "see which business clients it's live on before deactivating, rather than guessing.",
        );
      }
      return {
        id: p.id,
        sellerSku: p.sellerSku,
        businessClients: codes.map((c) => ({ businessClientCode: c, status: "INACTIVE" })),
      };
    });

    const result = await withAudit(client, audit, "deactivate_products", payload, () => client.updateStatus(payload));
    return jsonResult(result);
  },
);

// ======================================================================
// 3 & 4. Create / update products
// ======================================================================

server.registerTool(
  "create_products",
  {
    description:
      "Create new products (async feed). Poll the returned feedId with get_feed_status() until status is " +
      "COMPLETED, then call it again (or list_products by sellerSku) to learn each product's real " +
      "productSid and QC status - both are required before you can update stock, price or status on a " +
      "newly-created product.\n\n" +
      "Each item in `products` (per the published schema):\n" +
      '  name: {"value": "...", "translations": [{"language": "en", "value": "..."}]}\n' +
      '  description: {"value": "...", "translations": [...]}\n' +
      "  sellerSku: str (required, your own unique SKU)\n" +
      "  parentSku: str (REQUIRED, despite the published schema marking it optional - confirmed live: " +
      "omitting it on a standalone, non-variant product fails with \"Required field [Product.ParentSKU] " +
      "is missing or null.\" For a single listing with no size/color variants, just set this equal to " +
      "sellerSku. Only set it to something else when you actually want to group size/color variants " +
      "together - every product sharing a parentSku must then pass the SAME images.)\n" +
      "  variation: str (required if parentSku groups variants; for a standalone product, set it equal " +
      "to sellerSku/name too)\n" +
      '  brand: {"code": ..., "name": "..."}\n' +
      '  category: {"code": ..., "name": "..."}   (from list_categories)\n' +
      '  images: [{"url": "https://...", "primary": true}, ...]   (>= 1 primary required)\n' +
      '  price: {"currency": "NGN", "value": 12000, "salePrice": {"value": 9000, "startAt": ' +
      '"2026-09-10", "endAt": "2026-09-20"}}\n' +
      "  stock: 50\n" +
      '  attributes: [{"name": "color", "value": "Black"}, ...]   (from get_attribute_set - call it ' +
      "first to see which attributes this category marks mandatory, e.g. product_weight/" +
      "short_description are required for AC Chargers)\n" +
      '  businessClients: [{"businessClientCode": "jumia-ng", "price": {...}}, ...]   (needed for a ' +
      "global/multi-country seller selling in local currency)\n\n" +
      "Before calling this for a real-world branded product, SEARCH for the manufacturer's actual spec " +
      "sheet, description copy, and product image URLs (their regional store site) rather than inventing " +
      "name/description/spec/image content - Jumia's own content guidelines expect accurate listings, and " +
      "a fabricated spec (wrong wattage, invented weight, wrong included accessories) risks a QC " +
      "rejection or a listing that doesn't match what ships. If the manufacturer's site blocks a plain " +
      "fetch (403), a real browser session (e.g. claude-in-chrome) often gets through where a headless " +
      "fetch doesn't. Only fields you truly cannot find published anywhere (e.g. shipping weight) should " +
      "be flagged to the user as an unverified estimate rather than silently guessed.\n\n" +
      "Cap ~1000 products per call - this tool does not auto-chunk larger lists for you (chunk them " +
      "yourself and call this repeatedly, tracking each feedId, so a failure in batch 6 doesn't force " +
      "you to redo 1-5).",
    inputSchema: z.object({ shop_id: z.string(), products: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ shop_id, products }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "create_products", { shopId: shop_id, count: products.length }, () =>
      client.createProducts(shop_id, products),
    );
    return jsonResult(result);
  },
);

server.registerTool(
  "update_products",
  {
    description:
      "Update the MUTABLE subset of product fields (async feed): additional category, brand, config " +
      "attributes, GTIN barcode, simple attributes, variation. This CANNOT change the main image, main " +
      "category, parent SKU, price, or initial stock - use update_price / update_stock for price and " +
      "stock, and be aware main image/category/parent SKU aren't changeable via this API at all once a " +
      "product is created.\n\nEach item needs the product's `id` (productSid) plus whichever fields " +
      "you're changing.",
    inputSchema: z.object({ products: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ products }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "update_products", { count: products.length }, () => client.updateProducts(products));
    return jsonResult(result);
  },
);

server.registerTool(
  "update_price",
  {
    description:
      'Update price (async feed). Each item: {"sellerSku", "id", "category", "price": {"currency", ' +
      '"value", "salePrice": {"value","startAt","endAt"}}, "businessClients": [...]}. To clear a sale ' +
      "price, send salePrice's value/startAt/endAt as null rather than omitting salePrice entirely.",
    inputSchema: z.object({ products: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ products }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "update_price", { count: products.length }, () => client.updatePrice(products));
    return jsonResult(result);
  },
);

server.registerTool(
  "update_stock",
  {
    description: 'Update stock (async feed). Each item: {"sellerSku", "id", "stock"}.',
    inputSchema: z.object({ products: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ products }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "update_stock", { count: products.length }, () => client.updateStock(products));
    return jsonResult(result);
  },
);

server.registerTool(
  "get_feed_status",
  {
    description:
      "Poll an async feed (returned by create_products/update_products/update_price/update_stock/" +
      "deactivate_products) until status is COMPLETED or FAILED. For a PRODUCT_CREATION feed, this is " +
      "also where you get each new product's productSid and QC status.",
    inputSchema: z.object({ feed_id: z.string() }),
  },
  async ({ feed_id }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getFeed(feed_id));
  },
);

// ======================================================================
// 5. Keep products up to date (diff + push)
// ======================================================================

server.registerTool(
  "sync_products",
  {
    description:
      "Reconcile your source of truth (an ERP export, a spreadsheet you've already parsed to JSON, etc) " +
      "against what's live on Jumia right now, and push only the fields that actually changed - instead " +
      "of you hand-writing separate create/update/price/stock calls.\n\n" +
      '`desired`: [{"sellerSku": "...", "price": 12000, "currency": "NGN", "stock": 50, "status": ' +
      '"ACTIVE"}, ...] (extend with brand/category/attributes if you also want update_products diffing - ' +
      "this baseline covers the highest-churn fields: price, stock, status.)\n\n" +
      "Looks up each sellerSku via list_products, diffs against `desired`, and by default (dry_run=true) " +
      "returns the planned actions WITHOUT calling anything - review the plan first. Set dry_run=false to " +
      "actually submit the price/stock/status feeds (batched, respecting the documented ~1000-item-per-" +
      "feed cap) and get back the resulting feedIds.\n\n" +
      "Returns {matched, not_found: [sellerSku...], plan: {price: [...], stock: [...], status: [...]}, " +
      "feed_ids: {...} (only when dry_run=false)}.",
    inputSchema: z.object({
      desired: z.array(z.record(z.string(), z.unknown())),
      shop_id: z.string().optional(),
      dry_run: z.boolean().default(true),
    }),
  },
  async ({ desired, shop_id, dry_run }) => {
    const { client, audit } = await getCtx();

    const bySku = new Map<string, JsonRecord>();
    for (const item of desired) {
      const sku = item.sellerSku;
      if (typeof sku !== "string" || !sku) {
        throw new Error(`desired entry missing sellerSku: ${JSON.stringify(item)}`);
      }
      bySku.set(sku, item);
    }

    // getProducts' response is a 3-level nest (product set -> variations ->
    // businessClients; see heuristics.ts's module docstring for the full
    // shape) - status/QC/price live on the variation+businessClient, not on
    // the product set itself, so find the specific variation matching each
    // requested sellerSku rather than trusting the outer record.
    const liveVariationBySku = new Map<string, [JsonRecord, JsonRecord]>();
    for (const sku of bySku.keys()) {
      const page = await client.getProducts({ sellerSku: sku, size: 5, shopId: shop_id });
      for (const product of page.products ?? []) {
        for (const variation of product.variations ?? []) {
          if (variation.sellerSku === sku) {
            liveVariationBySku.set(sku, [product, variation]);
          }
        }
      }
    }

    const notFound = Array.from(bySku.keys()).filter((sku) => !liveVariationBySku.has(sku));

    const priceUpdates: JsonRecord[] = [];
    const stockUpdates: JsonRecord[] = [];
    const statusUpdates: JsonRecord[] = [];
    for (const [sku, wanted] of bySku) {
      const pair = liveVariationBySku.get(sku);
      if (!pair) continue;
      const [product, variation] = pair;
      const variationId = variation.id; // productSid for feed calls

      if ("price" in wanted) {
        const currentPrice = variation.globalPrice?.value;
        if (currentPrice !== wanted.price) {
          priceUpdates.push({
            sellerSku: sku,
            id: variationId,
            category: product.category?.code,
            price: { currency: wanted.currency ?? "NGN", value: wanted.price },
          });
        }
      }

      if ("stock" in wanted) {
        stockUpdates.push({ sellerSku: sku, id: variationId, stock: wanted.stock });
      }

      if ("status" in wanted) {
        const businessClients = (variation.businessClients ?? [])
          .filter((bc: JsonRecord) => bc.status !== wanted.status)
          .map((bc: JsonRecord) => ({ businessClientCode: bc.code, status: wanted.status }));
        if (businessClients.length > 0) {
          statusUpdates.push({ id: variationId, sellerSku: sku, businessClients });
        }
      }
    }

    const plan = { price: priceUpdates, stock: stockUpdates, status: statusUpdates };

    if (dry_run) {
      return jsonResult({ matched: liveVariationBySku.size, not_found: notFound, plan });
    }

    const feedIds: Record<string, string[]> = { price: [], stock: [], status: [] };
    const CHUNK = 1000;
    const jobs: Array<[string, JsonRecord[], (items: JsonRecord[]) => Promise<JsonRecord>]> = [
      ["price", priceUpdates, (items) => client.updatePrice(items)],
      ["stock", stockUpdates, (items) => client.updateStock(items)],
      ["status", statusUpdates, (items) => client.updateStatus(items)],
    ];
    for (const [kind, items, fn] of jobs) {
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        if (chunk.length === 0) continue;
        const result = await fn(chunk);
        feedIds[kind].push(result.feedId);
      }
    }
    client.invalidateCache();
    await audit.record(
      "sync_products",
      { desired_count: desired.length },
      { plan_sizes: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])), feed_ids: feedIds },
      true,
    );

    return jsonResult({ matched: liveVariationBySku.size, not_found: notFound, plan, feed_ids: feedIds });
  },
);

server.registerTool(
  "list_products",
  {
    description: "One page of GET /catalog/products with the documented filters. Use `token` from the previous response to get the next page.",
    inputSchema: z.object({
      seller_sku: z.string().optional(),
      status: z.string().optional(),
      qc_status: z.string().optional(),
      shop_id: z.string().optional(),
      category_code: z.string().optional(),
      size: z.number().int().default(50),
      token: z.string().optional(),
    }),
  },
  async ({ seller_sku, status, qc_status, shop_id, category_code, size, token }) => {
    const { client } = await getCtx();
    return jsonResult(
      await client.getProducts({
        sellerSku: seller_sku,
        status,
        qcStatus: qc_status,
        shopId: shop_id,
        categoryCode: category_code,
        size,
        token,
      }),
    );
  },
);

server.registerTool(
  "get_stock",
  {
    description: "One page of GET /catalog/stock.",
    inputSchema: z.object({
      product_sids: z.array(z.string()).optional(),
      size: z.number().int().default(50),
      token: z.string().optional(),
    }),
  },
  async ({ product_sids, size, token }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getStock({ productSids: product_sids, size, token }));
  },
);

// ======================================================================
// 6. Find duplicate ("posted twice") products
// ======================================================================

server.registerTool(
  "find_duplicate_products",
  {
    description:
      "Flag products that look like the same real-world item listed more than once: exact GTIN/EAN/" +
      "barcode match, or same brand+category+images with a near-identical name. Jumia's seller API has " +
      "NO merge endpoint, so this only reports clusters with a suggested canonical listing (live " +
      "somewhere - ACTIVE + QC APPROVED on any business client - then oldest wins) - resolving it means " +
      "you decide, then call deactivate_products() on the ones you're dropping. Narrow with " +
      "`category_code` for large catalogs; this does a full paginated scan which gets expensive across " +
      "an entire multi-country catalog.",
    inputSchema: z.object({
      category_code: z.string().optional(),
      shop_id: z.string().optional(),
      max_products_scanned: z.number().int().default(3000),
      name_similarity_threshold: z.number().default(0.92),
    }),
  },
  async ({ category_code, shop_id, max_products_scanned, name_similarity_threshold }) => {
    const { client } = await getCtx();
    const products: JsonRecord[] = [];
    for await (const p of client.iterAllProducts({ categoryCode: category_code, shopId: shop_id, cached: true })) {
      products.push(p);
      if (products.length >= max_products_scanned) break;
    }

    const clusters = heuristics.findDuplicateCandidates(products, { nameSimilarityThreshold: name_similarity_threshold });
    return jsonResult({
      scanned: products.length,
      clusters: clusters.map((c) => ({ reason: c.reason, suggested_canonical: c.suggestedCanonical, products: c.products })),
    });
  },
);

// ======================================================================
// 7. Orders
// ======================================================================

server.registerTool(
  "list_orders",
  {
    description:
      'One page of GET /orders. `status`/`country` accept comma-separated lists; omit `status` to get ' +
      'every status (there\'s no "ALL" value). Valid `country` codes: CI, DZ, EG, GH, KE, MA, NG, SN, TN, UG, ZA.',
    inputSchema: z.object({
      status: z.string().optional(),
      country: z.string().optional(),
      shop_id: z.string().optional(),
      created_after: z.string().optional(),
      created_before: z.string().optional(),
      size: z.number().int().optional(),
      token: z.string().optional(),
    }),
  },
  async ({ status, country, shop_id, created_after, created_before, size, token }) => {
    const { client } = await getCtx();
    return jsonResult(
      await client.getOrders({ status, country, shopId: shop_id, createdAfter: created_after, createdBefore: created_before, size, token }),
    );
  },
);

server.registerTool(
  "get_order_items",
  {
    description: "GET /orders/items for a specific order.",
    inputSchema: z.object({ order_id: z.string(), status: z.string().optional(), shop_id: z.string().optional() }),
  },
  async ({ order_id, status, shop_id }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getOrderItems(order_id, { status, shopId: shop_id }));
  },
);

server.registerTool(
  "cancel_order_items",
  {
    description:
      "Cancel one or more order items. Requires the VC - Order Manager role on the calling application/" +
      "user. No cancellation-reason field exists in this endpoint's schema - the audit log records who/" +
      "when this tool was called, but not a business reason, so capture that elsewhere if you need it " +
      "for SLA reporting.",
    inputSchema: z.object({ order_item_ids: z.array(z.string()) }),
  },
  async ({ order_item_ids }) => {
    const { client, audit } = await getCtx();
    await withAudit(client, audit, "cancel_order_items", { orderItemIds: order_item_ids }, () => client.cancelOrderItems(order_item_ids));
    return jsonResult({ cancelled: order_item_ids });
  },
);

// ======================================================================
// 8. Fulfillment / labels
// ======================================================================

server.registerTool(
  "get_shipment_providers",
  {
    description:
      "List shipment providers available for an order item, including whether each requires a caller-" +
      "supplied tracking code (use pack_orders_v2 if so).",
    inputSchema: z.object({ order_item_id: z.string() }),
  },
  async ({ order_item_id }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getShipmentProviders(order_item_id));
  },
);

server.registerTool(
  "pack_orders",
  {
    description:
      'Pack order items (v1). `order_items`: [{"id": "<orderItemId>", "shipmentProviderId": "..."}]. Use ' +
      "pack_orders_v2 instead for any provider where get_shipment_providers reports trackingCodeRequired=true.",
    inputSchema: z.object({ order_items: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ order_items }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "pack_orders", { count: order_items.length }, () => client.packOrders(order_items));
    return jsonResult(result);
  },
);

server.registerTool(
  "pack_orders_v2",
  {
    description:
      "Pack order items (v2) - required when the shipment provider needs a caller-supplied tracking " +
      'code. `packages`: [{"orderItems": [...], "shipmentProviderId": "...", "trackingCode": "..."}].',
    inputSchema: z.object({ packages: z.array(z.record(z.string(), z.unknown())) }),
  },
  async ({ packages }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "pack_orders_v2", { count: packages.length }, () => client.packOrdersV2(packages));
    return jsonResult(result);
  },
);

server.registerTool(
  "mark_ready_to_ship",
  {
    description: "Mark packed order items ready to ship.",
    inputSchema: z.object({ order_item_ids: z.array(z.string()) }),
  },
  async ({ order_item_ids }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "mark_ready_to_ship", { orderItemIds: order_item_ids }, () =>
      client.markReadyToShip(order_item_ids),
    );
    return jsonResult(result);
  },
);

server.registerTool(
  "print_shipping_labels",
  {
    description:
      "Get printable shipping labels for order items. Returns success.labels[] with a `label` field per " +
      "item - inspect a real response to confirm its exact shape (raw bytes/base64/URL) before building " +
      "anything that assumes one; the published schema doesn't say.",
    inputSchema: z.object({ order_item_ids: z.array(z.string()) }),
  },
  async ({ order_item_ids }) => {
    const { client, audit } = await getCtx();
    const result = await withAudit(client, audit, "print_shipping_labels", { orderItemIds: order_item_ids }, () =>
      client.printShippingLabels(order_item_ids),
    );
    return jsonResult(result);
  },
);

// ======================================================================
// Consignment (shipping YOUR inventory in to Jumia's warehouses) & Payments
// ======================================================================

server.registerTool(
  "create_consignment",
  {
    description:
      "Create a consignment (inbound stock shipment to a Jumia warehouse). `products`: [{\"sku\": \"...\", " +
      '"quantity": 10, "labelCode": "..."}]. `shipping_date` format is \'YYYY-MM-DD HH:mm:ss\' (not ISO-' +
      "8601, despite looking like it). Returns {purchaseOrderNumber}.",
    inputSchema: z.object({
      shop_id: z.string(),
      business_client_code: z.string(),
      shipping_date: z.string(),
      products: z.array(z.record(z.string(), z.unknown())),
      comment: z.string().optional(),
    }),
  },
  async ({ shop_id, business_client_code, shipping_date, products, comment }) => {
    const { client, audit } = await getCtx();
    const result = await client.createConsignment(shop_id, business_client_code, shipping_date, products, comment);
    await audit.record("create_consignment", { shopId: shop_id, count: products.length }, result, true);
    return jsonResult(result);
  },
);

server.registerTool(
  "update_consignment",
  {
    description: "Update a consignment's shipping status. Dates are 'yyyy-MM-dd'.",
    inputSchema: z.object({
      purchase_order_number: z.string(),
      is_shipped: z.boolean().optional(),
      tracking_number: z.string().optional(),
      actual_departure_date: z.string().optional(),
      estimated_arrival_date: z.string().optional(),
      delivery_agent_phone_number: z.string().optional(),
      name_of_3pl: z.string().optional(),
    }),
  },
  async ({
    purchase_order_number,
    is_shipped,
    tracking_number,
    actual_departure_date,
    estimated_arrival_date,
    delivery_agent_phone_number,
    name_of_3pl,
  }) => {
    const { client, audit } = await getCtx();
    await client.updateConsignment(purchase_order_number, {
      isShipped: is_shipped,
      trackingNumber: tracking_number,
      actualDepartureDate: actual_departure_date,
      estimatedArrivalDate: estimated_arrival_date,
      deliveryAgentPhoneNumber: delivery_agent_phone_number,
      nameOf3PL: name_of_3pl,
    });
    await audit.record("update_consignment", { purchaseOrderNumber: purchase_order_number }, "ok", true);
    return jsonResult({ purchaseOrderNumber: purchase_order_number, updated: true });
  },
);

server.registerTool(
  "get_consignment_stock",
  {
    description: "Check received/quarantined/defective/canceled/returned/failed counts for stock sent to a Jumia warehouse.",
    inputSchema: z.object({ business_client_code: z.string(), sku: z.string() }),
  },
  async ({ business_client_code, sku }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getConsignmentStock(business_client_code, sku));
  },
);

server.registerTool(
  "get_payout_statements",
  {
    description:
      "List payout statements (for reconciling what Jumia has paid out against your own books). NOT " +
      "financial/tax advice - just the raw statement data.",
    inputSchema: z.object({
      created_after: z.string().optional(),
      page: z.number().int().optional(),
      size: z.number().int().optional(),
      paid: z.boolean().optional(),
      country: z.string().optional(),
      currency: z.string().optional(),
    }),
  },
  async ({ created_after, page, size, paid, country, currency }) => {
    const { client } = await getCtx();
    return jsonResult(await client.getPayoutStatements({ createdAfter: created_after, page, size, paid, country, currency }));
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

// Only start the stdio transport when this file is run directly (`node
// src/server.ts`), never when it's just imported (e.g. by the smoke test)
// - the ESM equivalent of Python's `if __name__ == "__main__":` guard.
// Without this, importing the module for testing would open a real stdio
// listener and keep the process alive forever.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
