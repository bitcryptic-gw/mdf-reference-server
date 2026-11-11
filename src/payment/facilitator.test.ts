/**
 * v2 facilitator client — the #52 contract, carried into 0.3.0.
 *
 * What is asserted here is the boundary that took a live defect to learn
 * (0.2.8, #52): a payment denial and a facilitator outage must never be
 * confused, approval must require a `/settle` in this request, and the one
 * on-chain recovery must be bound to the exact `(from, nonce)` `/verify`
 * accepted. v2 adds `settlement_pending`, which is retried exactly once.
 *
 * Everything runs against a mocked fetch — no network, no wallet, no RPC.
 *
 * Run with: bun run src/payment/facilitator.test.ts
 */

import {
  confirmSettlementOnChain,
  facilitatorSettle,
  facilitatorSupports,
  facilitatorVerify,
  type Eip155ChainInfo,
  type FacilitatorConfig,
  type VerifyRequest,
} from "./facilitator.ts";

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

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

function eq(a: unknown, b: unknown, m: string) {
  if (a !== b) {
    throw new Error(`${m}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
  }
}

const FAC: FacilitatorConfig = {
  url: "https://facilitator.example",
  timeoutMs: 2000,
  rpc: {},
};

const CHAIN: Eip155ChainInfo = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  rpcUrl: "https://rpc.example",
};

const PAYER = "0x6456BCa6d602DcCE6871BCd760Af0E920137b81F";
const NONCE = "0x" + "07".repeat(32);

function request(): VerifyRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: CHAIN.asset,
        payTo: "0xa7D911138322aF8823642beA2b174dFaC2725fB7",
        maxTimeoutSeconds: 300,
      },
      payload: {
        signature: "0x" + "cd".repeat(65),
        authorization: {
          from: PAYER,
          to: "0xa7D911138322aF8823642beA2b174dFaC2725fB7",
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: NONCE,
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: CHAIN.asset,
      payTo: "0xa7D911138322aF8823642beA2b174dFaC2725fB7",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body?: unknown }> = [];
let verify: { status: number; body: unknown } | "throw";
let settle: Array<{ status: number; body: unknown }> = [];
let rpc: { result?: unknown } | "throw" = { result: "0x" + "0".repeat(63) + "1" };
/** Receipt responses consumed per `eth_getTransactionReceipt` call; null = not found. */
let receipts: Array<{ status: string } | null> = [];

function reset() {
  calls = [];
  verify = { status: 200, body: { isValid: true, payer: PAYER } };
  settle = [{ status: 200, body: { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532", payer: PAYER } }];
  rpc = { result: "0x" + "0".repeat(63) + "1" };
  receipts = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body });
    const mk = (r: { status: number; body: unknown }) =>
      new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });

    if (u.endsWith("/verify")) {
      if (verify === "throw") throw new Error("fetch failed: ECONNREFUSED");
      return mk(verify);
    }
    if (u.endsWith("/settle")) {
      const next = settle.shift() ?? { status: 200, body: { success: false, errorReason: "exhausted" } };
      return mk(next);
    }
    if (u.endsWith("/supported")) {
      return mk({ status: 200, body: { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }] } });
    }
    if (u.includes("rpc.example")) {
      if (rpc === "throw") throw new Error("RPC timeout");
      const call = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (call.method === "eth_getTransactionReceipt") {
        const next = receipts.length > 0 ? receipts.shift()! : null;
        return mk({ status: 200, body: { jsonrpc: "2.0", id: 1, result: next } });
      }
      return mk({ status: 200, body: { jsonrpc: "2.0", id: 1, ...rpc } });
    }
    throw new Error("unexpected fetch " + u);
  };
}

function callsTo(sub: string) {
  return calls.filter((c) => c.url.includes(sub));
}

async function withMutedLogs<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const err = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = err;
  }
}

console.log("mdf-server v2 facilitator client");
console.log("--------------------------------------------------");

await test("a valid /verify returns the authorization it saw", async () => {
  reset();
  const r = await facilitatorVerify(FAC, request());
  eq(r.ok, true, "valid");
  if (r.ok) {
    eq(r.payer, PAYER, "payer");
    eq(r.authorization.from, PAYER, "from captured");
    eq(r.authorization.nonce, NONCE, "nonce captured");
  }
  eq(callsTo("/verify").length, 1, "one call");
});

await test("a structured denial is a denial at HTTP 400 and HTTP 500 alike", async () => {
  for (const status of [400, 500]) {
    reset();
    verify = { status, body: { isValid: false, invalidReason: "invalid_exact_evm_nonce_already_used" } };
    const r = await facilitatorVerify(FAC, request());
    eq(r.ok, false, `HTTP ${status} with isValid:false must not be ok`);
    if (!r.ok) eq(r.kind, "invalid", "classified as a payment denial");
  }
});

await test("no structured verdict is an outage, never a denial", async () => {
  reset();
  verify = { status: 500, body: { error: "boom" } };
  const r = await facilitatorVerify(FAC, request());
  eq(r.ok, false, "not ok");
  if (!r.ok) eq(r.kind, "error", "outage");

  reset();
  verify = "throw";
  const r2 = await facilitatorVerify(FAC, request());
  eq(r2.ok, false, "not ok");
  if (!r2.ok) eq(r2.kind, "error", "unreachable is an outage");
});

await test("a valid /verify without an authorization is a facilitator inconsistency", async () => {
  reset();
  const req = request();
  delete (req.paymentPayload as { payload?: unknown }).payload;
  const r = await facilitatorVerify(FAC, req);
  eq(r.ok, false, "must not approve");
  if (!r.ok) eq(r.kind, "error", "treated as facilitator error, not a denial");
});

await test("/settle success carries the tx and network", async () => {
  reset();
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture must verify");
  const s = await facilitatorSettle(FAC, request(), CHAIN, v.authorization);
  eq(s.settled, true, "settled");
  if (s.settled) {
    eq(s.transaction, "0x" + "ab".repeat(32), "tx");
    eq(s.network, "eip155:84532", "network");
  }
});

await test("settlement_pending is never re-posted: the tx is confirmed on-chain instead", async () => {
  reset();
  settle = [
    {
      status: 200,
      body: { success: false, errorReason: "settlement_pending", transaction: "0x" + "cd".repeat(32) },
    },
  ];
  // First receipt poll misses, second shows success.
  receipts = [null, { status: "0x1" }];
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await facilitatorSettle(FAC, request(), CHAIN, v.authorization, { attempts: 3, intervalMs: 1 });
  eq(s.settled, true, "confirmed on-chain");
  eq(callsTo("/settle").length, 1, "exactly one /settle — a retry could hit the other leg and re-broadcast");
  assert(callsTo("rpc.example").length >= 2, "polled the receipt more than once");
});

await test("settlement_pending that never confirms fails closed, still without a retry", async () => {
  reset();
  settle = [
    {
      status: 200,
      body: { success: false, errorReason: "settlement_pending", transaction: "0x" + "cd".repeat(32) },
    },
  ];
  receipts = [null, null, null];
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await withMutedLogs(() =>
    facilitatorSettle(FAC, request(), CHAIN, v.authorization, { attempts: 3, intervalMs: 1 })
  );
  eq(s.settled, false, "unconfirmed is not settled");
  if (!s.settled) eq(s.kind, "error", "an infrastructure failure, not a denial");
  eq(callsTo("/settle").length, 1, "no second /settle");
});

await test("settlement_pending without a tx hash fails closed immediately", async () => {
  reset();
  settle = [{ status: 200, body: { success: false, errorReason: "settlement_pending" } }];
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await withMutedLogs(() =>
    facilitatorSettle(FAC, request(), CHAIN, v.authorization, { attempts: 2, intervalMs: 1 })
  );
  eq(s.settled, false, "nothing to confirm");
  eq(callsTo("rpc.example").length, 0, "no receipt poll without a hash");
  eq(callsTo("/settle").length, 1, "one attempt only");
});

await test("a settle error recovered on-chain is bound to the verified (from, nonce)", async () => {
  reset();
  settle = [{ status: 500, body: { success: false, errorReason: "unexpected_error" } }];
  rpc = { result: "0x" + "0".repeat(63) + "1" }; // used
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await facilitatorSettle(FAC, request(), CHAIN, v.authorization);
  eq(s.settled, true, "recovered");

  const rpcCall = callsTo("rpc.example").at(-1);
  const body = JSON.parse(String(rpcCall?.body)) as { params: Array<{ data: string }> };
  const data = body.params[0].data;
  eq(data.slice(0, 10), "0xe94a0102", "authorizationState selector");
  assert(data.includes(PAYER.slice(2).toLowerCase()), "encodes the verified from");
  assert(data.includes(NONCE.slice(2)), "encodes the verified nonce");
});

await test("a settle error that is not on-chain settled fails closed", async () => {
  reset();
  settle = [{ status: 500, body: { success: false, errorReason: "invalid_exact_evm_transaction_failed" } }];
  rpc = { result: "0x" + "0".repeat(64) };
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await withMutedLogs(() => facilitatorSettle(FAC, request(), CHAIN, v.authorization));
  eq(s.settled, false, "not settled");
  if (!s.settled) eq(s.kind, "error", "an infrastructure failure, not a payment denial");
});

await test("an RPC failure during recovery fails closed", async () => {
  reset();
  settle = [{ status: 500, body: { success: false, errorReason: "unexpected_error" } }];
  rpc = "throw";
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await withMutedLogs(() => facilitatorSettle(FAC, request(), CHAIN, v.authorization));
  eq(s.settled, false, "unknown is not settled");
});

await test("no rpc configured means no recovery attempt", async () => {
  reset();
  settle = [{ status: 500, body: { success: false, errorReason: "unexpected_error" } }];
  const v = await facilitatorVerify(FAC, request());
  if (!v.ok) throw new Error("fixture");
  const s = await withMutedLogs(() =>
    facilitatorSettle(FAC, request(), { ...CHAIN, rpcUrl: undefined }, v.authorization)
  );
  eq(s.settled, false, "fails closed");
  eq(callsTo("rpc.example").length, 0, "no RPC call without a URL");
});

await test("/supported detects the network, and tolerates an unreachable facilitator", async () => {
  reset();
  eq(await facilitatorSupports(FAC, "eip155:84532"), true, "advertised");
  eq(await facilitatorSupports(FAC, "eip155:8453"), false, "not advertised");

  reset();
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  eq(await facilitatorSupports(FAC, "eip155:84532"), null, "unreachable is unknown");
});

await test("confirmSettlementOnChain reads a receipt before the nonce state", async () => {
  reset();
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body });
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_getTransactionReceipt") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "0x1" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) }), { status: 200 });
  };
  const r = await confirmSettlementOnChain(CHAIN, { txHash: "0x" + "ef".repeat(32), from: PAYER, nonce: NONCE });
  eq(r, "settled", "receipt status decides");
  eq(calls.length, 1, "the nonce state is not needed when a receipt exists");
});

(globalThis as unknown as { fetch: unknown }).fetch = realFetch;

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
