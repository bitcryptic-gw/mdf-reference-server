/**
 * x402 verifier tests (Vikunja #52, 0.2.8)
 *
 * `verifyPayment()` is the only code that enforces payment on the x402 rail.
 * 0.2.8 removed the `/verify`-failure on-chain fallback that let a settled
 * X-PAYMENT be replayed forever (#52): a `/verify` that rejects a payment now
 * returns 402, and approval requires a successful `/settle` in the same
 * request. The one remaining on-chain approval — a `/settle` error recovered by
 * confirming the exact authorization `/verify` accepted — is exercised here too,
 * including the boundary that it is unreachable unless `/verify` succeeded.
 *
 * Everything runs against a mocked facilitator (no network, no wallet).
 *
 * Run with: bun run src/payment/x402-verify.test.ts
 */

import { join } from "path";
import { verifyPayment } from "./payment.ts";
import { handleRequest } from "../router.ts";
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

async function mute<T>(fn: () => T | Promise<T>): Promise<T> {
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CONTENT_DIR = join(import.meta.dir, "..", "..", "content");
const FAC_URL = "https://facilitator.example";
const RPC_URL = "https://rpc.example";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0xBB12e7F39F734aD962c50dDbE91F73557Bf9A93B";

function makeLoaded(): LoadedConfig {
  const facilitator = {
    url: FAC_URL,
    scheme: "exact",
    max_timeout_seconds: 300,
    timeout_ms: 15000,
    chains: {
      base_sepolia: {
        asset: ASSET,
        decimals: 6,
        extra: { name: "USDC", version: "2" },
        rpc_url: RPC_URL,
      },
    },
  };
  return {
    contentDir: CONTENT_DIR,
    walletAddress: WALLET,
    mdfJson: "{}",
    facilitatorConfig: facilitator,
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: CONTENT_DIR, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: {
          "/": { amount: "0.0000", currency: null, chain: null },
          "/testnet/**": { amount: "0.0010", currency: "USDC", chain: "base_sepolia" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base_sepolia"],
        accepted_currencies: ["USDC"],
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      facilitator,
    } as LoadedConfig["config"],
  };
}

let nonceSeq = 0;
function nextNonce(): string {
  nonceSeq++;
  return "0x" + nonceSeq.toString(16).padStart(64, "0");
}

function xPayment(over: {
  to?: string;
  value?: string;
  nonce?: string;
  validBefore?: string;
  network?: string;
  scheme?: string;
} = {}): { header: string; from: string; to: string; nonce: string } {
  const nonce = over.nonce ?? nextNonce();
  const auth = {
    from: PAYER,
    to: over.to ?? WALLET,
    value: over.value ?? "1000",
    validAfter: "0",
    validBefore: over.validBefore ?? "9999999999",
    nonce,
  };
  const envelope = {
    x402Version: 1,
    scheme: over.scheme ?? "exact",
    network: over.network ?? "base-sepolia",
    payload: { signature: "0x" + "cd".repeat(65), authorization: auth },
  };
  return {
    header: Buffer.from(JSON.stringify(envelope)).toString("base64"),
    from: auth.from,
    to: auth.to,
    nonce,
  };
}

// ---------------------------------------------------------------------------
// Facilitator mock
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
interface Route {
  status: number;
  body: string;
}
interface Call {
  url: string;
  method: string;
  body: unknown;
}

let verifyResp: Route;
let verifyThrows = false;
let settleResp: Route;
let settleThrows = false;
let rpcResp: Route;
let rpcThrows = false;
let calls: Call[] = [];

function resetMock() {
  calls = [];
  verifyThrows = false;
  verifyResp = { status: 200, body: JSON.stringify({ isValid: true, payer: PAYER }) };
  settleThrows = false;
  settleResp = {
    status: 200,
    body: JSON.stringify({ success: true, payer: PAYER, transaction: "0x" + "ab".repeat(32) }),
  };
  rpcThrows = false;
  rpcResp = { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "1" }) };
}

function mk(r: Route): Response {
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
}

function installFetchMock() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: unknown,
    init?: { method?: string; body?: unknown }
  ) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body });
    if (u.includes(FAC_URL + "/verify")) {
      if (verifyThrows) throw new Error("fetch failed: ECONNREFUSED");
      return mk(verifyResp);
    }
    if (u.includes(FAC_URL + "/settle")) {
      if (settleThrows) throw new Error("fetch failed: ECONNREFUSED");
      return mk(settleResp);
    }
    if (u.includes(RPC_URL)) {
      if (rpcThrows) throw new Error("The operation timed out.");
      return mk(rpcResp);
    }
    throw new Error("unexpected fetch: " + u);
  };
}
function restoreFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
}
function callsTo(sub: string): Call[] {
  return calls.filter((c) => c.url.includes(sub));
}

/** Decode the (from, nonce) an authorizationState eth_call targets. */
function decodeAuthorizationState(body: unknown): { from: string; nonce: string } | null {
  if (typeof body !== "string") return null;
  let parsed: { params?: Array<{ data?: unknown }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const data = parsed?.params?.[0]?.data;
  if (typeof data !== "string" || !data.startsWith("0xe94a0102")) return null;
  const rest = data.slice(10);
  return { from: "0x" + rest.slice(24, 64), nonce: "0x" + rest.slice(64, 128) };
}

function verify(header: string) {
  return mute(() => verifyPayment("/testnet/intro", header, makeLoaded()));
}
function route(header: string) {
  return mute(() =>
    handleRequest(
      new Request("https://example.com/testnet/intro", {
        headers: { accept: "text/markdown", "x-payment": header },
      }),
      makeLoaded()
    )
  );
}

installFetchMock();
const USED_NONCE_BODY = JSON.stringify({
  isValid: false,
  invalidReason: "unexpected_error",
  invalidReasonDetails:
    "server returned an error response: error code 3: execution reverted: FiatTokenV2: authorization is used or canceled",
  payer: "",
});

// ---------------------------------------------------------------------------
// /verify invalid → 402
// ---------------------------------------------------------------------------

console.log("\nx402 /verify invalid → 402 (never 5xx, never 200)\n");

await test("used nonce (HTTP 500 with isValid:false) → rejected, no settle, no on-chain", async () => {
  resetMock();
  verifyResp = { status: 500, body: USED_NONCE_BODY };
  const r = await verify(xPayment().header);
  assertEquals(r.status, "rejected", "used nonce must be rejected");
  assertEquals(callsTo(FAC_URL + "/verify").length, 1, "one /verify call");
  assertEquals(callsTo(FAC_URL + "/settle").length, 0, "settle must not be called");
  assertEquals(callsTo(RPC_URL).length, 0, "on-chain must not be consulted");
});

await test("used nonce → router 402 with no-store", async () => {
  resetMock();
  verifyResp = { status: 500, body: USED_NONCE_BODY };
  const res = await route(xPayment().header);
  assertEquals(res.status, 402, "router must return 402, not 5xx");
  assertEquals(res.headers.get("cache-control"), "no-store", "402 must be no-store");
});

await test("expired authorization → rejected", async () => {
  resetMock();
  verifyResp = {
    status: 400,
    body: JSON.stringify({ isValid: false, invalidReason: "invalid_payment_expired", payer: "" }),
  };
  const r = await verify(xPayment({ validBefore: "1" }).header);
  assertEquals(r.status, "rejected", "expired must be rejected");
  assertEquals(callsTo(RPC_URL).length, 0, "no on-chain lookup");
});

await test("under-amount → rejected", async () => {
  resetMock();
  verifyResp = {
    status: 400,
    body: JSON.stringify({ isValid: false, invalidReason: "invalid_payment_amount", payer: "" }),
  };
  const r = await verify(xPayment({ value: "1" }).header);
  assertEquals(r.status, "rejected", "under-amount must be rejected");
});

await test("wrong asset / bad signature (isValid:false) → rejected", async () => {
  resetMock();
  verifyResp = {
    status: 500,
    body: JSON.stringify({
      isValid: false,
      invalidReason: "unexpected_error",
      invalidReasonDetails: "FiatTokenV2: invalid signature",
      payer: "",
    }),
  };
  const r = await verify(xPayment().header);
  assertEquals(r.status, "rejected", "invalid signature must be rejected");
});

await test("wrong pay_to → rejected before the facilitator is called", async () => {
  resetMock();
  const r = await verify(xPayment({ to: "0x1111111111111111111111111111111111111111" }).header);
  assertEquals(r.status, "rejected", "wrong recipient must be rejected");
  assertEquals(callsTo(FAC_URL + "/verify").length, 0, "facilitator must not be called");
});

// ---------------------------------------------------------------------------
// /verify facilitator failure → 503
// ---------------------------------------------------------------------------

console.log("\nx402 /verify facilitator failure → 503\n");

await test("facilitator 500 with an unstructured body → error (503), not 402", async () => {
  resetMock();
  verifyResp = { status: 500, body: "<html>502 Bad Gateway</html>" };
  const r = await verify(xPayment().header);
  assertEquals(r.status, "error", "unstructured 500 must be a facilitator error");
  const res = await route(xPayment().header);
  assertEquals(res.status, 503, "router must return 503");
  assertEquals(res.headers.get("cache-control"), "no-store", "503 must be no-store");
  assertEquals(callsTo(RPC_URL).length, 0, "no on-chain lookup");
});

await test("facilitator unreachable (transport) → error (503)", async () => {
  resetMock();
  verifyThrows = true;
  const r = await verify(xPayment().header);
  assertEquals(r.status, "error", "unreachable facilitator must be an error");
});

// ---------------------------------------------------------------------------
// /verify valid → settle
// ---------------------------------------------------------------------------

console.log("\nx402 /verify valid → settle\n");

await test("happy path: verify ok + settle ok → approved / 200", async () => {
  resetMock();
  const r = await verify(xPayment().header);
  assertEquals(r.status, "approved", "valid payment must be approved");
  assert(!!r.settlement?.transaction, "settlement transaction must be set");
  assertEquals(callsTo(FAC_URL + "/settle").length, 1, "settle called once");
  assertEquals(callsTo(RPC_URL).length, 0, "no on-chain lookup on a clean settle");

  resetMock();
  const res = await route(xPayment().header);
  assertEquals(res.status, 200, "router must serve 200");
  assert(!!res.headers.get("payment-response"), "Payment-Response header present");
});

await test("settle error + on-chain settled → approved / 200 (lost settle response recovered)", async () => {
  resetMock();
  settleResp = {
    status: 500,
    body: JSON.stringify({
      success: false,
      errorReason: "server returned a null response when a non-null response was expected",
    }),
  };
  const pay = xPayment();
  const r = await verify(pay.header);
  assertEquals(r.status, "approved", "on-chain-confirmed settle must be approved");
  assertEquals(callsTo(RPC_URL).length, 1, "on-chain consulted exactly once");
  const args = decodeAuthorizationState(callsTo(RPC_URL)[0].body);
  assert(!!args, "RPC call must be an authorizationState lookup");
  assertEquals(args!.from.toLowerCase(), pay.from.toLowerCase(), "on-chain check uses verified from");
  assertEquals(args!.nonce.toLowerCase(), pay.nonce.toLowerCase(), "on-chain check uses verified nonce");
});

await test("settle error + on-chain NOT settled → error (503), no approval", async () => {
  resetMock();
  settleResp = { status: 500, body: JSON.stringify({ success: false, errorReason: "settle failed" }) };
  rpcResp = { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) }) };
  const r = await verify(xPayment().header);
  assertEquals(r.status, "error", "unrecovered settle failure must be 503, not 402");
  const res = await route(xPayment().header);
  assertEquals(res.status, 503, "router must return 503");
});

await test("settle error + on-chain lookup fails/timeout → error (503), fails closed", async () => {
  resetMock();
  settleResp = { status: 500, body: JSON.stringify({ success: false, errorReason: "settle failed" }) };
  rpcThrows = true;
  const r = await verify(xPayment().header);
  assertEquals(r.status, "error", "unresolvable on-chain check must be 503");
});

// ---------------------------------------------------------------------------
// Invariant: approval requires settlement, bound to the verify success
// ---------------------------------------------------------------------------

console.log("\nx402 approval invariant\n");

await test("invariant: on-chain confirmation is unreachable unless /verify succeeded", async () => {
  // Every non-valid /verify outcome: no settle, no on-chain, no approval.
  const cases: Array<() => void> = [
    () => { verifyResp = { status: 500, body: USED_NONCE_BODY }; },
    () => { verifyResp = { status: 400, body: JSON.stringify({ isValid: false, invalidReason: "invalid_payment_expired" }) }; },
    () => { verifyResp = { status: 500, body: "<html>bad</html>" }; },
    () => { verifyThrows = true; },
  ];
  for (const setup of cases) {
    resetMock();
    setup();
    const r = await verify(xPayment().header);
    assert(r.status !== "approved", `must not approve on a non-valid /verify (${r.status})`);
    assertEquals(callsTo(FAC_URL + "/settle").length, 0, "settle must not run");
    assertEquals(callsTo(RPC_URL).length, 0, "on-chain must not run");
  }
});

await test("invariant: a replayed used nonce never reaches settle or the on-chain check", async () => {
  resetMock();
  // Simulate the replay: /verify answers used; the nonce is already settled.
  verifyResp = { status: 500, body: USED_NONCE_BODY };
  rpcResp = { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "1" }) };
  const r = await verify(xPayment({ nonce: "0x" + "bc".repeat(32) }).header);
  assertEquals(r.status, "rejected", "replay must be 402");
  assertEquals(callsTo(FAC_URL + "/settle").length, 0, "settle must never run on a replay");
  assertEquals(callsTo(RPC_URL).length, 0, "on-chain check must never run on a replay");
});

// ---------------------------------------------------------------------------

restoreFetch();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
