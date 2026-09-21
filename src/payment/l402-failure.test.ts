/**
 * Lightning invoice failure-surface tests (Vikunja #44)
 *
 * Covers the glue between a failed invoice creation and what a client/operator
 * sees: failure categorisation from each upstream condition, the sanitiser, the
 * degraded /health flag, the 503 for a lightning-only route (with Retry-After)
 * and the guarantee that the upstream message never reaches a public body.
 *
 * Time-based breaker behaviour (backoff, recovery, one-probe-in-flight) is unit
 * tested with a fake scheduler in breaker.test.ts.
 *
 * Run with: bun run src/payment/l402-failure.test.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  build402Response,
  createL402Challenge,
  sanitizeUpstreamMessage,
  lightningHealth,
  shutdownLightningBreakers,
  __resetLightningBreakersForTests,
} from "./payment.ts";
import type { VerificationResult } from "./payment.ts";
import { handleRequest } from "../router.ts";
import { SERVER_VERSION } from "../version.ts";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Harness
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

async function mute<T>(fn: () => T | Promise<T>): Promise<T> {
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

const CONTENT_DIR = join(import.meta.dir, "..", "..", "content");
const API_URL = "http://alby.invalid/api";
const TOKEN = "SUPER-SECRET-ALBY-TOKEN";
const SECRET = "SUPER-SECRET-MACAROON-KEY";

const dataDir = mkdtempSync(join(tmpdir(), "mdf-l402-failure-"));
process.env.MDF_DATA_DIR = dataDir;

function makeLoaded(overrides: Record<string, unknown> = {}): LoadedConfig {
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
          "/premium/**": { amount: "0.01", currency: "USDC", chain: "base" },
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
        api_url: API_URL,
        invoice_expiry_seconds: 3600,
        api_token: TOKEN,
        token_secret: SECRET,
        breaker_initial_backoff_seconds: 5,
        breaker_max_backoff_seconds: 300,
      },
      ...overrides,
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

// ---------------------------------------------------------------------------
// Fetch mock — one switchable response for the invoice-create call
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let invoiceCalls = 0;
let invoiceResponder: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ paymentHash: "ab".repeat(32), invoice: "lnbc10n1x", settledAt: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function installFetchMock() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
    if (String(url).includes("/invoices")) {
      invoiceCalls++;
    }
    return await invoiceResponder();
  };
}
function restoreFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
}

async function invoiceFailure(response: () => Response | Promise<Response>) {
  __resetLightningBreakersForTests();
  invoiceCalls = 0;
  invoiceResponder = response;
  const loaded = makeLoaded();
  return mute(() => createL402Challenge("/micropayment/intro", loaded));
}

installFetchMock();

// ---------------------------------------------------------------------------
// Sanitiser
// ---------------------------------------------------------------------------

console.log("\nUpstream message sanitiser\n");

await test("replaces a known secret value with [redacted]", () => {
  const out = sanitizeUpstreamMessage(`token ${TOKEN} rejected`, [TOKEN]);
  assert(!out.includes(TOKEN), "secret removed");
  assert(out.includes("[redacted]"), "replacement present");
});

await test("replaces Bearer and Authorization values", () => {
  const out = sanitizeUpstreamMessage(
    "Authorization: Bearer abc123DEF456xyz and Basic Zm9vOmJhcg=="
  );
  assert(!out.includes("abc123DEF456xyz"), "bearer token removed");
  assert(!out.includes("Zm9vOmJhcg=="), "basic credentials removed");
});

await test("replaces long hex (preimages, payment hashes) and long opaque tokens", () => {
  const preimage = "a1b2c3d4".repeat(8); // 64 hex
  const macaroonish = "Z".repeat(60);
  const out = sanitizeUpstreamMessage(`preimage=${preimage} macaroon=${macaroonish}`);
  assert(!out.includes(preimage), "preimage removed");
  assert(!out.includes(macaroonish), "macaroon-ish token removed");
});

await test("collapses control characters and caps length", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const out = sanitizeUpstreamMessage(`line1\nline2\t${words}`);
  assert(!out.includes("\n") && !out.includes("\t"), "control chars collapsed");
  assert(out.length <= 301, `length capped, got ${out.length}`);
  assert(out.endsWith("…"), "truncation marker present");
});

// ---------------------------------------------------------------------------
// Failure categorisation
// ---------------------------------------------------------------------------

console.log("\nFailure categorisation\n");

await test("HTTP 500 with a body maps to rejected and keeps the reason", async () => {
  const res = await invoiceFailure(
    () =>
      new Response(JSON.stringify({ message: "the amount must be a whole number of satoshis" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
  );
  assert(!res.ok, "failed");
  if (!res.ok) {
    assertEquals(res.failure.category, "rejected", "category");
    assertEquals(res.failure.upstreamStatus, 500, "status retained");
    assert(
      res.failure.upstreamMessage.includes("whole number of satoshis"),
      "reason retained"
    );
  }
});

await test("HTTP 400 maps to rejected", async () => {
  const res = await invoiceFailure(() => new Response("bad request", { status: 400 }));
  assert(!res.ok && res.failure.category === "rejected", "rejected");
  assert(!res.ok && res.failure.upstreamStatus === 400, "status 400");
});

await test("HTTP 401 maps to auth", async () => {
  const res = await invoiceFailure(() => new Response("nope", { status: 401 }));
  assert(!res.ok && res.failure.category === "auth", "auth");
  assert(!res.ok && res.failure.upstreamStatus === 401, "status 401");
});

await test("HTTP 403 maps to auth", async () => {
  const res = await invoiceFailure(() => new Response("forbidden", { status: 403 }));
  assert(!res.ok && res.failure.category === "auth", "auth");
});

await test("a connection error maps to unreachable with no status", async () => {
  const res = await invoiceFailure(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1:8021");
  });
  assert(!res.ok && res.failure.category === "unreachable", "unreachable");
  assert(!res.ok && res.failure.upstreamStatus === null, "no status");
});

await test("a timeout maps to unreachable", async () => {
  const res = await invoiceFailure(() => {
    const err = new Error("The operation was aborted due to timeout");
    (err as { name: string }).name = "TimeoutError";
    throw err;
  });
  assert(!res.ok && res.failure.category === "unreachable", "unreachable");
});

await test("an unparseable 200 body maps to unknown", async () => {
  const res = await invoiceFailure(
    () => new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } })
  );
  assert(!res.ok && res.failure.category === "unknown", "unknown");
});

// ---------------------------------------------------------------------------
// Breaker suppression + degraded surfaces
// ---------------------------------------------------------------------------

console.log("\nDegraded lightning rail\n");

await test("while degraded, no backend call is made and the rail is not advertised", async () => {
  __resetLightningBreakersForTests();
  invoiceCalls = 0;
  invoiceResponder = () => new Response("boom", { status: 500 });
  const loaded = makeLoaded();

  const first = await mute(() => build402Response("/micropayment/intro", noProof(), loaded));
  assertEquals(first.status, 503, "first failure is a 503");
  assertEquals(invoiceCalls, 1, "one backend call");

  const before = invoiceCalls;
  const second = await mute(() => build402Response("/micropayment/intro", noProof(), loaded));
  assertEquals(second.status, 503, "second is also 503");
  assertEquals(invoiceCalls, before, "no further backend call while degraded");
  assert(second.headers["WWW-Authenticate"] === undefined, "no L402 header while degraded");
  assert(!!second.headers["Retry-After"], "Retry-After present");
  assertEquals(second.headers["Cache-Control"], "no-store", "no-store preserved");

  const body = JSON.parse(second.body) as {
    payment: { lightning_unavailable?: boolean; lightning_unavailable_category?: string; rail?: string };
  };
  assertEquals(body.payment.lightning_unavailable, true, "flagged unavailable");
  assertEquals(body.payment.lightning_unavailable_category, "rejected", "coarse category");
  assert(body.payment.rail === undefined, "rail omitted");
});

await test("the public 503 body never contains the upstream message", async () => {
  __resetLightningBreakersForTests();
  invoiceResponder = () =>
    new Response(JSON.stringify({ message: `secret ${TOKEN} amount must be whole` }), { status: 500 });
  const loaded = makeLoaded();
  const res = await mute(() => build402Response("/micropayment/intro", noProof(), loaded));
  assert(!res.body.includes(TOKEN), "token not in body");
  assert(!res.body.includes("amount must be whole"), "upstream reason not in body");
});

await test("/health is 200 ok with a lightning block while degraded, message-free", async () => {
  __resetLightningBreakersForTests();
  invoiceResponder = () => new Response(`token=${TOKEN} failed`, { status: 500 });
  const loaded = makeLoaded();
  await mute(() => build402Response("/micropayment/intro", noProof(), loaded));

  const health = await mute(() => handleRequest(new Request("https://example.com/health"), loaded));
  assertEquals(health.status, 200, "top-level stays 200 so Caddy does not drain the pool");
  const body = JSON.parse(await health.text()) as {
    status: string;
    version: string;
    lightning?: { status: string; since?: string; category?: string; next_retry?: string };
  };
  assertEquals(body.status, "ok", "top-level ok");
  assert(!!body.lightning, "lightning block present");
  assertEquals(body.lightning?.status, "degraded", "degraded");
  assertEquals(body.lightning?.category, "rejected", "category");
  assert(!!body.lightning?.since, "since present");
  assert(!!body.lightning?.next_retry, "next_retry present");
  assert(!JSON.stringify(body).includes(TOKEN), "health never carries the upstream message");
  assert(!JSON.stringify(body).includes("failed"), "health never carries the upstream message");
});

await test("a healthy /health has no lightning block (0.2.6-compatible)", async () => {
  __resetLightningBreakersForTests();
  const loaded = makeLoaded();
  const health = await mute(() => handleRequest(new Request("https://example.com/health"), loaded));
  assertEquals(health.status, 200, "200");
  const body = JSON.parse(await health.text()) as Record<string, unknown>;
  assertEquals(body.status, "ok", "ok");
  assert(body.lightning === undefined, "no lightning block when healthy");
  assertEquals(body.version, SERVER_VERSION, "version carried");
  assertEquals(lightningHealth(loaded)?.status, "ok", "breaker healthy");
});

// ---------------------------------------------------------------------------
// Healthy per-route advertising (Part B2)
// ---------------------------------------------------------------------------

console.log("\nHealthy per-route advertising\n");

await test("x402 route 402 is unchanged and carries no lightning fields", async () => {
  __resetLightningBreakersForTests();
  const loaded = makeLoaded();
  const res = await mute(() => build402Response("/premium/deep-dive", noProof(), loaded));
  assertEquals(res.status, 402, "402");
  const body = JSON.parse(res.body) as { payment: Record<string, unknown> };
  assertEquals(body.payment.rail, "x402", "x402 rail");
  assert(body.payment.lightning_invoice === undefined, "no invoice");
  assert(body.payment.lightning_unavailable === undefined, "no degraded flag");
  assert(res.headers["WWW-Authenticate"] === undefined, "no L402 header");
});

await test("lightning route 402 carries the challenge and no degraded flag", async () => {
  __resetLightningBreakersForTests();
  invoiceResponder = () =>
    new Response(JSON.stringify({ paymentHash: "ab".repeat(32), invoice: "lnbc10n1healthy", settledAt: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const loaded = makeLoaded();
  const res = await mute(() => build402Response("/micropayment/intro", noProof(), loaded));
  assertEquals(res.status, 402, "402");
  assert(!!res.headers["WWW-Authenticate"], "L402 header present");
  const body = JSON.parse(res.body) as { payment: Record<string, unknown> };
  assertEquals(body.payment.rail, "l402", "l402 rail");
  assert(!!body.payment.lightning_invoice, "invoice present");
  assert(body.payment.lightning_unavailable === undefined, "no degraded flag");
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

console.log("\nShutdown\n");

await test("shutdownLightningBreakers clears state and is idempotent", () => {
  __resetLightningBreakersForTests();
  const loaded = makeLoaded();
  lightningHealth(loaded); // materialise a breaker
  shutdownLightningBreakers();
  shutdownLightningBreakers(); // must not throw
  assert(true, "idempotent");
});

restoreFetch();
rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
