/**
 * 402 response body schema regression test
 *
 * The drift that produced the 402 schema rewrite — a schema and a server
 * disagreeing about the wire format, found only by a manual curl — is what
 * this test catches cheaply.
 *
 * It builds a 402 through the real build402Response path and validates the
 * body against mdf-402.schema.json from the spec repo (fetched at test time,
 * never hand-copied, so the expectation cannot drift independently of the
 * schema).
 *
 * Run with: bun run src/payment/402-schema.test.ts
 */

import { build402Response } from "./payment.ts";
import type { VerificationResult } from "./payment.ts";
import type { LoadedConfig } from "../config/loader.ts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// The canonical schema lives in the spec repo, on main.
const SCHEMA_URL =
  "https://raw.githubusercontent.com/bitcryptic-gw/mdf/main/mdf-402.schema.json";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name: string, reason: string) {
  console.log(`  - ${name} (SKIPPED: ${reason})`);
  skipped++;
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
// Schema fetch (test-time, never vendored)
// ---------------------------------------------------------------------------

async function fetchSchema(): Promise<unknown | null> {
  try {
    const res = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`  [402-schema] schema fetch failed: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(
      `  [402-schema] schema fetch failed (offline?): ${(err as Error).message}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLoaded(chain: "base" | "lightning"): LoadedConfig {
  const isLn = chain === "lightning";
  return {
    contentDir: "/nonexistent-in-test",
    walletAddress: "0xDEAD",
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: "/nonexistent-in-test", dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: {
          "/premium/**": isLn
            ? { amount: "0.00000001", currency: "BTC", chain: "lightning" }
            : { amount: "1.0000", currency: "USDC", chain: "base" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base", "ethereum", "lightning"],
        accepted_currencies: ["USDC", "USDT", "BTC"],
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
    } as LoadedConfig["config"],
  };
}

function noProofResult(reason: string): VerificationResult {
  return {
    status: "no_proof",
    proof: null,
    l402Credential: null,
    reason,
    requiresToken: false,
    rail: "none",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("mdf-server 402 body schema regression test");
  console.log("-------------------------------------------");

  const schema = await fetchSchema();
  const validate = (body: unknown): boolean => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const compiled = ajv.compile(schema as object);
    const ok = compiled(body);
    if (!ok) {
      console.warn(
        `  [402-schema] validation errors: ${JSON.stringify(compiled.errors)}`
      );
    }
    return ok;
  };

  if (!schema) {
    // A network outage must not read as a schema violation: skip, don't fail.
    skip("x402 body schema validation", "mdf-402.schema.json unreachable (offline?)");
    skip("lightning body schema validation", "mdf-402.schema.json unreachable (offline?)");
    printSummary();
    return;
  }

  // -------------------------------------------------------------------------
  // x402 path (base chain)
  // -------------------------------------------------------------------------
  await test("x402 body: resource, expires_at and rail emitted and schema-valid", async () => {
    const loaded = makeLoaded("base");
    const result = noProofResult("payment required: 1.0000 USDC");
    const resourceUrl = "https://example.com/premium/deep-dive?ref=gateway&tab=2";

    const res = await build402Response("/premium/deep-dive", result, loaded, resourceUrl);
    assertEquals(res.status, 402, "status should be 402");

    const body = JSON.parse(res.body);

    // rail derived from verifier selection for base
    assertEquals(body.payment.rail, "x402", "base chain should map to x402 rail");
    assertEquals(body.resource, resourceUrl, "resource should echo the requested URL verbatim");
    assertEquals(body.payment.chain, "base", "chain should be base");
    assertEquals(body.payment.amount, "1.0000", "amount should be unchanged");
    assertEquals(body.payment.currency, "USDC", "currency should be unchanged");

    // expires_at derived from the same window as session_nonce
    assert(
      typeof body.payment.session_nonce === "string" && body.payment.session_nonce.length > 0,
      "x402 offer should carry a session_nonce"
    );
    assert(
      typeof body.payment.expires_at === "string" &&
        !isNaN(Date.parse(body.payment.expires_at)) &&
        new Date(body.payment.expires_at) > new Date(),
      "expires_at should be an RFC 3339 timestamp in the future"
    );

    assert(validate(body), "x402 402 body should validate against mdf-402.schema.json");
  });

  // -------------------------------------------------------------------------
  // Lightning path
  // -------------------------------------------------------------------------
  await test("lightning body: rail l402 and schema-valid", async () => {
    const loaded = makeLoaded("lightning");
    const result = noProofResult("payment required: 0.00000001 BTC");
    const resourceUrl = "https://example.com/premium/deep-dive";

    const res = await build402Response("/premium/deep-dive", result, loaded, resourceUrl);
    assertEquals(res.status, 402, "status should be 402");

    const body = JSON.parse(res.body);

    // rail derived from verifier selection for lightning
    assertEquals(body.payment.rail, "l402", "lightning chain should map to l402 rail");
    assertEquals(body.payment.chain, "lightning", "chain should be lightning");
    assertEquals(body.payment.amount, "0.00000001", "amount should be unchanged");
    assertEquals(body.resource, resourceUrl, "resource should echo the requested URL");

    // No session_nonce on a lightning offer, so no expires_at either
    assert(body.payment.session_nonce === undefined, "lightning offers carry no session_nonce");
    assert(body.payment.expires_at === undefined, "lightning offers carry no expires_at");

    assert(validate(body), "lightning 402 body should validate against mdf-402.schema.json");
  });

  printSummary();
}

function printSummary(): void {
  console.log("-------------------------------------------");
  console.log(`passed: ${passed}, failed: ${failed}, skipped: ${skipped}`);
  if (failed > 0) process.exit(1);
}

main();
