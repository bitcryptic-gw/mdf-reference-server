/**
 * Facilitator legs, per-request pinning, and payment-bound confirmation.
 *
 * Two properties are load-bearing and both are pinned here:
 *
 *   1. **Failover happens only before `/verify` is answered**, and `/verify` and
 *      `/settle` for one request use the same leg. A `/settle` that crossed legs
 *      cannot reconcile a pending settlement and may re-broadcast.
 *   2. **A receipt is not evidence by itself.** The hash comes from the
 *      facilitator, so acceptance requires a Transfer log matching the verified
 *      payer, payee and amount — or the consumed EIP-3009 nonce, which is inside
 *      the signature.
 *
 * Everything runs against a mocked fetch — no network, no wallet, no RPC.
 *
 * Run with: bun run src/payment/facilitator.test.ts
 */

import {
  FacilitatorPool,
  confirmSettlementOnChain,
  confirmSuccessfulTransfer,
  receiptHasMatchingTransfer,
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

const LEG_A = "http://mdf-facilitator-syd:8080";
const LEG_B = "http://mdf-facilitator-public:8080";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const PAYER = "0x6456BCa6d602DcCE6871BCd760Af0E920137b81F";
const NONCE = "0x" + "07".repeat(32);
const VALUE = "1000";

const CONFIG: FacilitatorConfig = { legs: [LEG_A, LEG_B], timeoutMs: 2000, rpc: {} };
const CHAIN: Eip155ChainInfo = { network: "eip155:84532", asset: ASSET, rpcUrl: "https://rpc.example" };

function request(): VerifyRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: VALUE,
        asset: ASSET,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
      },
      payload: {
        signature: "0x" + "cd".repeat(65),
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: VALUE,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: NONCE,
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:84532",
      amount: VALUE,
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock: per-leg behaviour, plus an RPC with a receipt queue
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body?: string }> = [];
let verifyBehaviour: Record<string, "ok" | "invalid" | "500" | "down"> = {};
let settleBehaviour: Record<string, { status: number; body: unknown } | "down"> = {};
let receipts: Array<{ status: string; logs: Array<Record<string, unknown>> } | null> = [];
let nonceUsed = false;

function reset() {
  calls = [];
  verifyBehaviour = { [LEG_A]: "ok", [LEG_B]: "ok" };
  settleBehaviour = {
    [LEG_A]: { status: 200, body: { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532", payer: PAYER } },
    [LEG_B]: { status: 200, body: { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532", payer: PAYER } },
  };
  receipts = [];
  nonceUsed = false;

  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body });
    const mk = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    for (const leg of [LEG_A, LEG_B]) {
      if (!u.startsWith(leg)) continue;
      if (u.endsWith("/verify")) {
        const b = verifyBehaviour[leg] ?? "ok";
        if (b === "down") throw new Error("fetch failed: ECONNREFUSED");
        if (b === "invalid") return mk(400, { isValid: false, invalidReason: "invalid_exact_evm_nonce_already_used" });
        if (b === "500") return mk(500, { error: "boom" });
        return mk(200, { isValid: true, payer: PAYER });
      }
      if (u.endsWith("/settle")) {
        const b = settleBehaviour[leg] ?? "down";
        if (b === "down") throw new Error("fetch failed: ECONNREFUSED");
        return mk(b.status, b.body);
      }
      if (u.endsWith("/supported")) {
        return mk(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }] });
      }
    }

    if (u.includes("rpc.example")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "eth_getTransactionReceipt") {
        const next = receipts.length > 0 ? receipts.shift()! : null;
        return mk(200, { jsonrpc: "2.0", id: 1, result: next });
      }
      if (body.method === "eth_call") {
        return mk(200, { jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + (nonceUsed ? "1" : "0") });
      }
    }
    throw new Error("unexpected fetch " + u);
  };
}

function callsTo(sub: string) {
  return calls.filter((c) => c.url.includes(sub));
}

function transferLog(over: { asset?: string; from?: string; to?: string; value?: string } = {}) {
  const pad = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
  return {
    address: over.asset ?? ASSET,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      pad(over.from ?? PAYER),
      pad(over.to ?? PAY_TO),
    ],
    data: "0x" + BigInt(over.value ?? VALUE).toString(16).padStart(64, "0"),
  };
}

async function muted<T>(fn: () => Promise<T>): Promise<T> {
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

console.log("mdf-server facilitator legs");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// Leg selection
// ---------------------------------------------------------------------------

await test("the first leg serves the request", async () => {
  reset();
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  eq(outcome.ok, true, "verified");
  eq(leg, LEG_A, "first leg pinned");
  eq(callsTo("mdf-facilitator-public").length, 0, "second leg untouched");
});

await test("failover happens on a transport error before /verify is answered", async () => {
  reset();
  verifyBehaviour[LEG_A] = "down";
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  eq(outcome.ok, true, "second leg verified");
  eq(leg, LEG_B, "pinned to the leg that answered");
  eq(callsTo("mdf-facilitator-syd").length, 1, "first leg tried once");
  eq(callsTo("mdf-facilitator-public").length, 1, "second leg tried once");
});

await test("no failover after a verdict — even a rejection stays on that leg", async () => {
  reset();
  verifyBehaviour[LEG_A] = "invalid";
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  eq(outcome.ok, false, "denied");
  if (!outcome.ok) eq(outcome.kind, "invalid", "a denial, not an outage");
  eq(leg, LEG_A, "pinned");
  eq(callsTo("mdf-facilitator-public").length, 0, "must not ask another leg to overrule a denial");
});

await test("no failover after an HTTP response with no verdict", async () => {
  reset();
  verifyBehaviour[LEG_A] = "500";
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  eq(outcome.ok, false, "not approved");
  if (!outcome.ok) eq(outcome.kind, "error", "outage");
  eq(leg, LEG_A, "the leg answered, so it stays pinned");
  eq(callsTo("mdf-facilitator-public").length, 0, "no failover");
});

await test("all legs down is an outage, not a denial", async () => {
  reset();
  verifyBehaviour[LEG_A] = "down";
  verifyBehaviour[LEG_B] = "down";
  const pool = new FacilitatorPool(CONFIG);
  const { outcome } = await pool.verify(request());
  eq(outcome.ok, false, "not approved");
  if (!outcome.ok) eq(outcome.kind, "error", "an unreachable pool is an outage");
  eq(callsTo("/verify").length, 2, "each leg tried once");
});

await test("/verify and /settle use the same leg within one request", async () => {
  reset();
  verifyBehaviour[LEG_A] = "down";
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture must verify");
  const settled = await pool.settle(leg, request(), CHAIN, outcome.authorization);
  eq(settled.settled, true, "settled");
  eq(callsTo("mdf-facilitator-public").filter((c) => c.url.endsWith("/settle")).length, 1, "settle on B");
  eq(callsTo("mdf-facilitator-syd").filter((c) => c.url.endsWith("/settle")).length, 0, "never settle on A");
});

await test("a settle never fails over, even when the pinned leg is down", async () => {
  reset();
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  settleBehaviour[LEG_A] = "down";
  const settled = await muted(() => pool.settle(leg, request(), CHAIN, outcome.authorization));
  eq(settled.settled, false, "an unreachable pinned leg is an outage");
  eq(callsTo("mdf-facilitator-public").length, 0, "no cross-leg settle");
});

// ---------------------------------------------------------------------------
// settlement_pending: one /settle, confirmed against the payment
// ---------------------------------------------------------------------------

function pendingOnLegA() {
  settleBehaviour[LEG_A] = {
    status: 200,
    body: { success: false, errorReason: "settlement_pending", transaction: "0x" + "cd".repeat(32) },
  };
}

await test("pending + a Transfer log matching the payment → settled, one /settle", async () => {
  reset();
  pendingOnLegA();
  receipts = [null, { status: "0x1", logs: [transferLog()] }];
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await pool.settle(leg, request(), CHAIN, outcome.authorization, { attempts: 3, intervalMs: 1 });
  eq(settled.settled, true, "confirmed");
  eq(callsTo("/settle").length, 1, "never re-posted");
});

await test("pending + a successful tx with an unrelated Transfer → 503", async () => {
  reset();
  pendingOnLegA();
  receipts = [{ status: "0x1", logs: [transferLog({ to: "0x" + "11".repeat(20) })] }];
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await muted(() => pool.settle(leg, request(), CHAIN, outcome.authorization, { attempts: 2, intervalMs: 1 }));
  eq(settled.settled, false, "an unrelated successful tx is not payment");
  if (!settled.settled) eq(settled.kind, "error", "fails closed");
});

await test("pending + the right Transfer but the wrong amount → 503", async () => {
  reset();
  pendingOnLegA();
  receipts = [{ status: "0x1", logs: [transferLog({ value: "999" })] }];
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await muted(() => pool.settle(leg, request(), CHAIN, outcome.authorization, { attempts: 2, intervalMs: 1 }));
  eq(settled.settled, false, "underpayment is not payment");
});

await test("pending + a matching nonce but an odd log shape → settled (AND/OR)", async () => {
  reset();
  pendingOnLegA();
  nonceUsed = true;
  receipts = [{ status: "0x1", logs: [] }];
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await pool.settle(leg, request(), CHAIN, outcome.authorization, { attempts: 2, intervalMs: 1 });
  eq(settled.settled, true, "the consumed nonce is inside the signature, so it proves the payment");
});

await test("pending + no receipt ever → 503", async () => {
  reset();
  pendingOnLegA();
  receipts = [null, null, null];
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await muted(() => pool.settle(leg, request(), CHAIN, outcome.authorization, { attempts: 3, intervalMs: 1 }));
  eq(settled.settled, false, "unconfirmed is not settled");
  eq(callsTo("/settle").length, 1, "still one /settle");
});

// ---------------------------------------------------------------------------
// Receipt parsing and the settle-error recovery
// ---------------------------------------------------------------------------

await test("receiptHasMatchingTransfer requires asset, from, to and value together", () => {
  const terms = { asset: ASSET, from: PAYER, to: PAY_TO, value: VALUE };
  assert(receiptHasMatchingTransfer([transferLog()], terms), "exact match");

  // Case-insensitivity: addresses arrive EIP-55 or lower-case depending on the node.
  assert(
    receiptHasMatchingTransfer([transferLog({ from: PAYER.toLowerCase(), to: PAY_TO.toLowerCase() })], terms),
    "case-insensitive"
  );

  assert(!receiptHasMatchingTransfer([transferLog({ asset: "0x" + "22".repeat(20) })], terms), "wrong token");
  assert(!receiptHasMatchingTransfer([transferLog({ from: "0x" + "33".repeat(20) })], terms), "wrong payer");
  assert(!receiptHasMatchingTransfer([transferLog({ value: "1001" })], terms), "wrong amount");
  assert(
    !receiptHasMatchingTransfer(
      [{ ...transferLog(), topics: [transferLog().topics[0], transferLog().topics[1]] }],
      terms
    ),
    "missing topic"
  );
});

await test("receiptHasMatchingTransfer ignores logs with a bad value encoding", () => {
  const terms = { asset: ASSET, from: PAYER, to: PAY_TO, value: VALUE };
  const bad = { ...transferLog(), data: "0xzz" };
  assert(!receiptHasMatchingTransfer([bad], terms), "unparseable value is not a match");
});

await test("a settle error is recovered only for the verified (from, nonce)", async () => {
  reset();
  settleBehaviour[LEG_A] = { status: 500, body: { success: false, errorReason: "unexpected_error" } };
  nonceUsed = true;
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await pool.settle(leg, request(), CHAIN, outcome.authorization);
  eq(settled.settled, true, "recovered from the consumed nonce");

  const rpc = callsTo("rpc.example").at(-1);
  const body = JSON.parse(String(rpc?.body)) as { params: Array<{ data: string }> };
  const data = body.params[0].data;
  eq(data.slice(0, 10), "0xe94a0102", "authorizationState selector");
  assert(data.includes(PAYER.slice(2).toLowerCase()), "encodes the verified from");
  assert(data.includes(NONCE.slice(2)), "encodes the verified nonce");
});

await test("a settle error with an unused nonce fails closed", async () => {
  reset();
  settleBehaviour[LEG_A] = { status: 500, body: { success: false, errorReason: "invalid_exact_evm_transaction_failed" } };
  nonceUsed = false;
  const pool = new FacilitatorPool(CONFIG);
  const { outcome, leg } = await pool.verify(request());
  if (!outcome.ok) throw new Error("fixture");
  const settled = await muted(() => pool.settle(leg, request(), CHAIN, outcome.authorization));
  eq(settled.settled, false, "not settled");
});

await test("a successful receipt alone never satisfies confirmSettlementOnChain", async () => {
  reset();
  nonceUsed = false;
  receipts = [{ status: "0x1", logs: [transferLog({ to: "0x" + "44".repeat(20) })] }];
  const r = await confirmSettlementOnChain(CHAIN, {
    txHash: "0x" + "ef".repeat(32),
    from: PAYER,
    nonce: NONCE,
  });
  eq(r, "not_settled", "the hash is facilitator-supplied; only the nonce binds it");
});

await test("an RPC failure is unknown, never a denial", async () => {
  reset();
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new Error("RPC timeout");
  };
  eq(await confirmSettlementOnChain(CHAIN, { from: PAYER, nonce: NONCE }), "unknown", "unknown");
  eq(
    await confirmSuccessfulTransfer(CHAIN, "0x" + "ef".repeat(32), {
      asset: ASSET,
      from: PAYER,
      to: PAY_TO,
      value: VALUE,
    }, { nonce: NONCE, attempts: 1 }),
    "unknown",
    "unknown"
  );
});

await test("/supported is answered by any leg", async () => {
  reset();
  verifyBehaviour[LEG_A] = "down";
  const pool = new FacilitatorPool(CONFIG);
  eq(await pool.supports("eip155:84532"), true, "advertised on B");
  eq(await pool.supports("eip155:8453"), false, "not advertised anywhere");
});

(globalThis as unknown as { fetch: unknown }).fetch = realFetch;

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
