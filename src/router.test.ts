/**
 * Router regression test — 0.3.x (x402 v2, multi-rail, token store)
 *
 * The ordering bug this suite was born for is still the first thing it asserts:
 * the router runs the content-existence check before any pricing, so an unknown
 * path under a non-zero-priced section is 404, never a payable 402.
 *
 * Everything else pins the 0.3.0 swap-over:
 *
 *   - `PAYMENT-SIGNATURE` is the only payment header read; `X-PAYMENT` is inert
 *     and appears in the attempt log by name only;
 *   - the 402 body and `PAYMENT-REQUIRED` header are the same bytes, are
 *     `no-store`, carry `X-MDF-Version: 1` and never a `WWW-Authenticate`;
 *   - a degraded rail is omitted and the others are unaffected; a route with no
 *     surviving rail is 503 + `Retry-After`, never a 402 with an empty accepts;
 *   - the token endpoint mints only against a verified payment in the same
 *     request, on the shared store, and never for a per-fetch section;
 *   - a paid 200 carries `PAYMENT-RESPONSE`.
 *
 * Everything runs against a mocked facilitator (no network, no wallet).
 *
 * Run with: bun run src/router.test.ts
 */

import { join } from "path";
import { handleRequest } from "./router.ts";
import { FacilitatorPool } from "./payment/facilitator.ts";
import { LnbtcGate } from "./payment/lnbtc/availability.ts";
import { MemoryTokenStore, validateToken } from "./auth/token-store.ts";
import type { LoadedConfig, LnbtcRuntime } from "./config/loader.ts";

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

const CONTENT_DIR = join(import.meta.dir, "..", "content");
const FAC_URL = "http://facilitator.example";
const RPC_URL = "https://rpc.example";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";
const PAYER = "0xBB12e7F39F734aD962c50dDbE91F73557Bf9A93B";
const SETTLE_TX = "0x" + "ab".repeat(32);
const NODE = "02" + "cd".repeat(32);

const rail = (amount: string, network = "eip155:8453", asset = USDC) => ({
  scheme: "exact",
  network,
  asset,
  amount,
});

function makeLnbtc(mode: "available" | "rate_limited" | "degraded"): LnbtcRuntime {
  const available = mode !== "degraded";
  const gate = new LnbtcGate({ enabled: true });
  gate.applyCheck(
    available
      ? { status: "pass", methods: ["make_invoice"], unverified: false }
      : { status: "unreachable", reason: "relay down" }
  );
  return {
    enabled: true,
    network: LNBTC,
    payeePubkey: NODE,
    client: {
      makeInvoice: async () => ({ invoice: "lnbc200n1p3minted", paymentHash: "aa".repeat(32) }),
    },
    gate,
    limiter: {
      tryTake: () =>
        mode === "rate_limited" ? { ok: false, retryAfterSeconds: 7 } : { ok: true },
    },
    replay: { claim: async () => "claimed", health: async () => "ok", close: () => {} },
    invoiceExpirySeconds: 300,
    breaker: { initialBackoffMs: 5000, maxBackoffMs: 300000 },
    breakerRuntime: {
      retryAfterSeconds: () => 7,
      snapshot: () => ({
        status: "degraded",
        since: new Date(0).toISOString(),
        category: "unreachable",
        next_retry: new Date(7000).toISOString(),
      }),
      stop: () => {},
    },
  } as unknown as LnbtcRuntime;
}

function makeLoaded(
  options: { lnbtc?: "available" | "rate_limited" | "degraded" | "disabled" } = {}
): LoadedConfig {
  const lnbtcMode = options.lnbtc ?? "degraded";
  return {
    contentDir: CONTENT_DIR,
    walletAddress: WALLET,
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: CONTENT_DIR, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { rails: [rail("100")] },
        sections: {
          "/": { rails: [] },
          "/docs/**": { rails: [] },
          "/micropayment/**": { rails: [rail("1000", LNBTC, "BTC")] },
          "/premium/**": { rails: [rail("10000")] },
          "/private/**": { rails: [rail("100000")], access: "token" },
          "/testnet/**": { rails: [rail("1000", "eip155:84532", USDC_SEPOLIA)] },
          "/showcase/**": { rails: [rail("20000"), rail("20000", LNBTC, "BTC")] },
        },
      },
      token_store: "memory",
      auth: { endpoint: "/mdf/auth", token_ttl_seconds: 86400 },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      payment: { max_timeout_seconds: 300 },
      server: { trusted_proxies: [] },
    } as unknown as LoadedConfig["config"],
    tokenStore: new MemoryTokenStore(),
    tokenStoreBackend: "memory",
    facilitator: { legs: [FAC_URL], timeoutMs: 1500, rpc: { "eip155:8453": RPC_URL } },
    pool: new FacilitatorPool({ legs: [FAC_URL], timeoutMs: 1500, rpc: { "eip155:8453": RPC_URL } }),
    replayStore: null,
    lnbtc: lnbtcMode === "disabled" ? null : makeLnbtc(lnbtcMode),
    valkey: null,
  } as LoadedConfig;
}

const loaded = makeLoaded();

async function request(
  path: string,
  init: RequestInit = {},
  config: LoadedConfig = loaded
): Promise<Response> {
  return mute(() => handleRequest(new Request(`https://example.com${path}`, init), config));
}

/** Capture the structured log lines a request emits. */
async function captureLogs(
  fn: () => Promise<Response>
): Promise<{ res: Response; lines: Array<Record<string, unknown>> }> {
  const lines: Array<Record<string, unknown>> = [];
  const realLog = console.log;
  console.log = (line: string) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") lines.push(parsed);
    } catch {
      lines.push({ raw: line });
    }
  };
  try {
    const res = await fn();
    return { res, lines };
  } finally {
    console.log = realLog;
  }
}

// ---------------------------------------------------------------------------
// Facilitator mock
// ---------------------------------------------------------------------------

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
    body: JSON.stringify({ success: true, payer: PAYER, transaction: SETTLE_TX, network: "eip155:8453" }),
  };
}

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
    return mk({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "1" }),
    });
  }
  throw new Error("unexpected fetch: " + u);
};

function callsTo(sub: string): Call[] {
  return calls.filter((c) => c.url.includes(sub));
}

// ---------------------------------------------------------------------------
// Payment header helpers
// ---------------------------------------------------------------------------

/** The configured 402 offer for a path, as JSON. */
async function offerFor(path: string): Promise<Record<string, unknown>> {
  const res = await request(path, { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 402, `expected a 402 offer for ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

let nonceSeq = 0;
function nextNonce(): string {
  nonceSeq++;
  return "0x" + nonceSeq.toString(16).padStart(64, "0");
}

/** A v2 PaymentPayload for one of the offer's `accepts[]` entries. */
function paymentFor(offer: Record<string, unknown>, index = 0): string {
  const accepted = (offer.accepts as Array<Record<string, unknown>>)[index];
  const payload = {
    x402Version: 2,
    accepted,
    payload: {
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: nextNonce(),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ---------------------------------------------------------------------------
// Existence before pricing
// ---------------------------------------------------------------------------

console.log("\nExistence before pricing\n");

await test("unknown path under a non-zero-priced section returns 404, not 402", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "unknown paid-section path must be 404");
  assert(
    !res.headers.get("content-type")?.includes("application/json"),
    "404 is not a 402 offer body"
  );
});

await test("unknown path falling to the non-zero default price returns 404, not 402", async () => {
  const res = await request("/totally/unknown/path", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "unknown default-priced path must be 404");
});

await test("unknown path under a free section still returns 404", async () => {
  const res = await request("/docs/nope", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "free-section unknown path must remain 404");
});

await test("404 honours markdown negotiation with a markdown body", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "status");
  assert(res.headers.get("content-type")?.includes("text/markdown") ?? false, "markdown 404");
  assert((await res.text()).startsWith("# 404"), "markdown 404 heading");
});

await test("unknown path with a browser Accept header returns HTML 404", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/html" } });
  assertEquals(res.status, 404, "status");
  assert(res.headers.get("content-type")?.includes("text/html") ?? false, "html 404");
});

console.log("\nMethods and existing resources\n");

await test("existing paid content without payment still returns 402", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 402, "real paid resource must still offer payment");
});

await test("existing free content returns 200", async () => {
  const res = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 200, "free content served");
});

await test("non-GET on an unknown content path is still 405, not 404", async () => {
  const res = await request("/premium/does-not-exist", { method: "POST" });
  assertEquals(res.status, 405, "POST to a content path is 405");
});

await test("non-GET on an existing content path is 405", async () => {
  const res = await request("/premium/deep-dive", { method: "DELETE" });
  assertEquals(res.status, 405, "DELETE is not a content method");
});

// ---------------------------------------------------------------------------
// The 402 itself
// ---------------------------------------------------------------------------

console.log("\n402 shape and headers\n");

await test("a 402 is no-store on every priced route and representation", async () => {
  for (const [path, accept] of [
    ["/premium/deep-dive", "text/markdown"],
    ["/premium/deep-dive", "text/html"],
    ["/testnet/intro", "text/markdown"],
  ] as const) {
    const res = await request(path, { headers: { Accept: accept } });
    assertEquals(res.status, 402, `status for ${path} (${accept})`);
    assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
  }
});

await test("PAYMENT-REQUIRED is the base64 of the body's exact bytes", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/markdown" } });
  const body = await res.text();
  const header = res.headers.get("payment-required");
  assert(!!header, "PAYMENT-REQUIRED present");
  assertEquals(
    Buffer.from(header as string, "base64").toString("utf8"),
    body,
    "header decodes to the body bytes"
  );
});

await test("a 402 carries X-MDF-Version: 1 and no WWW-Authenticate", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/markdown" } });
  assertEquals(res.headers.get("x-mdf-version"), "1", "protocol version header");
  assertEquals(res.headers.get("www-authenticate"), null, "no L402 challenge, ever");
});

await test("accepts[] carries the configured rail with payTo and the offer window", async () => {
  const body = await offerFor("/premium/deep-dive");
  const accepts = body.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 1, "one rail configured");
  assertEquals(accepts[0].scheme, "exact", "scheme");
  assertEquals(accepts[0].network, "eip155:8453", "network");
  assertEquals(accepts[0].amount, "10000", "atomic amount");
  assertEquals(accepts[0].asset, USDC, "asset");
  assertEquals(accepts[0].payTo, WALLET, "payTo is the configured wallet");
  assertEquals(accepts[0].maxTimeoutSeconds, 300, "offer window");
  const extra = accepts[0].extra as Record<string, unknown>;
  assertEquals(extra.name, "USD Coin", "EIP-712 name from the vendored table");
  assertEquals(extra.version, "2", "EIP-712 version from the vendored table");
});

await test("extensions.mdf.info carries the spec version, a summary and the schema", async () => {
  const body = await offerFor("/premium/deep-dive");
  const mdf = (body.extensions as { mdf: Record<string, unknown> }).mdf;
  const info = mdf.info as Record<string, unknown>;
  assertEquals(info.version, "0.3.1", "spec version");
  assert(typeof info.price_summary === "string" && (info.price_summary as string).includes("10000"), "summary states the atomic amount");
  assert(typeof info.expires_at === "string", "expires_at present");
  assert(!!mdf.schema, "embedded schema present");
});

await test("the body is a v2 PaymentRequired: no v1 fields survive", async () => {
  const body = await offerFor("/premium/deep-dive");
  assertEquals(body.x402Version, 2, "x402Version");
  assertEquals(body.payment, undefined, "no v1 payment object");
  assertEquals(body.reason, undefined, "no v1 reason field");
});

// ---------------------------------------------------------------------------
// Requests: PAYMENT-SIGNATURE only
// ---------------------------------------------------------------------------

console.log("\nRequest headers\n");

await test("an X-PAYMENT-only request is unpaid, and logged by header name", async () => {
  resetMock();
  const { res, lines } = await captureLogs(() =>
    handleRequest(
      new Request("https://example.com/premium/deep-dive", {
        headers: { Accept: "text/markdown", "X-PAYMENT": "not-base64-not-json" },
      }),
      makeLoaded()
    )
  );
  assertEquals(res.status, 402, "X-PAYMENT buys nothing under the v2 hard cut");
  const attempt = lines.find((l) => l.event === "payment_attempt");
  assert(!!attempt, "an attempt line was emitted");
  assertEquals(attempt!.payment_header, "X-PAYMENT", "header named, value never logged");
  assert(!JSON.stringify(attempt).includes("not-base64"), "the header value is not logged");
});

await test("an oversized PAYMENT-SIGNATURE is refused before decoding", async () => {
  resetMock();
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": "A".repeat(20000) },
  });
  assertEquals(res.status, 402, "oversized header is an unpaid request");
  const body = (await res.json()) as { error: string };
  assertEquals(body.error, "invalid_payment", "coarse class");
  assertEquals(calls.length, 0, "nothing was sent upstream");
});

await test("a malformed PAYMENT-SIGNATURE is a coarse invalid_payment", async () => {
  resetMock();
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": "!!not base64!!" },
  });
  assertEquals(res.status, 402, "status");
  assertEquals(((await res.json()) as { error: string }).error, "invalid_payment", "class");
  assertEquals(calls.length, 0, "no upstream call");
});

await test("a v1-shaped payroll is not silently upgraded", async () => {
  resetMock();
  const envelope = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: {} })
  ).toString("base64");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": envelope },
  });
  assertEquals(res.status, 402, "v1 payload is unpaid");
  assertEquals(((await res.json()) as { error: string }).error, "invalid_payment", "class");
});

await test("a payment for the wrong amount is refused as wrong_amount, with no settle", async () => {
  resetMock();
  const offer = await offerFor("/premium/deep-dive");
  const accepted = { ...(offer.accepts as Array<Record<string, unknown>>)[0], amount: "1" };
  const envelope = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      payload: { signature: "0x00", authorization: { from: PAYER, nonce: nextNonce() } },
    })
  ).toString("base64");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": envelope },
  });
  assertEquals(res.status, 402, "status");
  assertEquals(((await res.json()) as { error: string }).error, "wrong_amount", "class");
  assertEquals(calls.length, 0, "never reached the facilitator");
});

// ---------------------------------------------------------------------------
// Rails: degradation and omission
// ---------------------------------------------------------------------------

console.log("\nRails\n");

await test("a dual-rail route offers both rails", async () => {
  const available = makeLoaded({ lnbtc: "available" });
  const res = await request("/showcase/dual-rail", { headers: { Accept: "text/markdown" } }, available);
  const offer = (await res.json()) as Record<string, unknown>;
  const accepts = offer.accepts as Array<Record<string, unknown>>;
  assertEquals(accepts.length, 2, "two rails");
  assertEquals(accepts[0].network, "eip155:8453", "config order preserved");
  assertEquals(accepts[1].network, LNBTC, "lnbtc second");
  const summary = ((offer.extensions as { mdf: { info: { price_summary: string } } }).mdf.info
    .price_summary);
  assert(summary.includes("20000 msat"), `summary must state the lnbtc amount: ${summary}`);
});

await test("a degraded lnbtc rail is omitted and eip155 is unaffected", async () => {
  const offer = await offerFor("/showcase/dual-rail");
  const accepts = offer.accepts as Array<Record<string, unknown>>;
  // The fixture's lnbtc gate starts degraded.
  assertEquals(accepts.length, 1, "only the eip155 rail survives");
  assertEquals(accepts[0].network, "eip155:8453", "unchanged");
});

await test("an lnbtc-only route with a degraded rail is 503 + Retry-After, not an empty 402", async () => {
  const res = await request("/micropayment/intro", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 503, "no rail can be offered");
  assertEquals(res.headers.get("cache-control"), "no-store", "no-store");
  assertEquals(res.headers.get("retry-after"), "7", "the breaker's next probe is the hint");
});

await test("an exhausted mint budget omits the lnbtc rail without erroring", async () => {
  const config = makeLoaded({ lnbtc: "rate_limited" });
  const showcase = await request("/showcase/dual-rail", { headers: { Accept: "text/markdown" } }, config);
  assertEquals(showcase.status, 402, "the eip155 rail still offers");
  const accepts = ((await showcase.json()) as { accepts: unknown[] }).accepts;
  assertEquals(accepts.length, 1, "lnbtc omitted by the budget");

  const onlyLnbtc = await request("/micropayment/intro", { headers: { Accept: "text/markdown" } }, config);
  assertEquals(onlyLnbtc.status, 503, "an lnbtc-only route has nothing left to offer");
  assert(
    Number(onlyLnbtc.headers.get("retry-after") ?? 0) > 0,
    "a retry hint is carried when the only reason was the budget"
  );
});

// ---------------------------------------------------------------------------
// Caching safety on the payment path
// ---------------------------------------------------------------------------

console.log("\nConditional requests\n");

await test("unpaid If-None-Match on a priced route returns 402, not 304", async () => {
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "If-None-Match": "*" },
  });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("free 200 keeps no-cache and its validators, and still 304s", async () => {
  const first = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  assertEquals(first.status, 200, "status");
  assertEquals(first.headers.get("cache-control"), "no-cache", "free cache-control");
  assert(!!first.headers.get("etag"), "free ETag present");
  assert(!!first.headers.get("last-modified"), "free Last-Modified present");

  const second = await request("/docs/getting-started", {
    headers: { Accept: "text/markdown", "If-None-Match": first.headers.get("etag") ?? "" },
  });
  assertEquals(second.status, 304, "free conditional 304");
});

await test("HEAD carries Vary: Accept and a representation ETag", async () => {
  const res = await request("/docs/getting-started", {
    method: "HEAD",
    headers: { Accept: "text/markdown" },
  });
  assertEquals(res.status, 200, "HEAD status");
  assertEquals(res.headers.get("vary"), "Accept", "HEAD Vary");
  assert(!!res.headers.get("etag"), "HEAD ETag");
});

await test("cross-representation conditional request does not 304 via the router", async () => {
  const md = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  const mdEtag = md.headers.get("etag") ?? "";
  const cross = await request("/docs/getting-started", {
    headers: { Accept: "text/html", "If-None-Match": mdEtag },
  });
  assertEquals(cross.status, 200, "HTML request with markdown ETag must be 200");
});

// ---------------------------------------------------------------------------
// The paid path (mocked facilitator)
// ---------------------------------------------------------------------------

console.log("\nPaid path\n");

await test("a verified and settled payment serves the content with PAYMENT-RESPONSE", async () => {
  resetMock();
  const offer = await offerFor("/premium/deep-dive");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": paymentFor(offer) },
  });
  assertEquals(res.status, 200, "paid request served");
  assertEquals(callsTo("/verify").length, 1, "verify called once");
  assertEquals(callsTo("/settle").length, 1, "settle called once");

  const header = res.headers.get("payment-response");
  assert(!!header, "PAYMENT-RESPONSE present");
  const decoded = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
  assertEquals(decoded.success, true, "success");
  assertEquals(decoded.transaction, SETTLE_TX, "settlement tx");
  assertEquals(decoded.network, "eip155:8453", "network");
  assertEquals(decoded.payer, PAYER, "payer");
  assert((await res.text()).includes("Deep Dive"), "content body served");
});

await test("a structured /verify denial is a 402 whatever the HTTP status, and never settles", async () => {
  resetMock();
  verifyResp = {
    status: 500,
    body: JSON.stringify({
      isValid: false,
      invalidReason: "unexpected_error",
      invalidReasonDetails: "…FiatTokenV2: authorization is used or canceled…",
    }),
  };
  const offer = await offerFor("/premium/deep-dive");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": paymentFor(offer) },
  });
  assertEquals(res.status, 402, "a used nonce is a denial");
  assertEquals(callsTo("/settle").length, 0, "a rejected payment must never reach /settle");
  const body = (await res.json()) as { error: string };
  assert(!JSON.stringify(body).includes("FiatTokenV2"), "upstream detail never reaches the wire");
  assert(!JSON.stringify(body).includes("authorization is used"), "no revert text");
});

await test("a facilitator outage is a 503, not a payment denial", async () => {
  resetMock();
  verifyThrows = true;
  const offer = await offerFor("/premium/deep-dive");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": paymentFor(offer) },
  });
  assertEquals(res.status, 503, "outage is not a denial");
});

await test("a settle error that cannot be confirmed on-chain fails closed with 503", async () => {
  resetMock();
  settleResp = {
    status: 200,
    body: JSON.stringify({ success: false, errorReason: "unexpected_error" }),
  };
  const offer = await offerFor("/premium/deep-dive");
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "PAYMENT-SIGNATURE": paymentFor(offer) },
  });
  assertEquals(res.status, 503, "unconfirmed settlement must not serve");
});

// ---------------------------------------------------------------------------
// Token tier
// ---------------------------------------------------------------------------

console.log("\nToken tier\n");

function postToken(
  endpoint: string,
  opts: { body?: unknown; payment?: string; rawBody?: string; config?: LoadedConfig } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.payment) headers["PAYMENT-SIGNATURE"] = opts.payment;
  return mute(() =>
    handleRequest(
      new Request(`https://example.com${endpoint}`, {
        method: "POST",
        headers,
        body: opts.rawBody ?? JSON.stringify(opts.body ?? { resource: "/private/internals" }),
      }),
      opts.config ?? makeLoaded()
    )
  );
}

await test("unpaid POST /mdf/auth → 402 offer, no token", async () => {
  resetMock();
  const res = await postToken("/mdf/auth");
  assertEquals(res.status, 402, "expected 402");
  const body = (await res.json()) as Record<string, unknown>;
  assert(!("token" in body), "no token may be issued without payment");
  assertEquals(callsTo("/verify").length, 0, "no payment header means no facilitator call");
});

await test("unpaid POST /mdf/pay → 402, no token (alias is gated too)", async () => {
  resetMock();
  const res = await postToken("/mdf/pay");
  assertEquals(res.status, 402, "expected 402");
  assert(!("token" in (await res.json())), "no token");
});

await test("GET /mdf/auth → 405", async () => {
  const res = await request("/mdf/auth");
  assertEquals(res.status, 405, "only POST issues tokens");
});

await test("a paid POST /mdf/auth mints a token scoped to the section, with PAYMENT-RESPONSE", async () => {
  resetMock();
  const config = makeLoaded();
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  const res = await postToken("/mdf/auth", { payment: paymentFor(offer), config });
  assertEquals(res.status, 200, "a paid request must mint a token");
  assertEquals(res.headers.get("cache-control"), "no-store", "token response must be no-store");
  assert(!!res.headers.get("payment-response"), "token issuance carries PAYMENT-RESPONSE");

  const body = (await res.json()) as { token: string };
  assert(typeof body.token === "string" && body.token.length > 0, "token string");

  const validated = await validateToken(config.tokenStore, `Bearer ${body.token}`, "/private/internals");
  assertEquals(validated.ok, true, "token authorises the paid section");
  if (validated.ok) {
    assertEquals(validated.record.pathScope, "/private/", "scope is the paid section");
    assertEquals(validated.record.issuedTo, PAYER, "issuer is the verified payer");
    assertEquals(validated.record.txHash, SETTLE_TX, "tx hash is the facilitator settlement");
  }
});

await test("the issued token serves its own section, and only its own section", async () => {
  resetMock();
  const config = makeLoaded();
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  const token = ((await (await postToken("/mdf/auth", { payment: paymentFor(offer), config })).json()) as {
    token: string;
  }).token;

  const own = await request(
    "/private/internals",
    { headers: { Accept: "text/markdown", Authorization: `Bearer ${token}` } },
    config
  );
  assertEquals(own.status, 200, "token must serve the paid section");
  assertEquals(own.headers.get("payment-response"), null, "a token fetch is not a new settlement");

  const cross = await request(
    "/premium/deep-dive",
    { headers: { Accept: "text/markdown", Authorization: `Bearer ${token}` } },
    config
  );
  assertEquals(cross.status, 402, "a token must not authorise a sibling section");
});

await test("a wrong secret, or the same id with a short secret, is refused", async () => {
  resetMock();
  const config = makeLoaded();
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  const token = ((await (await postToken("/mdf/auth", { payment: paymentFor(offer), config })).json()) as {
    token: string;
  }).token;
  const [id, secret] = token.split(".");

  const wrong = await validateToken(config.tokenStore, `Bearer ${id}.${"00".repeat(32)}`, "/private/internals");
  assertEquals(wrong.ok, false, "wrong secret rejected");
  const short = await validateToken(config.tokenStore, `Bearer ${id}.${secret.slice(0, 10)}`, "/private/internals");
  assertEquals(short.ok, false, "malformed secret rejected");
});

await test("a replayed payment mints no token and settles nothing", async () => {
  resetMock();
  verifyResp = {
    status: 500,
    body: JSON.stringify({ isValid: false, invalidReason: "unexpected_error" }),
  };
  const config = makeLoaded();
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  // The offer above already spent one verify: reset the counter of interest.
  calls = [];
  const res = await postToken("/mdf/auth", { payment: paymentFor(offer), config });
  assertEquals(res.status, 402, "a used nonce must not mint a token");
  assert(!("token" in (await res.json())), "no token on a replayed payment");
  assertEquals(callsTo("/settle").length, 0, "no settle");
});

await test("a per-fetch section → 400, no token, nothing settled", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { body: { resource: "/testnet/intro" } });
  assertEquals(res.status, 400, "tokens are only for token-access sections");
  assertEquals(calls.length, 0, "a refused target must not touch the facilitator");
});

await test("missing resource → 400", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", { body: {} });
  assertEquals(res.status, 400, "resource is required");
});

await test("oversized body → 413", async () => {
  resetMock();
  const res = await postToken("/mdf/auth", {
    rawBody: JSON.stringify({ resource: "/private/internals", pad: "x".repeat(70 * 1024) }),
  });
  assertEquals(res.status, 413, "body limit is enforced before any work");
});

await test("a client-asserted txHash/from in the body is ignored", async () => {
  resetMock();
  const config = makeLoaded();
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  const fakeTx = "0x" + "ee".repeat(32);
  const res = await postToken("/mdf/auth", {
    body: { resource: "/private/internals", txHash: fakeTx, from: "0x" + "0".repeat(40) },
    payment: paymentFor(offer),
    config,
  });
  assertEquals(res.status, 200, "the payment header is the only evidence needed");

  const token = ((await res.json()) as { token: string }).token;
  const validated = await validateToken(config.tokenStore, `Bearer ${token}`, "/private/internals");
  assert(validated.ok, "token validates");
  if (validated.ok) {
    assertEquals(validated.record.txHash, SETTLE_TX, "recorded tx is the facilitator's");
    assert(validated.record.txHash !== fakeTx, "a client-asserted txHash is never recorded");
  }
});

await test("a store that fails its probe is refused before any payment is settled", async () => {
  resetMock();
  const config = makeLoaded();
  (config as { tokenStore: unknown }).tokenStore = {
    put: async () => true,
    get: async () => null,
    delete: async () => {},
    health: async () => "unavailable",
    close: () => {},
  };
  const res = await postToken("/mdf/auth", { config });
  assertEquals(res.status, 503, "unavailable store is a 503");
  assertEquals(calls.length, 0, "no verify, no settle — the payer keeps their money");
});

await test("an unreachable token store denies with 503, never a token", async () => {
  resetMock();
  const config = makeLoaded();
  (config as { tokenStore: unknown }).tokenStore = {
    put: async () => false,
    get: async () => null,
    delete: async () => {},
    health: async () => "ok",
    close: () => {},
  };
  const offer = (await (await postToken("/mdf/auth", { config })).json()) as Record<string, unknown>;
  const res = await postToken("/mdf/auth", { payment: paymentFor(offer), config });
  assertEquals(res.status, 503, "fail closed when the store refuses the write");
  assert(!("token" in (await res.json())), "no token");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

(globalThis as unknown as { fetch: unknown }).fetch = realFetch;

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
