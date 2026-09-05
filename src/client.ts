/**
 * Typed-ish wrapper around every Vendor Center GPM/GOP endpoint used by this
 * server. Each method maps 1:1 to one documented operation; the comment
 * notes anything from the published spec worth knowing at the call site
 * (what's paginated, what's actually mutable, what's a heuristic on our side
 * because the API has no native concept for it).
 *
 * Endpoint paths below were read directly out of the published OpenAPI
 * fragments (https://vendorcenter.jumia.com/api-docs/openapi.yaml and the
 * paths/*.yaml files it references) on 2026-09-05, not guessed from the
 * rendered docs page. Field names/enums come from the same source. Two
 * things the docs explicitly warn are unreliable, so treat them as such:
 *
 *   - brand.code / category.code are documented here as `number` but the
 *     docs' own version-control changelog says the live API actually
 *     returns/expects them as *strings*. Verify against a real response
 *     before trusting either.
 *   - Error response shapes differ by sub-service (see http.ts's normalizeError).
 */
import type { CatalogCache } from "./catalogCache.ts";
import type { JsonRecord } from "./heuristics.ts";
import type { VendorApiHttp } from "./http.ts";

/** Drop undefined-valued keys so we don't send empty query params / JSON fields. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export class VendorApiClient {
  private readonly http: VendorApiHttp;
  private readonly cache: CatalogCache | undefined;

  constructor(http: VendorApiHttp, cache?: CatalogCache) {
    this.http = http;
    this.cache = cache;
  }

  /**
   * Drop every cached catalog scan. Call this after any write action
   * (create/update/price/stock/status) - a scan served from cache
   * immediately after a write would show pre-write state.
   */
  invalidateCache(): void {
    this.cache?.invalidateAll();
  }

  // ------------------------------------------------------------------
  // Shops
  // ------------------------------------------------------------------

  /** GET /shops - all shops under the authenticated user. Not paginated. */
  async getShops(): Promise<JsonRecord[]> {
    const resp = await this.http.request("GET", "/shops");
    return resp.json();
  }

  /** GET /shops-of-master-shop. Not paginated. */
  async getShopsOfMasterShop(): Promise<JsonRecord[]> {
    const resp = await this.http.request("GET", "/shops-of-master-shop");
    return resp.json();
  }

  // ------------------------------------------------------------------
  // Catalog (read side)
  // ------------------------------------------------------------------

  /** GET /catalog/brands -> {brands: [{code, name}], page: {current, totalOfPages}}. */
  async getBrands(page?: number): Promise<JsonRecord> {
    const resp = await this.http.request("GET", "/catalog/brands", { params: clean({ page }) });
    return resp.json();
  }

  /**
   * GET /catalog/categories ->
   * {categories: [{code, name, completePath, hasChildren, attributeSet: {sid, name}}],
   *  page: {current, totalOfPages}}
   *
   * `attributeSet.sid` is what you pass to getAttributes().
   */
  async getCategories(options: { page?: number; size?: number; attributeSetName?: string } = {}): Promise<JsonRecord> {
    const params = clean({ page: options.page, size: options.size, attributeSetName: options.attributeSetName });
    const resp = await this.http.request("GET", "/catalog/categories", { params });
    return resp.json();
  }

  /**
   * GET /catalog/attribute-sets/{id} -> {attributes: [...]}
   *
   * Each attribute has: sid, code, name, description, type (numeric enum),
   * mandatory, variation, translatable, translations[], options[] (each with
   * id, sid, name, position, isDefault, status, translations[]), and
   * validations {dateFormat, decimalPlaces, maxLength, minLength, percentage,
   * notZeroOrNegative, selectedByDefault} - only the rules relevant to the
   * attribute's type are populated.
   */
  async getAttributes(attributeSetId: string): Promise<JsonRecord> {
    const resp = await this.http.request("GET", `/catalog/attribute-sets/${attributeSetId}`);
    return resp.json();
  }

  /**
   * GET /catalog/products. Paginated by opaque `token` (pass the value the
   * previous page returned to get the next one; omit for the first page).
   * `size` is 1-100.
   */
  async getProducts(
    options: {
      token?: string;
      size?: number;
      sids?: string[];
      categoryCode?: string;
      createdAtFrom?: string;
      createdAtTo?: string;
      sellerSku?: string;
      shopId?: string;
      status?: string; // ACTIVE | INACTIVE | DELETED
      qcStatus?: string; // NOT_READY_TO_QC | PENDING | APPROVED | REJECTED
      visible?: boolean;
      latestFirst?: boolean;
    } = {},
  ): Promise<JsonRecord> {
    const params = clean({
      token: options.token,
      size: options.size ?? 10,
      sids: options.sids,
      categoryCode: options.categoryCode,
      createdAtFrom: options.createdAtFrom,
      createdAtTo: options.createdAtTo,
      sellerSku: options.sellerSku,
      shopId: options.shopId,
      status: options.status,
      qcStatus: options.qcStatus,
      visible: options.visible,
      latestFirst: options.latestFirst,
    });
    const resp = await this.http.request("GET", "/catalog/products", { params });
    return resp.json();
  }

  /**
   * Convenience async generator that pages through getProducts for you.
   *
   * Pass `cached: true` to serve/populate a short-lived cache of the full
   * result set for this exact filter combination (see catalogCache.ts) -
   * useful for repeated full-catalog scans (find_outdated_products,
   * find_duplicate_products, ad-hoc analysis) within one work session.
   * Off by default; callers that need the live catalog every time are
   * unaffected.
   */
  async *iterAllProducts(
    options: Parameters<VendorApiClient["getProducts"]>[0] & { pageSize?: number; cached?: boolean } = {},
  ): AsyncGenerator<JsonRecord> {
    const { pageSize, cached, ...filters } = options;
    const cacheKey = JSON.stringify(filters);

    if (cached && this.cache) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        for (const item of hit) yield item;
        return;
      }
    }

    const collected: JsonRecord[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await this.getProducts({ ...filters, token, size: pageSize ?? 100 });
      const items: JsonRecord[] = page.products ?? page.items ?? [];
      for (const item of items) {
        if (cached) collected.push(item);
        yield item;
      }
      token = page.nextToken ?? page.token ?? undefined;
      if (!token || page.isLastPage) break;
    }

    if (cached && this.cache) {
      this.cache.set(cacheKey, collected);
    }
  }

  /**
   * GET /catalog/stock -> {products: [{id, sellerSku, globalStock,
   * lastStockUpdatedAt}], nextToken, isLastPage}. Paginated the same way as
   * getProducts (note the field really is `globalStock`, not `stock` - easy
   * to get wrong copying from the price/stock *update* feed schemas, which
   * do use `stock`).
   */
  async getStock(options: { token?: string; size?: number; productSids?: string[] } = {}): Promise<JsonRecord> {
    const params = clean({ token: options.token, size: options.size ?? 10, productSids: options.productSids });
    const resp = await this.http.request("GET", "/catalog/stock", { params });
    return resp.json();
  }

  /**
   * GET /catalog/stock/salesorderitem/{orderItemSid}?status=...
   * -> {orderNumber, status, orderItemSid, productSid}. `status` is required
   * by the spec even though it reads like a filter; pass the status you're
   * checking for (e.g. the value you expect this item to currently have).
   */
  async getSalesOrderItem(orderItemSid: string, status: string): Promise<JsonRecord> {
    const resp = await this.http.request("GET", `/catalog/stock/salesorderitem/${orderItemSid}`, { params: { status } });
    return resp.json();
  }

  // ------------------------------------------------------------------
  // Feeds (async write operations + their status)
  // ------------------------------------------------------------------

  /**
   * GET /feeds/{id} -> feed status + per-item results.
   *
   * Feed status is one of: FAILED, COMPLETED, IN_PROGRESS, PENDING. Feed
   * type is one of: PRODUCT_CREATION, PRODUCT_UPDATE, PRODUCT_STATUS_UPDATE,
   * STOCK_UPDATE, PRICE_UPDATE, PRODUCT_SET_QC_STATUS_UPDATE.
   *
   * IMPORTANT: for a PRODUCT_CREATION feed, `productSid` is only populated
   * here, never in the original create call. You must fetch the feed (or
   * look the SKU up via getProducts) before you can send any stock/price/
   * status update for a just-created product - and you can only update
   * products whose QC status has reached APPROVED at least once.
   */
  async getFeed(feedId: string): Promise<JsonRecord> {
    const resp = await this.http.request("GET", `/feeds/${feedId}`);
    return resp.json();
  }

  /**
   * POST /feeds/products/create -> {feedId}
   *
   * `products[]` items (per the published schema): name {value,
   * translations[]}, description {value, translations[]}, parentSku,
   * sellerSku (required), variation, brand {code, name}, category {code,
   * name}, images [{url, primary}] (at least one primary image required;
   * every product sharing a parentSku must pass the same image set), price
   * {currency, value, salePrice {value, startAt, endAt}}, stock, attributes
   * [{name, value, translations[]}], businessClients [{businessClientCode,
   * price {...}}].
   *
   * NOTE (confirmed live, disagrees with the published schema which marks
   * this optional): `parentSku` is REQUIRED even for a standalone product
   * with no variants - omitting it fails with "Required field
   * [Product.ParentSKU] is missing or null." For a single listing with no
   * size/color variants, just set it equal to sellerSku.
   *
   * Read the general content guideline before creating products - QC
   * rejects listings that don't meet it, and a rejected product can't
   * receive stock/price/status updates until it's fixed and re-approved.
   * Before calling this for a real-world branded product, SEARCH for the
   * manufacturer's actual spec sheet, description copy, and product image
   * URLs rather than inventing content - a fabricated spec risks a QC
   * rejection or a listing that doesn't match what ships.
   *
   * Cap at ~1000 products per call (documented payload-size guidance).
   */
  async createProducts(shopId: string, products: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/feeds/products/create", { jsonBody: { shopId, products } });
    return resp.json();
  }

  /**
   * POST /feeds/products/update -> {feedId}
   *
   * Per the docs' own "what's actually updatable" table, this feed can
   * change: additional category, brand, config attributes, GTIN barcode,
   * simple attributes, variation. It CANNOT change: main image, main
   * category, parent SKU, global/sale price, or initial stock - those go
   * through updatePrice / updateStock, or aren't changeable via API at all
   * (main image, main category, parent SKU). Each item needs `id`
   * (productSid, from getFeed/getProducts) or the identifying fields the
   * schema requires.
   */
  async updateProducts(products: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/feeds/products/update", { jsonBody: { products } });
    return resp.json();
  }

  /**
   * POST /feeds/products/stock -> {feedId}
   * products[]: {sellerSku, id (productSid), stock}
   */
  async updateStock(products: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/feeds/products/stock", { jsonBody: { products } });
    return resp.json();
  }

  /**
   * POST /feeds/products/price -> {feedId}
   * products[]: {sellerSku, id, category, price {currency, value, salePrice
   * {value, startAt, endAt}}, businessClients[]}. To clear a sale price,
   * send salePrice.value/startAt/endAt as null rather than omitting
   * salePrice. Global price overrides local/business-client prices when
   * those aren't present in the payload.
   */
  async updatePrice(products: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/feeds/products/price", { jsonBody: { products } });
    return resp.json();
  }

  /**
   * POST /feeds/products/status -> {feedId}
   * products[]: {id (productSid, required), sellerSku (required),
   * businessClients: [{businessClientCode, status}] (required)}.
   *
   * Only ACTIVE / INACTIVE are ever sent through this feed in the published
   * examples. There is NO documented way for a seller to set a product to
   * DELETED (that status shows up as a *read-only* value on getProducts,
   * i.e. Jumia's own catalog ops can hard-remove a listing, but the seller
   * API's idea of "removing" a product is setting it INACTIVE per business
   * client, not deleting it). Treat anything calling itself
   * "deleteProduct" in this server as an alias for "deactivate" - see the
   * README for why.
   *
   * IMPORTANT (confirmed live): the `id` here must be the *variation* id
   * (from `variations[].id` on a getProducts response), NOT the top-level
   * product-set `id` - passing the product-set id fails with "Product by
   * Sid [...] not found." This bit us in production; see the README.
   */
  async updateStatus(products: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/feeds/products/status", { jsonBody: { products } });
    return resp.json();
  }

  // ------------------------------------------------------------------
  // Consignment (shipping inventory in to Jumia's warehouses)
  // ------------------------------------------------------------------

  /**
   * POST /consignment-order -> {purchaseOrderNumber}
   * products[]: {sku, quantity, labelCode}. `shippingDate` format is
   * 'YYYY-MM-DD HH:mm:ss' (documented as a date-time but not ISO-8601).
   */
  async createConsignment(
    shopId: string,
    businessClientCode: string,
    shippingDate: string,
    products: JsonRecord[],
    comment?: string,
  ): Promise<JsonRecord> {
    const body = clean({
      shopId,
      businessClientCode,
      shippingDate,
      comment,
      products,
    });
    const resp = await this.http.request("POST", "/consignment-order", { jsonBody: body });
    return resp.json();
  }

  /**
   * PATCH /consignment-order/{purchaseOrderNumber}. Field is `nameOf3PL`
   * (not `3plName` - the docs previously said the latter but the API
   * silently discards it and only reads `nameOf3PL`).
   */
  async updateConsignment(
    purchaseOrderNumber: string,
    options: {
      isShipped?: boolean;
      trackingNumber?: string;
      actualDepartureDate?: string; // yyyy-MM-dd
      estimatedArrivalDate?: string; // yyyy-MM-dd
      deliveryAgentPhoneNumber?: string;
      nameOf3PL?: string;
    } = {},
  ): Promise<void> {
    const body = clean({
      isShipped: options.isShipped,
      trackingNumber: options.trackingNumber,
      actualDepartureDate: options.actualDepartureDate,
      estimatedArrivalDate: options.estimatedArrivalDate,
      deliveryAgentPhoneNumber: options.deliveryAgentPhoneNumber,
      nameOf3PL: options.nameOf3PL,
    });
    await this.http.request("PATCH", `/consignment-order/${purchaseOrderNumber}`, { jsonBody: body });
  }

  /**
   * GET /consignment-stock?businessClientCode=...&sku=...
   * -> {simpleSku, received, quarantined, defective, canceled, returned, failed}
   */
  async getConsignmentStock(businessClientCode: string, sku: string): Promise<JsonRecord> {
    const resp = await this.http.request("GET", "/consignment-stock", { params: { businessClientCode, sku } });
    return resp.json();
  }

  // ------------------------------------------------------------------
  // Payments
  // ------------------------------------------------------------------

  /** GET /payout-statement -> {statements: [...], page: {current, totalOfPages}}. */
  async getPayoutStatements(
    options: { createdAfter?: string; page?: number; size?: number; paid?: boolean; country?: string; currency?: string } = {},
  ): Promise<JsonRecord> {
    const params = clean({
      createdAfter: options.createdAfter,
      page: options.page,
      size: options.size,
      paid: options.paid,
      country: options.country,
      currency: options.currency,
    });
    const resp = await this.http.request("GET", "/payout-statement", { params });
    return resp.json();
  }

  // ------------------------------------------------------------------
  // Orders (GOP)
  // ------------------------------------------------------------------

  /**
   * GET /orders. `status`/`country` accept comma-separated lists. There is
   * no "ALL" status value - omit `status` to get every status. Valid
   * `country` values: CI, DZ, EG, GH, KE, MA, NG, SN, TN, UG, ZA. Paginated
   * by `token`/`nextToken`, with `isLastPage`.
   */
  async getOrders(
    options: {
      status?: string;
      country?: string;
      shopId?: string;
      createdAfter?: string;
      createdBefore?: string;
      updatedAfter?: string;
      updatedBefore?: string;
      size?: number;
      sort?: string;
      token?: string;
    } = {},
  ): Promise<JsonRecord> {
    const params = clean({
      status: options.status,
      country: options.country,
      shopId: options.shopId,
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      updatedAfter: options.updatedAfter,
      updatedBefore: options.updatedBefore,
      size: options.size,
      sort: options.sort,
      token: options.token,
    });
    const resp = await this.http.request("GET", "/orders", { params });
    return resp.json();
  }

  async *iterAllOrders(options: Parameters<VendorApiClient["getOrders"]>[0] = {}): AsyncGenerator<JsonRecord> {
    let token: string | undefined;
    for (;;) {
      const page = await this.getOrders({ ...options, token });
      for (const item of page.orders ?? []) yield item;
      token = page.nextToken ?? undefined;
      if (!token || page.isLastPage) break;
    }
  }

  /** GET /orders/items?orderId=...&status=...&shopId=... */
  async getOrderItems(orderId: string, options: { status?: string; shopId?: string } = {}): Promise<JsonRecord> {
    const params = clean({ orderId, status: options.status, shopId: options.shopId });
    const resp = await this.http.request("GET", "/orders/items", { params });
    return resp.json();
  }

  /**
   * PUT /orders/cancel. Requires the VC - Order Manager role. No
   * cancellation-reason field is exposed by this endpoint's schema - if you
   * need reason codes recorded for SLA/audit purposes, capture them
   * yourself (the audit log this server writes does).
   */
  async cancelOrderItems(orderItemIds: string[]): Promise<void> {
    await this.http.request("PUT", "/orders/cancel", { jsonBody: { orderItemIds } });
  }

  /** GET /orders/shipment-providers?orderItemId=... -> providers incl. trackingCodeRequired flag. */
  async getShipmentProviders(orderItemId: string): Promise<JsonRecord> {
    const resp = await this.http.request("GET", "/orders/shipment-providers", { params: { orderItemId } });
    return resp.json();
  }

  /**
   * POST /orders/pack (v1). orderItems[]: {id, shipmentProviderId}. Response
   * carries a `trackingNumber` per package. Superseded for providers that
   * require a caller-supplied tracking code by packOrdersV2 below.
   */
  async packOrders(orderItems: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/orders/pack", { jsonBody: { orderItems } });
    return resp.json();
  }

  /**
   * POST /v2/orders/pack. packages[]: {orderItems, shipmentProviderId,
   * trackingCode}. Use this version (not v1) when getShipmentProviders says
   * trackingCodeRequired=true. Response carries `trackingCode` per package
   * (not `trackingNumber`).
   */
  async packOrdersV2(packages: JsonRecord[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/v2/orders/pack", { jsonBody: { packages } });
    return resp.json();
  }

  /** POST /orders/ready-to-ship. Response: success.packages[]. */
  async markReadyToShip(orderItemIds: string[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/orders/ready-to-ship", { jsonBody: { orderItemIds } });
    return resp.json();
  }

  /**
   * POST /orders/print-labels -> success.labels[]: {orderItemIds,
   * countryCode, trackingNumber, label}. `label` is presumably the printable
   * label payload (e.g. base64/PDF or a URL) - shape wasn't spelled out
   * further in the published schema; inspect a real response before
   * assuming which.
   */
  async printShippingLabels(orderItemIds: string[]): Promise<JsonRecord> {
    const resp = await this.http.request("POST", "/orders/print-labels", { jsonBody: { orderItemIds } });
    return resp.json();
  }
}
