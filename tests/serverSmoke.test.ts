/**
 * Smoke test: the server module must import cleanly and register every
 * tool, without making any network calls or requiring real credentials
 * (the lazy getCtx() singleton in server.ts must not be touched just by
 * importing).
 *
 * Static ESM imports are hoisted above other top-level code, so setting
 * fake env vars before a static `import './server.ts'` would NOT guarantee
 * they're set before the module's own top-level code runs. This test uses
 * a dynamic `await import(...)` instead, after setting the env vars, to
 * preserve that ordering - the same thing test_server_smoke.py relies on
 * by setting os.environ before its (necessarily later-evaluated) import.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.JUMIA_CLIENT_ID ??= "test-client-id";
process.env.JUMIA_REFRESH_TOKEN ??= "test-refresh-token";

const serverModule = await import("../src/server.ts");

interface InternalRegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
interface InternalMcpServer {
  _registeredTools: Record<string, InternalRegisteredTool>;
}

test("all expected tools are registered", () => {
  const internal = serverModule.server as unknown as InternalMcpServer;
  const names = new Set(Object.keys(internal._registeredTools));
  const expected = [
    "list_shops",
    "list_brands",
    "list_categories",
    "get_attribute_set",
    "find_outdated_products",
    "deactivate_products",
    "create_products",
    "update_products",
    "update_price",
    "update_stock",
    "get_feed_status",
    "sync_products",
    "list_products",
    "get_stock",
    "find_duplicate_products",
    "find_variant_fragments",
    "merge_variant_fragments",
    "check_content_policy",
    "list_orders",
    "get_order_items",
    "cancel_order_items",
    "get_shipment_providers",
    "pack_orders",
    "pack_orders_v2",
    "mark_ready_to_ship",
    "print_shipping_labels",
    "create_consignment",
    "update_consignment",
    "get_consignment_stock",
    "get_payout_statements",
  ];
  const missing = expected.filter((name) => !names.has(name));
  assert.deepEqual(missing, [], `missing tools: ${missing.join(", ")}`);
});

test("deactivate_products rejects an entry missing business_client_codes", async () => {
  const internal = serverModule.server as unknown as InternalMcpServer;
  const handler = internal._registeredTools.deactivate_products.handler;
  await assert.rejects(
    () => handler({ products: [{ id: "p1", sellerSku: "sku1" }] }),
    (err: Error) => err.message.includes("business_client_codes"),
  );
});

test("create_products blocks locally on a known content-policy phrase, before any network call", async () => {
  const internal = serverModule.server as unknown as InternalMcpServer;
  const handler = internal._registeredTools.create_products.handler;
  await assert.rejects(
    () =>
      handler({
        shop_id: "shop1",
        products: [
          {
            sellerSku: "sku1",
            attributes: [{ name: "short_description", value: "Raised edges for camera and screen protection" }],
          },
        ],
      }),
    (err: Error) => err.message.includes("blacklist") && err.message.includes("sku1"),
  );
});
