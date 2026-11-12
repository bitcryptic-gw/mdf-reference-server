/**
 * 402 response body schema regression test
 *
 * The drift that produced the original 402 rewrite — a schema and a server
 * disagreeing about the wire format, found only by a manual curl — is what this
 * test catches cheaply and offline.
 *
 * Since 0.3.0 the schema is **vendored** rather than fetched from spec `main`
 * at test time. Fetching was a defect in its own right: the test validated
 * tomorrow's schema against today's server, so it went red the moment the spec
 * repo moved on (the two known failures carried through Stage B's start). A
 * vendored copy is pinned to a commit and a hash, so a schema change is a
 * deliberate, reviewable edit.
 *
 *   source: bitcryptic-gw/mdf, tag v0.3.1 = 31cd49c3e39b6c902fe5b5061c6ba3d89b5f8ea9
 *   path:   mdf-402.schema.json
 *   sha256: b3b9f1ef5a5e62afa8b2fdbdbe30a2e25517e8fa2c2718ef1ad1f9f2edf19b5b
 *
 * The hash assertion below fails if the vendored file is edited without
 * updating this comment — the only way the pin can rot silently.
 *
 * Run with: bun run src/payment/402-schema.test.ts
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildOfferFor } from "./payment.ts";
import { render402, MDF_INFO_SCHEMA } from "./402.ts";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Vendored schema
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(import.meta.dir, "schemas", "mdf-402.schema.json");
const SCHEMA_SHA256 = "b3b9f1ef5a5e62afa8b2fdbdbe30a2e25517e8fa2c2718ef1ad1f9f2edf19b5b";
const SCHEMA_SOURCE = "bitcryptic-gw/mdf@v0.3.1 (31cd49c3e39b6c902fe5b5061c6ba3d89b5f8ea9)";

const schemaText = readFileSync(SCHEMA_PATH, "utf8");
const schema = JSON.parse(schemaText) as object;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const infoValidate = ajv.compile(MDF_INFO_SCHEMA);

function assertValid(body: unknown): void {
  if (!validate(body)) {
    throw new Error(`schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const NODE = "02" + "ab".repeat(32);

const rail = (amount: string, network = "eip155:8453", asset = USDC) => ({
  scheme: "exact",
  network,
  asset,
  amount,
});

function makeLoaded(options: { dual?: boolean } = {}): LoadedConfig {
  const sections: Record<string, unknown> = {
    "/testnet/**": { rails: [rail("1000", "eip155:84532", USDC_SEPOLIA)] },
  };
  if (options.dual) {
    sections["/showcase/**"] = { rails: [rail("20000"), rail("20000", LNBTC, "BTC")] };
  }
  return {
    contentDir: join(import.meta.dir, "..", "..", "content"),
    walletAddress: WALLET,
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "MDF Demo Site" },
      content: {
        dir: join(import.meta.dir, "..", "..", "content"),
        dialect: "commonmark",
        frontmatter: true,
        math: false,
      },
      pricing: {
        default: { rails: [rail("100")] },
        sections,
      },
      token_store: "memory",
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      payment: { max_timeout_seconds: 300 },
      server: { trusted_proxies: [] },
    } as unknown as LoadedConfig["config"],
    tokenStore: { put: async () => true, get: async () => null, delete: async () => {}, close: () => {} },
    tokenStoreBackend: "memory",
    facilitator: null,
    pool: null,
    replayStore: null,
    lnbtc: options.dual
      ? ({
          enabled: true,
          network: LNBTC,
          payeePubkey: NODE,
          client: {
            makeInvoice: async () => ({ invoice: "lnbc200n1p3minted", paymentHash: "aa".repeat(32) }),
          },
          gate: {
            canOffer: () => true,
            enabled: true,
            applyCheck: () => true,
            snapshot: () => ({ status: "available" }),
          },
          limiter: { tryTake: () => ({ ok: true }) },
          replay: { claim: async () => "claimed", health: async () => "ok", close: () => {} },
          invoiceExpirySeconds: 300,
          breaker: { initialBackoffMs: 5000, maxBackoffMs: 300000 },
        } as unknown)
      : null,
    valkey: null,
  } as LoadedConfig;
}

/** The rendered 402 for a path. */
async function body402(
  loaded: LoadedConfig,
  urlPath: string,
  resourceUrl = `https://example.com${urlPath}`
): Promise<{ body: string; header: string; doc: Record<string, unknown> }> {
  const { doc } = await buildOfferFor(
    loaded,
    {
      urlPath,
      resourceUrl,
      method: "GET",
      headers: { accept: "text/markdown" },
      clientKey: "203.0.113.9",
    },
    { startedAtMs: Date.now() }
  );
  const rendered = render402(doc);
  return { body: rendered.body, header: rendered.headers["PAYMENT-REQUIRED"], doc: doc as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("mdf-server 402 body schema regression test (vendored 0.3.1)");
console.log("----------------------------------------------------------------");

await test(`the vendored schema is ${SCHEMA_SOURCE} and is unmodified`, () => {
  const actual = createHash("sha256").update(schemaText).digest("hex");
  assertEquals(actual, SCHEMA_SHA256, "vendored schema hash");
});

await test("an eip155 402 body validates, with the query string echoed verbatim", async () => {
  const resourceUrl = "https://example.com/testnet/intro?ref=gateway&tab=2";
  const { doc } = await body402(makeLoaded(), "/testnet/intro", resourceUrl);
  assertEquals((doc.resource as { url: string }).url, resourceUrl, "resource URL unchanged");
  assertValid(doc);
});

await test("a dual-rail 402 body validates against the vendored schema", async () => {
  const { doc } = await body402(makeLoaded({ dual: true }), "/showcase/dual-rail");
  const accepts = doc.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 2, "both rails");
  assertValid(doc);
});

await test("a single-rail 402 (one rail omitted) still validates", async () => {
  // The fixture for this case has no lnbtc runtime, so the dual entry's lnbtc
  // rail is omitted — the spec's allowed divergence.
  const { doc } = await body402(makeLoaded(), "/showcase/dual-rail");
  const accepts = doc.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 1, "one rail survives");
  assertValid(doc);
});

await test("extensions.mdf.info validates against the embedded schema", async () => {
  const { doc } = await body402(makeLoaded({ dual: true }), "/showcase/dual-rail");
  const info = ((doc.extensions as { mdf: { info: unknown } }).mdf).info;
  if (!infoValidate(info)) {
    throw new Error(`mdf info schema failed: ${JSON.stringify(infoValidate.errors)}`);
  }
});

await test("price_summary states the raw amount of every offered rail", async () => {
  const { doc } = await body402(makeLoaded({ dual: true }), "/showcase/dual-rail");
  const info = ((doc.extensions as { mdf: { info: { price_summary: string } } }).mdf).info;
  assert(info.price_summary.includes("20000"), "the 20000 of both rails appears");
  assert(info.price_summary.includes("eip155:8453"), "the eip155 rail is named");
  assert(info.price_summary.includes(LNBTC), "the lnbtc rail is named");
});

await test("the body bytes and the PAYMENT-REQUIRED header are identical", async () => {
  const { body, header } = await body402(makeLoaded(), "/testnet/intro");
  assertEquals(Buffer.from(header, "base64").toString("utf8"), body, "one object, two encodings");
});

await test("a v1-shaped body is rejected by the schema (the pin has teeth)", async () => {
  const v1 = {
    error: "payment_required",
    reason: "payment required: 1.0000 USDC",
    resource: "https://example.com/premium/deep-dive",
    payment: { rail: "x402", amount: "1.0000", currency: "USDC", chain: "base" },
  };
  assert(!validate(v1), "the schema must refuse the old envelope");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("----------------------------------------------------------------");
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
