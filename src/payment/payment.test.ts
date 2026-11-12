/**
 * The payment facade — the seam the router talks to.
 *
 * `facilitator.test.ts` covers the v2 client and the on-chain confirmation,
 * `lnbtc.test.ts` covers BOLT11 and the request binding, and `offers.test.ts`
 * covers what a 402 may contain. What is left, and what this file pins, is the
 * **order of operations and the failure classes** in `verifyPayment` /
 * `verifyLnbtc`:
 *
 *   offer → PAYMENT-SIGNATURE → match a rail → verify → settle → serve
 *
 * The cases here are the ones that fail silently if they regress: a payment
 * that must not reach the facilitator, an invoice that must not be accepted, a
 * preimage that must not be honoured twice (including "twice" meaning "once per
 * instance"), and a settlement header that must omit the payer on Lightning.
 *
 * The lnbtc half uses the documented `decodeInvoiceFrom` seam: minting an
 * invoice for an arbitrary binding needs a BOLT11 signer, which the suite
 * deliberately does not have. The seam replaces only the decoder; the binding,
 * preimage, replay and expiry logic under test is the production path.
 *
 * Run with: bun run src/payment/payment.test.ts
 */

import { createHash } from "crypto";
import {
  classifyRailMismatch,
  entryFor,
  matchesRail,
  settlementHeader,
  verifyPayment,
  type RequestContext,
  type VerifyResult,
} from "./payment.ts";
import { computeRequestHash } from "./lnbtc/binding.ts";
import { MemoryReplayStore, replayTtlSeconds } from "./lnbtc/replay-store.ts";
import { LnbtcGate } from "./lnbtc/availability.ts";
import { FacilitatorPool } from "./facilitator.ts";
import type { LoadedConfig, LnbtcRuntime } from "../config/loader.ts";
import type { DecodedInvoice } from "./lnbtc/bolt11.ts";

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

function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
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
const PAYER = "0xBB12e7F39F734aD962c50dDbE91F73557Bf9A93B";
const FAC_URL = "http://facilitator.example";

const rail = (amount: string, network = "eip155:8453", asset = USDC) => ({
  scheme: "exact",
  network,
  asset,
  amount,
});

const PREIMAGE = "11".repeat(32);
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

const LN_ROUTE = "/micropayment/intro";
const LN_RESOURCE = `https://example.com${LN_ROUTE}`;
const LN_AMOUNT = "1000";

/** The binding this request must have committed to. */
const LN_BINDING = computeRequestHash({
  method: "GET",
  url: LN_RESOURCE,
  headers: { accept: "text/markdown" },
  boundHeaders: ["accept"],
});

function decodedInvoice(
  over: Partial<DecodedInvoice> = {},
  nowSeconds = Math.floor(Date.now() / 1000)
): DecodedInvoice {
  return {
    currency: "bc",
    amountMsat: Number(LN_AMOUNT),
    timestamp: nowSeconds - 5,
    expirySeconds: 300,
    description: null,
    descriptionHash: LN_BINDING.requestHash,
    paymentHash: PAYMENT_HASH,
    payeePubkeyField: NODE,
    signingKey: NODE,
    fullyParsed: true,
    tags: ["p", "h", "x", "n", "s", "c"],
    ...over,
  };
}

function makeLnbtc(options: {
  replay?: MemoryReplayStore;
  gate?: "available" | "degraded";
  decode?: () => DecodedInvoice;
  payee?: string | null;
} = {}): LnbtcRuntime {
  const gate = new LnbtcGate({ enabled: true });
  gate.applyCheck(
    options.gate === "degraded"
      ? { status: "unreachable", reason: "relay down" }
      : { status: "pass", methods: ["make_invoice"], unverified: false }
  );
  return {
    enabled: true,
    network: LNBTC,
    payeePubkey: options.payee === undefined ? NODE : options.payee,
    gate,
    limiter: { tryTake: () => ({ ok: true }) },
    replay: options.replay ?? new MemoryReplayStore(),
    invoiceExpirySeconds: 300,
    breaker: { initialBackoffMs: 5000, maxBackoffMs: 300000 },
    ...(options.decode ? { decodeInvoiceFrom: options.decode } : {}),
  } as unknown as LnbtcRuntime;
}

function makeLoaded(
  options: { lnbtc?: LnbtcRuntime | null; pool?: FacilitatorPool | null } = {}
): LoadedConfig {
  return {
    contentDir: ".",
    walletAddress: WALLET,
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      pricing: {
        default: { rails: [] },
        sections: {
          "/micropayment/**": { rails: [rail(LN_AMOUNT, LNBTC, "BTC")] },
          "/premium/**": { rails: [rail("10000")] },
          "/testnet/**": { rails: [rail("1000", "eip155:84532", USDC_SEPOLIA)] },
        },
      },
      payment: { max_timeout_seconds: 300 },
      server: { trusted_proxies: [] },
    } as unknown as LoadedConfig["config"],
    tokenStore: {} as never,
    tokenStoreBackend: "memory",
    facilitator: null,
    pool: options.pool ?? null,
    replayStore: null,
    lnbtc: options.lnbtc === undefined ? null : options.lnbtc,
    valkey: null,
  } as LoadedConfig;
}

function context(urlPath = LN_ROUTE, resource = LN_RESOURCE): RequestContext {
  return {
    urlPath,
    resourceUrl: resource,
    method: "GET",
    headers: { accept: "text/markdown" },
    clientKey: "203.0.113.9",
  };
}

/** The `PAYMENT-SIGNATURE` payload a client would send. */
function signature(accepted: Record<string, unknown>, payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload })).toString("base64");
}

/** A v2 requirement matching the lnbtc rail, as the 402 would carry it. */
const LN_ACCEPTED = {
  scheme: "exact",
  network: LNBTC,
  amount: LN_AMOUNT,
  asset: "BTC",
  payTo: NODE,
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: "bolt11",
    paymentFlow: "upfront",
    invoice: "lnbc10n1p3minted",
    requestHash: LN_BINDING.requestHash,
    requestBindingProfile: "http:1",
    requestBindingParams: LN_BINDING.requestBindingParams,
  },
};

function lnPayment(preimage = PREIMAGE, over: Record<string, unknown> = {}) {
  return signature({ ...LN_ACCEPTED, ...over }, { preimage });
}

// ---------------------------------------------------------------------------
// Rail matching and the closed error vocabulary
// ---------------------------------------------------------------------------

console.log("mdf-server payment facade");
console.log("--------------------------------------------------");

await test("matchesRail compares scheme, network, amount and asset (hex case-insensitively)", () => {
  const configured = rail("10000");
  assert(matchesRail(configured, { ...configured, payTo: WALLET } as never), "exact match");
  assert(
    !matchesRail(configured, { ...configured, amount: "1" } as never),
    "amount is part of the identity"
  );
  assert(
    !matchesRail(configured, { ...configured, network: "eip155:84532" } as never),
    "network is part of the identity"
  );
  assert(
    matchesRail(
      { ...configured, asset: USDC.toLowerCase() },
      { ...configured, asset: USDC.toUpperCase().replace("0X", "0x") } as never
    ),
    "asset hex is case-insensitive"
  );
});

await test("a mismatch is classified by the field that differs", () => {
  const rails = [rail("10000"), rail("1000", "eip155:84532", USDC_SEPOLIA)];
  eq(
    classifyRailMismatch(rails, { scheme: "exact", network: "eip155:1", amount: "1", asset: USDC } as never),
    "unsupported_rail",
    "unknown network"
  );
  eq(
    classifyRailMismatch(rails, {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "0x" + "11".repeat(20),
    } as never),
    "unsupported_rail",
    "unknown asset"
  );
  eq(
    classifyRailMismatch(rails, { scheme: "exact", network: "eip155:8453", amount: "5", asset: USDC } as never),
    "wrong_amount",
    "known rail, wrong price"
  );
  eq(
    classifyRailMismatch(rails, { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC } as never),
    "wrong_recipient",
    "everything matches the rail, so the remaining difference is elsewhere"
  );
});

// ---------------------------------------------------------------------------
// lnbtc: everything that must not be accepted
// ---------------------------------------------------------------------------

await test("a correct invoice and preimage is approved, without a facilitator call", async () => {
  const replay = new MemoryReplayStore();
  const loaded = makeLoaded({ lnbtc: makeLnbtc({ replay, decode: () => decodedInvoice() }) });
  const result = await verifyPayment({
    loaded,
    request: context(),
    paymentSignature: lnPayment(),
  });
  eq(result.status, "approved", "approved");
  eq(result.rail, `exact/${LNBTC}`, "rail label");
  eq(result.settlement?.transaction, PAYMENT_HASH, "transaction is the payment hash");
  eq(result.settlement?.payer, undefined, "Lightning reveals no payer");
  eq(replay.size(), 1, "the replay record was written");
});

await test("the same preimage is refused the second time", async () => {
  const replay = new MemoryReplayStore();
  const loaded = makeLoaded({ lnbtc: makeLnbtc({ replay, decode: () => decodedInvoice() }) });
  const first = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(first.status, "approved", "first use");
  const second = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(second.status, "rejected", "second use refused");
  eq(second.reason, "replay_rejected", "coarse class names the replay");
});

await test("a replay is still refused after a restart, because the store is shared", async () => {
  // The scheme's durability rule: a second process (or a restarted one) must see
  // the first process's claim. Two runtimes over one store model exactly that.
  const shared = new MemoryReplayStore();
  const before = makeLoaded({ lnbtc: makeLnbtc({ replay: shared, decode: () => decodedInvoice() }) });
  const after = makeLoaded({ lnbtc: makeLnbtc({ replay: shared, decode: () => decodedInvoice() }) });

  eq((await verifyPayment({ loaded: before, request: context(), paymentSignature: lnPayment() })).status, "approved", "first");
  const replay = await verifyPayment({ loaded: after, request: context(), paymentSignature: lnPayment() });
  eq(replay.reason, "replay_rejected", "the new process refuses the old preimage");
});

await test("with a private store, a restart *would* accept the replay — why it must be shared", async () => {
  // This is the defect decision 25 had: asserting it here keeps anyone from
  // "simplifying" the shared store away, because the failure mode becomes a
  // passing test rather than an incident.
  const first = makeLoaded({ lnbtc: makeLnbtc({ decode: () => decodedInvoice() }) });
  const second = makeLoaded({ lnbtc: makeLnbtc({ decode: () => decodedInvoice() }) });
  eq((await verifyPayment({ loaded: first, request: context(), paymentSignature: lnPayment() })).status, "approved", "first");
  const again = await verifyPayment({ loaded: second, request: context(), paymentSignature: lnPayment() });
  eq(again.status, "approved", "an independent store cannot see the first claim");
});

await test("the replay record outlives the invoice it protects", () => {
  const ttl = replayTtlSeconds(300);
  eq(ttl, 300 + 60 + 3600, "expiry + skew + retention");
  assert(ttl > 300 + 60, "the record outlives the last moment the invoice is payable");
});

await test("an expired invoice is refused as payment_expired", async () => {
  const now = Math.floor(Date.now() / 1000);
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ decode: () => decodedInvoice({ timestamp: now - 300 - 61 }, now) }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "rejected", "rejected");
  eq(result.reason, "payment_expired", "coarse class");
});

await test("an invoice bound to another resource is refused", async () => {
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ decode: () => decodedInvoice({ descriptionHash: "c".repeat(64) }) }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "rejected", "rejected");
  eq(result.reason, "invalid_payment", "coarse class");
});

await test("an invoice for a different amount is refused", async () => {
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ decode: () => decodedInvoice({ amountMsat: 2000 }) }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "rejected", "rejected");
});

await test("an invoice signed by a different key is refused", async () => {
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ decode: () => decodedInvoice({ signingKey: "03" + "ff".repeat(32) }) }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "rejected", "rejected");
});

await test("a wrong preimage is refused and claims nothing", async () => {
  const replay = new MemoryReplayStore();
  const loaded = makeLoaded({ lnbtc: makeLnbtc({ replay, decode: () => decodedInvoice() }) });
  const result = await verifyPayment({
    loaded,
    request: context(),
    paymentSignature: lnPayment("22".repeat(32)),
  });
  eq(result.status, "rejected", "rejected");
  eq(result.reason, "invalid_payment", "coarse class");
  eq(replay.size(), 0, "a bad preimage must not consume the replay key");
});

await test("a missing preimage is refused", async () => {
  const loaded = makeLoaded({ lnbtc: makeLnbtc({ decode: () => decodedInvoice() }) });
  const result = await verifyPayment({
    loaded,
    request: context(),
    paymentSignature: signature(LN_ACCEPTED, {}),
  });
  eq(result.status, "rejected", "rejected");
});

await test("an unreachable replay store fails closed as an error, never an approval", async () => {
  const unavailable = {
    claim: async () => "unavailable",
    health: async () => "unavailable",
    close: () => {},
  } as unknown as MemoryReplayStore;
  const loaded = makeLoaded({ lnbtc: makeLnbtc({ replay: unavailable, decode: () => decodedInvoice() }) });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "error", "an outage is not a denial");
  eq(result.reason, "payment_unavailable", "coarse class");
});

await test("a degraded rail refuses a proof rather than serving on an unverified claim", async () => {
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ gate: "degraded", decode: () => decodedInvoice() }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "error", "error, not rejection: the rail is not being offered");
});

await test("a missing payee pubkey refuses the proof", async () => {
  const loaded = makeLoaded({
    lnbtc: makeLnbtc({ payee: null, decode: () => decodedInvoice() }),
  });
  const result = await verifyPayment({ loaded, request: context(), paymentSignature: lnPayment() });
  eq(result.status, "error", "no payTo means nothing can be verified");
});

// ---------------------------------------------------------------------------
// eip155: refusals that must not reach the facilitator
// ---------------------------------------------------------------------------

console.log("\neip155 refusals\n");

const realFetch = globalThis.fetch;
let fetches: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  fetches.push(String(url));
  throw new Error("the facilitator must not be called");
};

function eipLoaded(): LoadedConfig {
  return makeLoaded({
    pool: new FacilitatorPool({ legs: [FAC_URL], timeoutMs: 1000, rpc: {} }),
  });
}

const EIP_ACCEPTED = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: USDC,
  payTo: WALLET,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};

function eipPayment(over: Record<string, unknown> = {}): string {
  return signature({ ...EIP_ACCEPTED, ...over }, {
    signature: "0x" + "cd".repeat(65),
    authorization: { from: PAYER, nonce: "0x" + "01".padStart(64, "0") },
  });
}

await test("a payload whose accepted.payTo is not our wallet is a wrong_recipient refusal", async () => {
  fetches = [];
  const result = await verifyPayment({
    loaded: eipLoaded(),
    request: context("/premium/deep-dive", "https://example.com/premium/deep-dive"),
    paymentSignature: eipPayment({ payTo: "0x" + "22".repeat(20) }),
  });
  eq(result.status, "rejected", "rejected");
  eq(result.reason, "wrong_recipient", "class");
  eq(fetches.length, 0, "no facilitator call");
});

await test("a payload with a different offer window is refused before verification", async () => {
  fetches = [];
  const result = await verifyPayment({
    loaded: eipLoaded(),
    request: context("/premium/deep-dive", "https://example.com/premium/deep-dive"),
    paymentSignature: eipPayment({ maxTimeoutSeconds: 60 }),
  });
  eq(result.reason, "invalid_payment", "class");
  eq(fetches.length, 0, "no facilitator call");
});

await test("a rail this server does not price for the path is an unsupported_rail refusal", async () => {
  fetches = [];
  const result = await verifyPayment({
    loaded: eipLoaded(),
    request: context("/premium/deep-dive", "https://example.com/premium/deep-dive"),
    paymentSignature: eipPayment({ network: "eip155:84532", asset: USDC_SEPOLIA, amount: "1000" }),
  });
  eq(result.reason, "unsupported_rail", "class");
  eq(fetches.length, 0, "no facilitator call");
});

await test("an eip155 rail with no facilitator configured is an outage, not a denial", async () => {
  const result = await verifyPayment({
    loaded: makeLoaded({ pool: null }),
    request: context("/premium/deep-dive", "https://example.com/premium/deep-dive"),
    paymentSignature: eipPayment(),
  });
  eq(result.status, "error", "error");
  eq(result.reason, "payment_unavailable", "class");
});

(globalThis as unknown as { fetch: unknown }).fetch = realFetch;

// ---------------------------------------------------------------------------
// Settlement header
// ---------------------------------------------------------------------------

console.log("\nSettlement header\n");

await test("an eip155 settlement header carries success, tx, network and payer", () => {
  const result: VerifyResult = {
    status: "approved",
    settlement: { transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: PAYER },
  };
  const decoded = JSON.parse(Buffer.from(settlementHeader(result) as string, "base64").toString("utf8"));
  eq(decoded.success, true, "success");
  eq(decoded.transaction, "0x" + "ab".repeat(32), "transaction");
  eq(decoded.network, "eip155:8453", "network");
  eq(decoded.payer, PAYER, "payer present on eip155");
});

await test("an lnbtc settlement header omits payer and names the payment hash", () => {
  const result: VerifyResult = {
    status: "approved",
    settlement: { transaction: PAYMENT_HASH, network: LNBTC },
  };
  const header = settlementHeader(result) as string;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  eq(decoded.transaction, PAYMENT_HASH, "payment hash as the transaction");
  assert(!("payer" in decoded), "payer is omitted, not empty");
  assert(!header.includes(PREIMAGE), "the preimage is never echoed");
});

await test("no settlement means no header", () => {
  eq(settlementHeader({ status: "rejected", reason: "invalid_payment" }), null, "null");
});

await test("entryFor classifies free, paid and token entries consistently", () => {
  const loaded = makeLoaded();
  eq(entryFor(loaded, "/anywhere").free, true, "default entry here has no rails");
  eq(entryFor(loaded, "/premium/deep-dive").free, false, "priced");
  eq(entryFor(loaded, "/premium/deep-dive").tokenAccess, false, "per-fetch");
});

console.log("--------------------------------------------------");
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
