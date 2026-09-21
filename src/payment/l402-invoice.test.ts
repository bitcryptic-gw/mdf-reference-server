/**
 * L402 invoice amount + units regression test (Vikunja #34)
 *
 * The demo's L402 route (`/micropayment/intro`, 0.00000001 BTC = 1 sat) was
 * unpayable: Alby Hub returned HTTP 500 "the amount must be a whole number of
 * satoshis". Root cause: Alby Hub's `POST /api/invoices` takes `amount` in
 * **millisatoshis**, but the server was passing a value it called satoshis
 * straight through. The `/premium` offer (1.0000 USDC → 1000 in the code) was
 * invoiced as 1 sat (`lnbc10n`) instead of 1000 sats — a 1000x undercharge —
 * and sub-satoshi values (1 msat) were rejected outright.
 *
 * These tests pin the conversion with a mocked Alby so no network or wallet is
 * touched: exact/fractional satoshi values, rounding up at the invoice
 * boundary, and that the amount advertised in the 402 body matches what is
 * actually invoiced.
 *
 * Run with: bun run src/payment/l402-invoice.test.ts
 */

import {
  build402Response,
  createL402Challenge,
  usdToSats,
  satsToMsat,
  priceToSats,
  __resetLightningBreakersForTests,
} from "./payment.ts";
import type { VerificationResult } from "./payment.ts";
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
// Fixtures
// ---------------------------------------------------------------------------

const CONTENT_DIR = "/nonexistent-in-test";

function makeLoaded(): LoadedConfig {
  return {
    contentDir: CONTENT_DIR,
    walletAddress: "0xDEAD",
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: CONTENT_DIR, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: {
          "/micropayment/**": { amount: "0.00000001", currency: "BTC", chain: "lightning" },
          "/premium/**": { amount: "1.0000", currency: "USDC", chain: "base" },
          "/private/**": { amount: "100.00", currency: "USDC", chain: "base" },
          "/testnet/**": { amount: "0.0010", currency: "USDC", chain: "base_sepolia" },
          "/fractional/**": { amount: "1.0009", currency: "USDC", chain: "base" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base", "lightning"],
        accepted_currencies: ["USDC", "BTC"],
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      lightning: {
        api_url: "http://alby.invalid/api",
        invoice_expiry_seconds: 3600,
        api_token: "TEST-TOKEN-NOT-A-SECRET",
        token_secret: "TEST-SECRET-NOT-A-SECRET",
      },
    } as LoadedConfig["config"],
  };
}

function noProof(): VerificationResult {
  return {
    status: "no_proof",
    proof: null,
    l402Credential: null,
    reason: "payment required",
    requiresToken: false,
    rail: "none",
  };
}

interface Captured {
  url: string;
  body: { amount: number; description: string; expiry: number } | null;
}

const captured: Captured[] = [];
const realFetch = globalThis.fetch;
let albyStatus = 200;

function installFetchMock() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Captured["body"]) : null,
    });
    if (albyStatus !== 200) {
      return new Response(JSON.stringify({ message: "the amount must be a whole number of satoshis" }), {
        status: albyStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Return a BOLT11-shaped invoice whose HRP encodes the msat the server sent,
    // so a test can read the outgoing amount straight off the invoice too.
    const amount = (init?.body ? (JSON.parse(String(init.body)) as { amount: number }).amount : 0) || 0;
    return new Response(
      JSON.stringify({
        paymentHash: "ab".repeat(32),
        invoice: `lnbc${amount}n1testinvoice`,
        settledAt: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

function restoreFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
}

// ---------------------------------------------------------------------------
// Conversion units
// ---------------------------------------------------------------------------

console.log("\nPrice → satoshi conversion (exact, unrounded)\n");

await test("exact whole satoshi: 1.0000 USD → 1000 sats", () => {
  assertEquals(usdToSats("1.0000"), 1000, "1 USD at 1000 sats/USD");
});

await test("exact whole satoshi: 0.0010 USD → 1 sat", () => {
  assertEquals(usdToSats("0.0010"), 1, "0.001 USD at 1000 sats/USD");
});

await test("fractional, below one satoshi: 0.00000001 → 0.00001 sats", () => {
  const sats = usdToSats("0.00000001");
  assert(Math.abs(sats - 0.00001) < 1e-12, `expected 0.00001, got ${sats}`);
});

await test("fractional, just above a whole satoshi: 1.0009 USD → 1000.9 sats", () => {
  const sats = usdToSats("1.0009");
  assert(Math.abs(sats - 1000.9) < 1e-9, `expected 1000.9, got ${sats}`);
});

await test("invalid price yields 0 (never a negative or NaN invoice)", () => {
  assertEquals(usdToSats("not-a-number"), 0, "NaN → 0");
  assertEquals(usdToSats("-5"), 0, "negative → 0");
});

console.log("\nCurrency-aware price → satoshi conversion (Vikunja #44)\n");

await test("BTC converts at 1 BTC = 100,000,000 sats", () => {
  assertEquals(priceToSats("0.00000001", "BTC"), 1, "0.00000001 BTC = 1 sat");
  assertEquals(priceToSats("0.000001", "BTC"), 100, "0.000001 BTC = 100 sat");
  assertEquals(priceToSats("1", "BTC"), 100_000_000, "1 BTC = 100,000,000 sat");
});

await test("USD and USDC use the fixed 1000 sats/USD rate", () => {
  assertEquals(priceToSats("0.01", "USDC"), 10, "0.01 USDC = 10 sat");
  assertEquals(priceToSats("0.10", "USDC"), 100, "0.10 USDC = 100 sat");
  assertEquals(priceToSats("0.0010", "USDC"), 1, "0.0010 USDC = 1 sat");
  assertEquals(priceToSats("1.0000", "USD"), 1000, "1 USD = 1000 sat");
});

await test("a BTC price is no longer read at the USD rate", () => {
  // The latent 100x undercharge: 0.000001 BTC (= 100 sat) used to be read as
  // 0.000001 USD × 1000 = 0.001 sat → ceil → 1 sat.
  assertEquals(satsToMsat(priceToSats("0.000001", "BTC")), 100_000, "100 sats not 1");
});

await test("an unsupported lightning currency is a hard error, not a silent misread", () => {
  let threw = false;
  try {
    priceToSats("1.00", "EUR");
  } catch {
    threw = true;
  }
  assert(threw, "EUR on the lightning rail must throw");
});

console.log("\nSatoshi → millisatoshi (round UP to whole satoshi)\n");

await test("exact whole number: 1000 sats → 1,000,000 msat", () => {
  assertEquals(satsToMsat(1000), 1_000_000, "1000 sats");
});

await test("just above a whole satoshi rounds up: 1000.9 → 1,001,000 msat", () => {
  assertEquals(satsToMsat(1000.9), 1_001_000, "1000.9 sats rounds up to 1001");
});

await test("below one satoshi rounds up to 1 sat: 0.00001 → 1000 msat", () => {
  assertEquals(satsToMsat(0.00001), 1000, "sub-satoshi rounds up to 1 sat");
});

await test("zero/non-finite floors at 1 sat (never a zero invoice)", () => {
  assertEquals(satsToMsat(0), 1000, "0 → 1000 msat");
  assertEquals(satsToMsat(-1), 1000, "negative → 1000 msat");
  assertEquals(satsToMsat(NaN), 1000, "NaN → 1000 msat");
});

// ---------------------------------------------------------------------------
// Outgoing Alby amount (mocked)
// ---------------------------------------------------------------------------

console.log("\nInvoice amount sent to Alby (mocked)\n");

installFetchMock();
const loaded = makeLoaded();

await test("/micropayment (0.00000001 BTC = 1 sat) → 1000 msat, not 1", async () => {
  captured.length = 0;
  const res = await createL402Challenge("/micropayment/intro", loaded);
  assert(res.ok, "challenge issued");
  assertEquals(captured[0].body?.amount, 1000, "sub-satoshi offer invoices 1 whole sat");
  assertEquals(captured[0].url, "http://alby.invalid/api/invoices", "Alby endpoint");
});

await test("/premium (1.0000 USDC → 1000 sats) → 1,000,000 msat, not 1000", async () => {
  captured.length = 0;
  await createL402Challenge("/premium/deep-dive", loaded);
  assertEquals(captured[0].body?.amount, 1_000_000, "corrected 1000x undercharge");
});

await test("/private (100.00 USDC → 100,000 sats) → 100,000,000 msat", async () => {
  captured.length = 0;
  await createL402Challenge("/private/internals", loaded);
  assertEquals(captured[0].body?.amount, 100_000_000, "100 USD at 1000 sats/USD");
});

await test("/testnet (0.0010 USDC → 1 sat) → 1000 msat", async () => {
  captured.length = 0;
  await createL402Challenge("/testnet/intro", loaded);
  assertEquals(captured[0].body?.amount, 1000, "sub-satoshi offer invoices 1 whole sat");
});

await test("/fractional (1.0009 USDC → 1000.9 sats) rounds up → 1,001,000 msat", async () => {
  captured.length = 0;
  await createL402Challenge("/fractional/x", loaded);
  assertEquals(captured[0].body?.amount, 1_001_000, "fractional sat rounds up");
});

// ---------------------------------------------------------------------------
// Advertised amount matches the invoiced amount
// ---------------------------------------------------------------------------

console.log("\nAdvertised (402 body) matches invoiced (Alby)\n");

await test("/micropayment: 402 advertises 0.00000001 BTC = the 1 sat invoiced", async () => {
  captured.length = 0;
  const res = await build402Response("/micropayment/intro", noProof(), loaded);
  assertEquals(res.status, 402, "status");

  const body = JSON.parse(res.body) as {
    payment: { amount: string; currency: string; chain: string };
  };
  const advertisedSats = parseFloat(body.payment.amount) * 1e8;
  assertEquals(advertisedSats, 1, "advertised BTC amount is 1 sat");

  assert(captured[0].body !== null, "Alby was called");
  assertEquals(captured[0].body?.amount, advertisedSats * 1000, "invoice msat == advertised sats * 1000");
});

// ---------------------------------------------------------------------------
// Only lightning offers carry an L402 challenge (Vikunja #44)
// ---------------------------------------------------------------------------

console.log("\nL402 challenge is attached only to lightning offers\n");

await test("an x402 offer carries no L402 header, invoice field or Alby call", async () => {
  captured.length = 0;
  const res = await build402Response("/premium/deep-dive", noProof(), loaded);
  assertEquals(res.status, 402, "status");
  assert(res.headers["WWW-Authenticate"] === undefined, "x402 offer must not carry WWW-Authenticate");

  const body = JSON.parse(res.body) as { payment: { amount: string; currency: string; lightning_invoice?: string } };
  assertEquals(body.payment.amount, "1.0000", "advertised amount");
  assertEquals(body.payment.currency, "USDC", "advertised currency");
  assert(body.payment.lightning_invoice === undefined, "x402 offer must not carry lightning_invoice");
  assertEquals(captured.length, 0, "no Alby invoice must be burned for an x402 offer");
});

await test("a lightning offer still carries the L402 challenge and invoice field", async () => {
  captured.length = 0;
  const res = await build402Response("/micropayment/intro", noProof(), loaded);
  assert(!!res.headers["WWW-Authenticate"], "lightning offer carries WWW-Authenticate");
  const body = JSON.parse(res.body) as { payment: { lightning_invoice?: string; rail?: string } };
  assertEquals(body.payment.rail, "l402", "rail");
  assert(!!body.payment.lightning_invoice, "lightning_invoice present");
  assertEquals(captured.length, 1, "exactly one invoice for the lightning offer");
});

// ---------------------------------------------------------------------------
// Failure path returns a typed failure, does not throw
// ---------------------------------------------------------------------------

console.log("\nInvoice creation failure\n");

await test("Alby 500 returns a typed rejected failure with the upstream status", async () => {
  albyStatus = 500;
  let result: Awaited<ReturnType<typeof createL402Challenge>> | "threw" = "threw";
  try {
    result = await createL402Challenge("/micropayment/intro", loaded);
  } catch (err) {
    throw new Error(`must not throw: ${(err as Error).message}`);
  } finally {
    albyStatus = 200;
  }
  assert(result !== "threw", "did not throw");
  assert(!result.ok, "failure is not ok");
  if (!result.ok) {
    assertEquals(result.failure.category, "rejected", "category");
    assertEquals(result.failure.upstreamStatus, 500, "upstream status retained");
    assert(
      result.failure.upstreamMessage.includes("whole number of satoshis"),
      "the human-readable upstream reason is retained"
    );
  }
  __resetLightningBreakersForTests();
});

await test("a suppressed retry does not call Alby while the breaker is open", async () => {
  albyStatus = 500;
  await createL402Challenge("/micropayment/intro", loaded);
  captured.length = 0;
  const second = await createL402Challenge("/micropayment/intro", loaded);
  assert(!second.ok && second.suppressed, "second attempt is suppressed");
  assertEquals(captured.length, 0, "suppressed attempt makes no backend call");
  albyStatus = 200;
  __resetLightningBreakersForTests();
});

restoreFetch();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
