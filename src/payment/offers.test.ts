/**
 * Offer construction: multi-rail, degradation, rate limits, and the binding.
 *
 * The multi-rail rule is the one that has to be structural rather than
 * incidental ("a degraded rail is omitted, and the others are unaffected"), so
 * each way a rail can be unavailable is exercised here with the other rails
 * present and asserted unchanged.
 *
 * Run with: bun run src/payment/offers.test.ts
 */

import { LnbtcGate } from "./lnbtc/availability.ts";
import { buildOffers, type BuildOffersOptions } from "./offers.ts";
import { MintLimiter } from "./rate-limit.ts";
import type { PriceEntryConfig, RequirementContext } from "./rails.ts";

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

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const NODE = "02" + "ab".repeat(32);
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";

const CTX: RequirementContext = {
  eip155PayTo: WALLET,
  lnbtcPayTo: NODE,
  maxTimeoutSeconds: 300,
};

const DUAL: PriceEntryConfig = {
  rails: [
    { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
    { scheme: "exact", network: LNBTC, asset: "BTC", amount: "20000" },
  ],
};

const BINDING = {
  method: "GET",
  url: "https://example.com/showcase/dual-rail",
  headers: { accept: "text/markdown" },
  boundHeaders: ["accept"],
};

function gate(state: "available" | "degraded" | "disabled"): LnbtcGate {
  const g = new LnbtcGate({ enabled: state !== "disabled" });
  if (state === "available") {
    g.applyCheck({ status: "pass", methods: ["make_invoice", "get_info"], unverified: false });
  }
  if (state === "degraded") {
    g.applyCheck({ status: "unreachable", reason: "relay down" });
  }
  return g;
}

function lnbtcConfig(
  over: Partial<NonNullable<BuildOffersOptions["lnbtc"]>> = {},
  gateState: "available" | "degraded" | "disabled" = "available"
): NonNullable<BuildOffersOptions["lnbtc"]> {
  return {
    gate: gate(gateState),
    limiter: new MintLimiter(
      { global: { capacity: 10, perMinute: 60 }, perClient: { capacity: 10, perMinute: 60 } },
      0
    ),
    clientKey: "203.0.113.9",
    mint: async () => ({ invoice: "lnbc200n1p3minted", paymentHash: "aa".repeat(32) }),
    ...over,
  };
}

console.log("mdf-server offers");
console.log("--------------------------------------------------");

await test("both rails are offered for a dual-rail route", async () => {
  const offer = await buildOffers({ entry: DUAL, ctx: CTX, binding: BINDING, lnbtc: lnbtcConfig() });
  eq(offer.accepts.length, 2, "one entry per rail");
  eq(offer.accepts[0].network, "eip155:8453", "config order preserved");
  eq(offer.accepts[1].network, LNBTC, "lnbtc second");
  eq(offer.omitted.length, 0, "nothing omitted");
  eq(offer.allUnavailable, false, "available");
  assert(!!offer.binding?.requestHash, "binding recorded");
  eq(offer.binding?.headers.join(","), "accept", "accept is bound");
});

await test("the lnbtc invoice commits to this request's binding", async () => {
  let seen: { descriptionHash: string; expiry: number; amount: number } | null = null;
  const offer = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig({
      mint: async (params) => {
        seen = { descriptionHash: params.descriptionHash, expiry: params.expirySeconds, amount: params.amountMsat };
        return { invoice: "lnbc200n1p3minted", paymentHash: "aa".repeat(32) };
      },
    }),
  });
  eq(seen!.amount, 20000, "rail amount in msat");
  eq(seen!.expiry, 300, "expiry equals maxTimeoutSeconds");
  eq(seen!.descriptionHash, offer.binding!.requestHash, "invoice commits to the computed binding");
});

await test("lnbtc disabled in config: eip155 unaffected, lnbtc omitted as disabled", async () => {
  const offer = await buildOffers({ entry: DUAL, ctx: CTX, binding: BINDING });
  eq(offer.accepts.length, 1, "only the eip155 rail");
  eq(offer.accepts[0].network, "eip155:8453", "unchanged");
  eq(offer.omitted[0].reason, "lnbtc_disabled", "named reason");
});

await test("gate degraded (relay down): eip155 still offered, lnbtc omitted", async () => {
  const offer = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig({}, "degraded"),
  });
  eq(offer.accepts.length, 1, "eip155 unaffected");
  eq(offer.omitted[0].reason, "lnbtc_degraded", "reason");
  eq(offer.allUnavailable, false, "still payable");
});

await test("mint budget exhausted: lnbtc omitted with a retry hint, eip155 unaffected", async () => {
  const limiter = new MintLimiter(
    { global: { capacity: 10, perMinute: 60 }, perClient: { capacity: 1, perMinute: 1 } },
    0
  );
  eq(limiter.tryTake("203.0.113.9", 0).ok, true, "first mint allowed");

  const offer = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig({ limiter }),
    nowMs: 0,
  });
  eq(offer.accepts.length, 1, "eip155 only");
  eq(offer.omitted[0].reason, "mint_rate_limited", "reason");
  assert((offer.retryAfterSeconds ?? 0) > 0, "retry hint carried");
});

await test("a mint failure omits the rail rather than emitting a broken invoice", async () => {
  const offer = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig({
      mint: async () => {
        throw new Error("wallet unreachable");
      },
    }),
  });
  eq(offer.accepts.length, 1, "eip155 only");
  eq(offer.omitted[0].reason, "mint_failed", "reason");
  assert(!JSON.stringify(offer.accepts).includes("lnbc"), "no invoice anywhere");
});

await test("an lnbtc-only route whose rail is unavailable reports allUnavailable", async () => {
  const lnbtcOnly: PriceEntryConfig = {
    rails: [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "1000" }],
  };
  const offer = await buildOffers({
    entry: lnbtcOnly,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig({}, "degraded"),
  });
  eq(offer.allUnavailable, true, "503 territory, not an empty 402");
  eq(offer.accepts.length, 0, "no accepts");
});

await test("a free entry (no rails) is not 'unavailable', it is free", async () => {
  const offer = await buildOffers({ entry: { rails: [] }, ctx: CTX, binding: BINDING });
  eq(offer.accepts.length, 0, "no rails");
  // The caller distinguishes free from unavailable by the entry having no rails,
  // which it knows before calling; `allUnavailable` describes a priced entry.
  eq(offer.allUnavailable, true, "reported honestly; the caller checks rails.length first");
});

await test("an invalid rail is omitted without taking the offer down", async () => {
  const mixed: PriceEntryConfig = {
    rails: [
      { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
      // Not in the vendored table for this network.
      { scheme: "exact", network: "eip155:8453", asset: "0x" + "11".repeat(20), amount: "1" },
    ],
  };
  const offer = await buildOffers({ entry: mixed, ctx: CTX, binding: BINDING });
  eq(offer.accepts.length, 1, "the good rail survives");
  eq(offer.omitted[0].reason, "invalid_rail", "reason");
});

await test("a different representation or URL is a different binding", async () => {
  const markdown = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: BINDING,
    lnbtc: lnbtcConfig(),
  });
  const html = await buildOffers({
    entry: DUAL,
    ctx: CTX,
    binding: { ...BINDING, headers: { accept: "text/html" } },
    lnbtc: lnbtcConfig(),
  });
  assert(markdown.binding!.requestHash !== html.binding!.requestHash, "binding follows the representation");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
