/**
 * Rails (MDF 0.3.x pricing model).
 *
 * The interesting behaviour is all at the edges: which section wins, what a
 * rail may be, and what the summary must state. Those are the places where a
 * subtle change would silently mis-price a route.
 *
 * Run with: bun run src/payment/rails.test.ts
 */

import {
  LNBTC_MAINNET,
  buildEip155Requirement,
  buildLnbtcRequirement,
  isFreeEntry,
  isTokenEntry,
  priceSummary,
  resolvePriceEntry,
  tokenScopeForPath,
  validateRail,
  type PricingConfig,
  type RequirementContext,
} from "./rails.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";
const NODE_PUBKEY = "02" + "ab".repeat(32);

const PRICING: PricingConfig = {
  default: { rails: [] },
  sections: {
    "/docs/**": { rails: [] },
    "/premium/**": {
      rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000" }],
    },
    "/private/**": {
      access: "token",
      rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "100000" }],
    },
    "/micropayment/**": {
      rails: [{ scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "1000" }],
    },
    "/showcase/**": {
      rails: [
        { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "20000" },
        { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "20000" },
      ],
    },
  },
};

const CTX: RequirementContext = {
  eip155PayTo: WALLET,
  lnbtcPayTo: NODE_PUBKEY,
  maxTimeoutSeconds: 300,
};

console.log("mdf-server rails");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("the most specific section wins", () => {
  eq(resolvePriceEntry("/premium/deep-dive", PRICING).pattern, "/premium/**", "premium");
  eq(resolvePriceEntry("/docs/getting-started", PRICING).pattern, "/docs/**", "docs");
});

test("a path with no matching section falls back to pricing.default", () => {
  const r = resolvePriceEntry("/unmatched/page", PRICING);
  eq(r.pattern, null, "no pattern");
  eq(r.entry.rails.length, 0, "default rails");
});

test("a longer glob beats a shorter one covering the same path", () => {
  const pricing: PricingConfig = {
    default: { rails: [] },
    sections: {
      "/a/**": { rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "1" }] },
      "/a/b/**": { rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "2" }] },
    },
  };
  eq(resolvePriceEntry("/a/b/c", pricing).pattern, "/a/b/**", "specific wins");
  eq(resolvePriceEntry("/a/b/c", pricing).entry.rails[0].amount, "2", "amount from the specific entry");
});

test("free, token and paid entries are distinguishable", () => {
  assert(isFreeEntry(resolvePriceEntry("/docs/x", PRICING).entry), "docs are free");
  assert(isTokenEntry(resolvePriceEntry("/private/x", PRICING).entry), "private is token access");
  assert(!isTokenEntry(resolvePriceEntry("/premium/x", PRICING).entry), "premium is per fetch");
});

test("a token's scope is the first path segment", () => {
  eq(tokenScopeForPath("/private/internals"), "/private/", "nested path");
  eq(tokenScopeForPath("/private"), "/private/", "bare section");
  eq(tokenScopeForPath("/"), "/", "root");
});

// ---------------------------------------------------------------------------
// Rail validation
// ---------------------------------------------------------------------------

test("a valid eip155 rail resolves its asset entry", () => {
  const r = validateRail(
    { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000" },
    "test"
  );
  eq(r.ok, true, "must validate");
  if (r.ok) eq(r.asset?.name, "USD Coin", "table entry returned");
});

test("a valid lnbtc rail needs whole satoshis and BTC", () => {
  const ok = validateRail(
    { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "1000" },
    "test"
  );
  eq(ok.ok, true, "1 sat is valid");

  const subSat = validateRail(
    { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "1500" },
    "test"
  );
  eq(subSat.ok, false, "1.5 sat must be refused");
  if (!subSat.ok) assert(subSat.reason.includes("whole number of satoshis"), "reason is specific");

  const tooSmall = validateRail(
    { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "500" },
    "test"
  );
  eq(tooSmall.ok, false, "below the 1-sat floor must be refused");

  const wrongAsset = validateRail(
    { scheme: "exact", network: LNBTC_MAINNET, asset: "USDC", amount: "1000" },
    "test"
  );
  eq(wrongAsset.ok, false, "lnbtc asset must be BTC");
});

test("decimal and zero amounts are refused as non-atomic", () => {
  for (const amount of ["0.01", "0", "1e3", "-5", "0010"]) {
    const r = validateRail(
      { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount },
      "test"
    );
    eq(r.ok, false, `amount '${amount}' must be refused`);
  }
});

test("an unknown asset, network or scheme is refused with a reason", () => {
  const badAsset = validateRail(
    { scheme: "exact", network: "eip155:8453", asset: "0x" + "11".repeat(20), amount: "1" },
    "test"
  );
  eq(badAsset.ok, false, "unknown asset refused");
  if (!badAsset.ok) assert(badAsset.reason.includes("vendored table"), "names the table");

  const badNetwork = validateRail(
    { scheme: "exact", network: "eip155:137", asset: USDC_BASE, amount: "1" },
    "test"
  );
  eq(badNetwork.ok, false, "unsupported network refused");

  const badScheme = validateRail(
    { scheme: "upto", network: "eip155:8453", asset: USDC_BASE, amount: "1" },
    "test"
  );
  eq(badScheme.ok, false, "non-exact scheme refused");
});

// ---------------------------------------------------------------------------
// Requirement building
// ---------------------------------------------------------------------------

test("an eip155 requirement carries the table's EIP-712 domain", () => {
  const r = buildEip155Requirement(
    { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000" },
    CTX
  );
  eq(r.ok, true, "built");
  if (!r.ok) return;
  const req = r.requirement;
  eq(req.scheme, "exact", "scheme");
  eq(req.network, "eip155:8453", "network");
  eq(req.amount, "10000", "amount is atomic, verbatim");
  eq(req.asset, USDC_BASE, "asset from the table");
  eq(req.payTo, WALLET, "payTo from the wallet secret");
  eq(req.maxTimeoutSeconds, 300, "offer window");
  eq(req.extra?.name, "USD Coin", "domain name from the table");
  eq(req.extra?.version, "2", "domain version from the table");
  eq(req.extra?.assetTransferMethod, "eip3009", "transfer method stated explicitly");
});

test("Base Sepolia gets its own domain name, not the mainnet one", () => {
  const r = buildEip155Requirement(
    { scheme: "exact", network: "eip155:84532", asset: USDC_SEPOLIA, amount: "1000" },
    CTX
  );
  eq(r.ok, true, "built");
  if (r.ok) eq(r.requirement.extra?.name, "USDC", "sepolia domain");
});

test("an eip155 requirement refuses without a wallet", () => {
  const r = buildEip155Requirement(
    { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "1" },
    { ...CTX, eip155PayTo: null }
  );
  eq(r.ok, false, "must refuse rather than emit an empty payTo");
});

test("an lnbtc requirement carries the binding fields and refuses an unbound invoice", () => {
  const rail = { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "1000" };
  const ok = buildLnbtcRequirement(rail, CTX, {
    invoice: "lnbc10n1p3example",
    requestHash: "a".repeat(64),
    requestBindingParams: { headers: ["accept"] },
  });
  eq(ok.ok, true, "built");
  if (ok.ok) {
    const e = ok.requirement.extra!;
    eq(ok.requirement.asset, "BTC", "asset");
    eq(e.paymentFlow, "upfront", "upfront flow");
    eq(e.assetTransferMethod, "bolt11", "bolt11");
    eq(e.requestBindingProfile, "http:1", "binding profile");
    eq((e.requestBindingParams as { headers: string[] }).headers[0], "accept", "accept is bound");
  }

  const noInvoice = buildLnbtcRequirement(rail, CTX, {
    invoice: "",
    requestHash: "a".repeat(64),
    requestBindingParams: { headers: [] },
  });
  eq(noInvoice.ok, false, "an invoice is required");

  const noPubkey = buildLnbtcRequirement(rail, { ...CTX, lnbtcPayTo: null }, {
    invoice: "lnbc10n1p3example",
    requestHash: "a".repeat(64),
    requestBindingParams: { headers: [] },
  });
  eq(noPubkey.ok, false, "the receiver node pubkey is required");

  const badPubkey = buildLnbtcRequirement(rail, { ...CTX, lnbtcPayTo: "zz" }, {
    invoice: "lnbc10n1p3example",
    requestHash: "a".repeat(64),
    requestBindingParams: { headers: [] },
  });
  eq(badPubkey.ok, false, "payTo must be a compressed secp256k1 key");
});

// ---------------------------------------------------------------------------
// Price summary
// ---------------------------------------------------------------------------

test("the summary states the raw amount of every rail", () => {
  const rails = [
    buildEip155Requirement(
      { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "20000" },
      CTX
    ),
    buildLnbtcRequirement(
      { scheme: "exact", network: LNBTC_MAINNET, asset: "BTC", amount: "20000" },
      CTX,
      { invoice: "lnbc200n1p3x", requestHash: "b".repeat(64), requestBindingParams: { headers: [] } }
    ),
  ].map((r) => {
    if (!r.ok) throw new Error("fixture must build");
    return r.requirement;
  });

  const summary = priceSummary(rails);
  assert(summary.includes("20000"), "raw atomic amount present");
  assert(summary.includes("0.02 USDC"), "human USDC amount present");
  assert(summary.includes("20 sat"), "human sats present");
  assert(summary.includes(LNBTC_MAINNET), "lightning rail named by its CAIP-2 id");

  // The validator's rule: every rail's amount must appear.
  for (const r of rails) assert(summary.includes(r.amount), `amount ${r.amount} appears`);
});

test("a single rail reads as a sentence, and no rails says so", () => {
  const one = buildEip155Requirement(
    { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000" },
    CTX
  );
  if (!one.ok) throw new Error("fixture");
  const s = priceSummary([one.requirement]);
  assert(!s.includes(" or "), "no alternative for one rail");
  eq(priceSummary([]), "no rails available", "empty offer");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
