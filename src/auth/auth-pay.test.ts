/**
 * Token-issuance payment gate (0.2.9 security fix)
 *
 * 0.2.8 and earlier: `POST /mdf/auth` minted a 24 h bearer token for **any**
 * body-supplied path, with no payment check at all, so the token-gated tier
 * (`/private/**`, 0.10 USDC on Base mainnet) was free to anyone who read
 * `/mdf.json`. 0.2.9 routes both `<auth.endpoint>` and `/mdf/pay` through one
 * handler that verifies and settles a payment in the same request, and refuses
 * a token for a path that is not a token-access section.
 *
 * These tests pin the gate, the scope, and the fact that a client-asserted
 * `txHash`/`from` in the request body is ignored.
 *
 * Everything runs against a mocked facilitator (no network, no wallet).
 *
 * Run with: bun run src/auth/auth-pay.test.ts
 */

import { join } from "path";
import { handleRequest } from "../router.ts";
import { issueToken, validateToken, tokenStore } from "./auth.ts";
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
// Fixture — two token-access sections, so scope can be tested cross-section
// ---------------------------------------------------------------------------

const CONTENT_DIR = join(import.meta.dir, "..", "..", "content");
const FAC_URL = "https://facilitator.example";
const RPC_URL = "https://rpc.example";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const ASSET_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ASSET_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0xBB12e7F39F734aD962c50dDbE91F73557Bf9A93B";
const SETTLE_TX = "0x" + "ab".repeat(32);

function makeLoaded(): LoadedConfig {
  const facilitator = {
    url: FAC_URL,
    scheme: "exact",
    max_timeout_seconds: 300,
    timeout_ms: 15000,
    chains: {
      base: {
        asset: ASSET_BASE,
        decimals: 6,
        extra: { name: "USD Coin", version: "2" },
        rpc_url: RPC_URL,
      },
      base_sepolia: {
        asset: ASSET_SEPOLIA,
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
          // Two token-access sections at/above the 0.10 threshold.
          "/private/**": { amount: "0.10", currency: "USDC", chain: "base" },
          "/premium/**": { amount: "0.10", currency: "USDC", chain: "base" },
          // Per-fetch, below the threshold.
          "/testnet/**": { amount: "0.0010", currency: "USDC", chain: "base_sepolia" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base", "base_sepolia"],
        accepted_currencies: ["USDC"],
      },
      auth: {
        endpoint: "/mdf/auth",
        token_ttl_seconds: 86400,
        price_threshold: "0.10",
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      facilitator,
    } as LoadedConfig["config"],
  };
}

// ---------------------------------------------------------------------------
// Payment header + facilitator mock
// ---------------------------------------------------------------------------

let nonceSeq = 0;
function nextNonce(): string {
  nonceSeq++;
  return "0x" + nonceSeq.toString(16).padStart(64, "0");
}

function xPayment(over: { network?: string; value?: string; to?: string } = {}): string {
  const envelope = {
    x402Version: 1,
    scheme: "exact",
    network: over.network ?? "base",
    payload: {
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: PAYER,
        to: over.to ?? WALLET,
        value: over.value ?? "100000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: nextNonce(),
      },
    },
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

const realFetch = globalThis.fetch;
interface Call {
  url: string;
  method: string;
}
let calls: Call[] = [];
let verifyResp: { status: number; body: string };
let verifyThrows = false;
let settleResp: { status: number; body: string };

function resetMock() {
  calls = [];
  verifyThrows = false;
  verifyResp = { status: 200, body: JSON.stringify({ isValid: true, payer: PAYER }) };
  settleResp = {
    status: 200,
    body: JSON.stringify({ success: true, payer: PAYER, transaction: SETTLE_TX }),
  };
}

installFetchMock();
function installFetchMock() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: unknown,
    init?: { method?: string }
  ) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET" });
    const mk = (r: { status: number; body: string }) =>
      new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
    if (u.includes(FAC_URL + "/verify")) {
      if (verifyThrows) throw new Error("fetch failed: ECONNREFUSED");
      return mk(verifyResp);
    }
    if (u.includes(FAC_URL + "/settle")) return mk(settleResp);
    if (u.includes(RPC_URL)) {
      return mk({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "1" }) });
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

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function postToken(
  endpoint: string,
  opts: { body?: unknown; payment?: string; rawBody?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.payment) headers["x-payment"] = opts.payment;
  return mute(() =>
    handleRequest(
      new Request(`https://example.com${endpoint}`, {
        method: "POST",
        headers,
        body: opts.rawBody ?? JSON.stringify(opts.body ?? { resource: "/private/internals" }),
      }),
      makeLoaded()
    )
  );
}

function getWithToken(urlPath: string, token: string): Promise<Response> {
  return mute(() =>
    handleRequest(
      new Request(`https://example.com${urlPath}`, {
        headers: { accept: "text/markdown", authorization: `Bearer ${token}` },
      }),
      makeLoaded()
    )
  );
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("mdf-server token-issuance payment gate (0.2.9)");
console.log("--------------------------------------------------");

await test("unpaid POST /mdf/auth → 402 offer, no token", async () => {
  resetMock();
  const res = await postToken("/mdf/auth");
  assertEquals(res.status, 402, "expected 402");
  assertEquals(res.headers.get("cache-control"), "no-store", "402 must be no-store");
  const body = await json(res);
  assert(!("token" in body), "no token may be issued without payment");
  assert(typeof body.payment === "object" && body.payment !== null, "expected the normal offer");
  const payment = body.payment as Record<string, unknown>;
  assertEquals(payment.amount, "0.10", "offer must carry the section price");
  assertEquals(callsTo("/verify").length, 0, "no payment header means no facilitator call");
});

await test("unpaid POST /mdf/pay → 402, no token (alias is gated too)", async () => {
  resetMock();
  const res = await postToken("/mdf/pay");
  assertEquals(res.status, 402, "expected 402");
  const body = await json(res);
  assert(!("token" in body), "no token may be issued without payment");
});

await test("GET /mdf/auth → 405", async () => {
  const res = await mute(() =>
    handleRequest(new Request("https://example.com/mdf/auth"), makeLoaded())
  );
  assertEquals(res.status, 405, "only POST issues tokens");
});

await test("paid POST /mdf/auth → token scoped to the paid section", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  assertEquals(res.status, 200, "a paid request must mint a token");
  assertEquals(res.headers.get("cache-control"), "no-store", "token response must be no-store");
  const body = await json(res);
  const token = body.token;
  assert(typeof token === "string" && token.length > 0, "expected a token string");
  assertEquals(callsTo("/verify").length, 1, "payment must be verified");
  assertEquals(callsTo("/settle").length, 1, "payment must be settled");

  const inScope = validateToken(`Bearer ${token}`, "/private/internals");
  assertEquals(inScope.ok, true, "token must authorise the paid section");
  if (inScope.ok) assertEquals(inScope.record.pathScope, "/private/", "scope is the paid section");
});

await test("a token does not authorise another section", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  const token = (await json(res)).token as string;

  const crossSection = validateToken(`Bearer ${token}`, "/premium/deep-dive");
  assertEquals(crossSection.ok, false, "must not authorise a sibling token section");

  const crossFetch = await getWithToken("/premium/deep-dive", token);
  assertEquals(crossFetch.status, 402, "cross-section fetch must be refused with 402");
});

await test("the issued token serves its own section (end to end)", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  const token = (await json(res)).token as string;

  const content = await getWithToken("/private/internals", token);
  assertEquals(content.status, 200, "token must serve the paid section");
  assertEquals(content.headers.get("content-type"), "text/markdown; charset=utf-8", "markdown out");
});

await test("a replayed (already settled) payment → 402, no token, no settle", async () => {
  resetMock();
  verifyResp = {
    status: 500,
    body: JSON.stringify({
      isValid: false,
      invalidReason: "unexpected_error",
      invalidReasonDetails: "…FiatTokenV2: authorization is used or canceled…",
    }),
  };
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  assertEquals(res.status, 402, "a used nonce must not mint a token");
  const body = await json(res);
  assert(!("token" in body), "no token on a replayed payment");
  assertEquals(callsTo("/settle").length, 0, "a rejected payment must never reach /settle");
});

await test("facilitator failure → 503, no token", async () => {
  resetMock();
  verifyThrows = true;
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  assertEquals(res.status, 503, "facilitator outage is not a payment denial");
  const body = await json(res);
  assert(!("token" in body), "no token on a facilitator failure");
});

await test("a per-fetch section → 400, no token, nothing settled", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", {
    body: { resource: "/testnet/intro" },
    payment: xPayment({ network: "base-sepolia", value: "1000" }),
  });
  assertEquals(res.status, 400, "tokens are only for token-access sections");
  const body = await json(res);
  assert(!("token" in body), "no token for a per-fetch section");
  assertEquals(calls.length, 0, "a refused target must not touch the facilitator");
});

await test("missing resource → 400", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { body: {}, payment: xPayment() });
  assertEquals(res.status, 400, "resource is required");
});

await test("oversized body → 413", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", {
    rawBody: JSON.stringify({ resource: "/private/internals", pad: "x".repeat(70 * 1024) }),
    payment: xPayment(),
  });
  assertEquals(res.status, 413, "body limit is enforced before any work");
});

await test("client-asserted txHash/from in the body are ignored", async () => {
  resetMock();
  const fakeTx = "0x" + "ee".repeat(32);
  const res = await postToken("/mdf/auth", {
    body: {
      resource: "/private/internals",
      txHash: fakeTx,
      from: "0x0000000000000000000000000000000000000001",
    },
    payment: xPayment(),
  });
  assertEquals(res.status, 200, "the payment header is the only evidence needed");

  // The token record must carry values derived from the verified payment.
  const token = (await json(res)).token as string;
  const validated = validateToken(`Bearer ${token}`, "/private/internals");
  assert(validated.ok, "token must validate");
  if (!validated.ok) return;
  assertEquals(validated.record.issuedTo, PAYER, "issuer is the verified payer, not the body");
  assertEquals(validated.record.txHash, SETTLE_TX, "tx hash is the facilitator settlement");
  assert(validated.record.txHash !== fakeTx, "a client-asserted txHash must never be recorded");
});

await test("a token minted for one section cannot be forged for another by reusing the id", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { payment: xPayment() });
  const token = (await json(res)).token as string;
  const [id, secret] = token.split(".");

  // Same id, wrong secret: the timing-safe secret check must reject it.
  const wrongSecret = validateToken(`Bearer ${id}.${"00".repeat(32)}`, "/private/internals");
  assertEquals(wrongSecret.ok, false, "a wrong secret must not be accepted");

  // Same id, secret of the wrong length: rejected before comparison.
  const shortSecret = validateToken(`Bearer ${id}.${secret.slice(0, 10)}`, "/private/internals");
  assertEquals(shortSecret.ok, false, "a malformed secret must not be accepted");
});

restoreFetch();
tokenStore.stopSweep();

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
