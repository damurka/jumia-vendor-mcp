# jumia-vendor-mcp

An MCP server for Jumia's Vendor Center API (GPM catalog + GOP orders), built
against the OpenAPI spec published at
`https://vendorcenter.jumia.com/api-docs/openapi.yaml` (fetched 2026-09-05).
Implemented in TypeScript, run directly by Node (no build step).

It exposes the catalog/order operations as MCP tools so an MCP client (Claude
Desktop, Claude Code, Cursor, Windsurf, or any other MCP-compatible LLM tool)
can call them directly, plus a few heuristic "review list" tools
(`find_outdated_products`, `find_duplicate_products`, `find_variant_fragments`)
for things the API has no native concept of - read **[Limitations](#limitations-read-before-trusting-the-automation)**
before you rely on those.

## Contents

- [Quick start (Claude Code plugin)](#quick-start-claude-code-plugin)
- [Prerequisite](#prerequisite)
- [Installation](#installation)
  - [As a Claude Code plugin](#as-a-claude-code-plugin)
  - [As a standalone MCP server](#as-a-standalone-mcp-server)
- [Getting Vendor Center credentials](#getting-vendor-center-credentials)
- [Non-secret configuration](#non-secret-configuration)
- [Verifying it works](#verifying-it-works)
- [Tools](#tools)
- [Limitations](#limitations-read-before-trusting-the-automation)
- [Repo layout](#repo-layout)

## Quick start (Claude Code plugin)

```bash
claude plugin marketplace add damurka/jumia-vendor-mcp
claude plugin install jumia-vendor-mcp@jumia-vendor-mcp
```

Then, inside a Claude Code session, run the `/plugin configure jumia-vendor-mcp`
slash command and paste in a Client Id and Refresh Token - see
[Getting Vendor Center credentials](#getting-vendor-center-credentials) below
for where those come from. That's it; skip to [Tools](#tools) for what you
can do with it.

Not using Claude Code? See [As a standalone MCP server](#as-a-standalone-mcp-server).

## Prerequisite

**[Node.js >= 24](https://nodejs.org/) must be installed and on PATH.** Every
command in this doc runs through it (`node ...`), including the MCP server
itself when launched by a client - there is no separate build/compile step;
Node runs the `.ts` files directly via its native type-stripping support. If
Node is missing, the plugin's MCP connection simply fails to start - `claude
mcp list` will show it as not connected rather than hanging silently, which
is the first place to look if nothing seems to be working.

**If you installed this as a Claude Code plugin and don't know where its
files live on disk** (e.g. to run `npm install` below), run `claude mcp
list` - it prints the exact resolved directory each MCP server is running
from, regardless of how it was installed. For a plugin installed from a real
(non-local-path) marketplace, Claude Code also caches plugin files at a
predictable location: `~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/`.

## Installation

### As a Claude Code plugin

This repo is itself a Claude Code plugin - `.claude-plugin/plugin.json`
declares the `jumia-vendor-center` MCP server via `${CLAUDE_PLUGIN_ROOT}`, so
it works from wherever it's installed.

**Install straight from GitHub:**

```bash
claude plugin marketplace add damurka/jumia-vendor-mcp
claude plugin install jumia-vendor-mcp@jumia-vendor-mcp
```

**Or, if you've cloned it locally instead** (e.g. for development), point at
the directory:

```bash
claude plugin marketplace add /absolute/path/to/jumia-vendor-mcp
claude plugin install jumia-vendor-mcp@jumia-vendor-mcp
```

**Or, for one-off/dev use without installing anything:**

```bash
claude --plugin-dir /absolute/path/to/jumia-vendor-mcp
```

Any of the three still need `npm install` run once in the plugin's own
directory first - see the [Prerequisite](#prerequisite) section above if you
don't know where that directory is.

**Then configure credentials** - inside a Claude Code session, run:

```
/plugin configure jumia-vendor-mcp
```

and fill in the Client Id and Refresh Token fields it prompts for (get these
first from [Getting Vendor Center credentials](#getting-vendor-center-credentials)
below). This is a slash command run inside a chat session, not a `claude
plugin ...` shell subcommand - the CLI itself has no `configure` verb. It's
powered by `plugin.json`'s `userConfig` block, and the Refresh Token goes
into Claude Code's own secure credential storage, never a plaintext file in
this project.

The older `node src/setup.ts` path (see
[As a standalone MCP server](#as-a-standalone-mcp-server) below) still works
too, as an alternative to `/plugin configure` - it isn't tied to
`${CLAUDE_PLUGIN_ROOT}` at all, so running it once covers every install of
this plugin on that machine, regardless of where it's installed from.

### As a standalone MCP server

For Claude Desktop, Cursor, Windsurf, Cline, Zed, or any other
MCP-compatible client that isn't plugin-aware:

```bash
npm install
node src/setup.ts
```

`node src/setup.ts` prompts for a Client Id and a hidden Refresh Token (see
[Getting Vendor Center credentials](#getting-vendor-center-credentials)
below for where to get them), then validates them against the live API
immediately - the same pattern as Firebase CLI's `firebase login:ci`. It
stores them in `~/.config/jumia-vendor-mcp/credentials.json`, a per-user file
*outside* this project directory, never a project-local `.env`, so there's
nothing here that could ever be accidentally committed. Every person who
uses this server runs it once against their *own* Vendor Center account.

Then register the server directly as a stdio process (adjust the path to
wherever you cloned this repo):

```json
{
  "mcpServers": {
    "jumia-vendor-center": {
      "command": "node",
      "args": ["/absolute/path/to/jumia-vendor-mcp/src/server.ts"]
    }
  }
}
```

**Alternative to `node src/setup.ts`:** put `JUMIA_CLIENT_ID`/
`JUMIA_REFRESH_TOKEN` directly into that same JSON block's `env` object, if
the client supports one:

```json
{
  "mcpServers": {
    "jumia-vendor-center": {
      "command": "node",
      "args": ["/absolute/path/to/jumia-vendor-mcp/src/server.ts"],
      "env": {
        "JUMIA_CLIENT_ID": "your-client-id",
        "JUMIA_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

Only do this in a config file that isn't checked into version control -
unlike Claude Code's `userConfig`, this is a plaintext value sitting in a
JSON file, not secure storage.

## Getting Vendor Center credentials

Both installation paths above need the same two values from your own Vendor
Center account:

1. **Register a Self Authorization application**: Settings -> Applications
   -> Create Application -> Self Authorization. Unlike a Web Application,
   this needs no human present to log in - required for a server that runs
   unattended/on a schedule.
2. Use **Generate Token** on that application to get a Refresh Token.

There's no way to script either step - it's a manual, one-time action in
Vendor Center's UI, by design of their platform. Every person who uses this
server does this once, in their own account, exactly like `firebase login`
needs a real browser session once.

## Non-secret configuration

These are plain environment variables, not stored anywhere - set them if you
need to override a default (see `src/config.ts`'s module docstring for the
full picture). There is no `.env` file support at all; these must be real,
shell-exported environment variables (or, for a Claude Code plugin install,
values Claude Code passes through as env vars).

| Variable | Default | Purpose |
|---|---|---|
| `JUMIA_AUTH_BASE_URL` | `https://vendor-api.jumia.com` | OAuth token endpoint base |
| `JUMIA_API_BASE_URL` | `https://vendor-api.jumia.com` | Vendor Center API base |
| `JUMIA_SHOP_ID` | *(none)* | default `shopId` for tools that need one and aren't given one explicitly |
| `JUMIA_AUDIT_LOG` | `./data/audit.log` | path to the JSONL audit log of write actions |
| `JUMIA_RATE_LIMIT_RPM` | `200` | requests/minute cap, per Jumia's docs |
| `JUMIA_RATE_LIMIT_RPS` | `4` | requests/second cap, per Jumia's docs |
| `JUMIA_CLIENT_ID` / `JUMIA_REFRESH_TOKEN` | *(from stored credentials)* | override the stored Client Id/Refresh Token - useful for CI/automation, the same role `FIREBASE_TOKEN` plays for Firebase CLI |

## Verifying it works

Run the tests and typecheck:

```bash
npm test        # node --test, no separate test-framework install needed
npm run typecheck
```

Run the server directly to sanity-check it starts:

```bash
npm start   # or: node src/server.ts
```

It talks MCP over stdio and will just sit there waiting for a client - that's
expected; Ctrl-C to stop.

**After a `git pull` or any dependency change, run `npm install` again.**
Unlike a `uv`-managed Python project, Node doesn't auto-sync dependencies on
every launch - a stale `node_modules` fails loudly (module-not-found) rather
than self-healing.

## Tools

| Tool | Requirement it maps to |
|---|---|
| `find_outdated_products` | 1. find outdated products that need to be removed |
| `deactivate_products` | 2. remove outdated products *(see [Limitations](#limitations-read-before-trusting-the-automation) - this deactivates, doesn't delete; automatically zeroes stock first)* |
| `update_products`, `update_price`, `update_stock` | 3. update products |
| `create_products` | 4. create new products, including images and all documented fields |
| `sync_products` | 5. keep products up to date (diffs a desired state against live data, pushes only what changed) |
| `find_duplicate_products` | 6. merge products posted as different products *(see [Limitations](#limitations-read-before-trusting-the-automation) - reports candidates, doesn't merge)* |
| `find_variant_fragments`, `merge_variant_fragments` | 6b. the same real item posted as a separate product per color instead of one product with a color variation - detects candidate clusters, then builds (but does not submit) the consolidated create/deactivate payload |
| `check_content_policy` | pre-flight scan against phrases already confirmed to trip Jumia's word blacklist; `create_products`/`update_products` run this automatically and block on a match |
| `list_orders`, `get_order_items`, `cancel_order_items` | 7. manage orders |
| `print_shipping_labels`, `pack_orders`(`_v2`), `mark_ready_to_ship`, `get_shipment_providers` | 8. print labels / fulfillment |
| `list_shops`, `list_brands`, `list_categories`, `get_attribute_set`, `list_products`, `get_stock`, `get_feed_status`, `create_consignment`, `update_consignment`, `get_consignment_stock`, `get_payout_statements` | reference data, warehouse inbound stock, payouts, and polling async feed results |

Every write tool (create/update/deactivate/cancel/pack/etc) appends a line to
a local JSONL audit log (`JUMIA_AUDIT_LOG`, default `./data/audit.log`)
before returning - `{ts, action, request, result, ok, error}` per call. Given
how much of this is one-way (see below), that trail is worth keeping.

## Limitations (read before trusting the automation)

### Structural gaps in the API itself

**No delete, only deactivate.** The published API has no endpoint to delete
a product. `status` can only be set to `ACTIVE`/`INACTIVE` by a seller;
`DELETED` shows up as a *read-only* value on `list_products` - only Jumia's
own catalog ops can actually remove a listing. `deactivate_products` sets
`INACTIVE`; treat any request to "delete" or "remove" a product as a request
to deactivate it, and tell whoever's asking that a true delete needs a
request to Jumia (account manager / catalog support), not an API call.

**No merge.** There's no endpoint to merge two listings of the same real
product (which would need to consolidate reviews, ranking history, and
stock). `find_duplicate_products` only *detects* likely duplicates (GTIN
match, or brand+category+images+fuzzy-name match) and suggests which one to
keep - resolving it is still "review the list, then deactivate the ones
you're dropping," done by a person.

**Only the mutable fields are actually mutable.** Per the docs' own table:
`update_products` can change additional category, brand, config attributes,
GTIN barcode, simple attributes, and variation - it explicitly **cannot**
change the main image, main category, or parent SKU (and price/initial stock
go through the separate `update_price`/`update_stock` feeds, not this one).
If "keep products up to date" means fixing a wrong main image or category on
an existing listing, there's no API for that at all - it has to be
recreated, or handled by Jumia support.

**No cancellation-reason field.** `cancel_order_items`'s schema is just a
list of order item IDs - no reason code, no comment. If you need that for
SLA/audit reporting, capture it in your own system when you call the tool;
the audit log records who/when, not why.

**No product-level "last sold" query.** `get_sales_order_item` looks up one
specific order item by ID, not "when did this SKU last sell" - to build that
you'd page through `list_orders`/`get_order_items` yourself and join on SKU,
which is expensive across a large order history. Not wired into
`find_outdated_products` for that reason; if you need it, it's a natural
next heuristic to add once you've decided how far back "recent" means.

### Caveats specific to this project's own heuristics

**"Outdated" and "duplicate" are both heuristics we invented**, not Jumia
concepts - see `src/heuristics.ts`'s module docstring for exactly what
signals they use and why. Tune the grace-period parameters (or add your own
rule) to match your catalog; don't treat the default thresholds as
authoritative.

**`find_variant_fragments` is domain-informed, not universal.** It clusters
by (brand, model, case-type) extracted from the product name via patterns
seeded from a real catalog of ~700 phone-case listings - see
`heuristics.ts`'s `BRAND_PATTERNS`/`MODEL_PATTERNS`/`CASE_TYPE_PATTERNS` if
you need to extend it for another product category. Its `flags` on a cluster
(price outlier, bundle/different-material keywords, weight-unit anomaly) are
prompts to go read that listing's actual description, not proof of a real
problem - they fire on marketing copy too (e.g. "attaches to MagSafe
wallets" flags as a wallet-material mention). `merge_variant_fragments`
never calls `create_products`/`deactivate_products` itself - it only builds
the payload, so every write still goes through the normal, visible, audited
tool calls.

**`check_content_policy`'s blacklist is only what's failed live so far**,
not Jumia's actual (unpublished) word blacklist - currently just one
confirmed phrase ("screen protection"). A clean scan means "hasn't failed
this way before," not "guaranteed to pass" - `create_products`/
`update_products` still surface Jumia's real validation error for anything
not yet on the list.

### API behavior that disagrees with its own docs

Confirmed against a live account:

- `product.name` on `GET /catalog/products` is a plain string, not the
  documented `{"value": ...}` object - `src/heuristics.ts` matches the live
  shape.
- The create-product schema types `brand.code`/`category.code` as `number`,
  but the docs' own changelog says the live API actually returns/expects
  *strings* - confirmed live too.
- `create_products`' `parentSku` is documented as optional but is actually
  required - omitting it on a standalone product fails with "Required
  field [Product.ParentSKU] is missing or null." For a non-variant
  listing, just set it equal to `sellerSku`.
- `deactivate_products`/`update_stock`/`update_price` need the *variation*
  id (`variations[].id` from `GET /catalog/products`), not the top-level
  product-set `id` - passing the product-set id fails with "Product by
  Sid [...] not found." `find_outdated_products` rows already carry the
  right one as `variation_id`; a raw `list_products` read does not make
  this distinction obvious.
- `print_shipping_labels`'s `label` field has no documented shape (raw
  bytes? base64? a URL?) - inspect a real response before building anything
  downstream that assumes one.
- `GET /catalog/products?status=INACTIVE` hangs/times out server-side -
  confirmed with a raw `fetch` bypassing this project's own client entirely,
  so it's a live API issue, not a bug here. `status=ACTIVE` and an
  unfiltered list both work fine. Workaround: page through the full catalog
  with no status filter and check each variation's businessClient `status`
  client-side instead of asking the API to filter by INACTIVE for you.
- `GET /orders/items` returns a JSON **array** of `{orderId, orderNumber,
  items}` objects, not a bare object - easy to miss since a single-order
  query returns a one-element array that looks like it could be the object
  itself.

### Operational notes

**Rate limits are enforced per Mastershop** (200 requests/minute, capped at
4/second) - `src/http.ts`'s rate limiter paces every call against that, but
if you run multiple instances of this server against the same Mastershop
simultaneously, they don't share state and can collectively blow past it.

**Not covered at all**, because the published API doesn't expose it: returns
and refunds, reviews/ratings, competitor/buybox price monitoring, tax and
duties compliance, and content-score/SEO optimization of listings (there's a
[content guideline](https://guidescontentjumiang.wordpress.com/) worth
following manually when writing product copy, but nothing in the API scores
or validates it for you).

## Repo layout

```
src/
  util/mutex.ts      - promise-chaining async mutex (no built-in JS equivalent of asyncio.Lock)
  credentials.ts     - per-user credential file (Firebase-CLI style), outside the project
  setup.ts           - `node src/setup.ts`, the one-time interactive login (CLI path; `/plugin
                       configure jumia-vendor-mcp` is the other, via plugin.json's userConfig)
  config.ts          - env/config loading
  auth.ts            - OAuth2 refresh-token handling, with rotation persisted via credentials.ts
  http.ts            - rate limiting, retry/backoff, per-service error-shape normalization
  stringSimilarity.ts - a from-scratch, verified-against-Python port of difflib's ratio()
  client.ts          - one method per documented endpoint
  heuristics.ts      - "outdated" / "duplicate" / "variant fragment" detection + merge-payload
                       building + content-policy scanning (pure, unit-tested)
  audit.ts           - append-only JSONL write-action log
  server.ts          - the actual MCP tool definitions
tests/
  heuristics.test.ts    - heuristics, no network
  client.test.ts        - client.ts against a fake HTTP layer (checks paths/payloads)
  configAndAuth.test.ts - credential file precedence + rotation persistence, no real file/network
  serverSmoke.test.ts   - server imports cleanly, every tool registers
```

Run with `node` directly (Node >= 24's native TypeScript type-stripping) -
no `dist/`, no `tsc` build step. `npm run typecheck` (a `tsc --noEmit` pass)
is separate and only checks types; it doesn't produce runnable output.
