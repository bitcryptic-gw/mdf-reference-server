/**
 * The v2 402 response.
 *
 * Two properties matter more than any single field, and both are asserted here
 * because both are easy to break by "tidying" the builder:
 *
 *   1. The `PAYMENT-REQUIRED` header is the base64 of the body's **exact
 *      bytes**, so body and header cannot disagree.
 *   2. Nothing from a facilitator reaches the wire: `error` is a closed
 *      vocabulary, and a token-contract revert string never appears.
 *
 * Run with: bun run src/payment/402v2.test.ts
 */

import {
  MDF_INFO_SCHEMA,
  MDF_PROTOCOL_VERSION,
  MDF_SPEC_VERSION,
  buildPaymentRequired,
  coarseErrorClass,
  render402,
  renderUnavailable,
} from "./402.ts";
import { decodeHeaderObject, MAX_PAYMENT_HEADER_CHARS } from "./headers.ts";
import type { PaymentRequirement } from "./rails.ts";

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

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";

const EIP155: PaymentRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000",
  asset: USDC,
  payTo: WALLET,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};

const LNBTC: PaymentRequirement = {
  scheme: "exact",
  network: "lnbtc:000000000019d6689c085ae165831e93",
  amount: "20000",
  asset: "BTC",
  payTo: "02" + "ab".repeat(32),
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: "bolt11",
    paymentFlow: "upfront",
    invoice: "lnbc200n1p3example",
    requestHash: "a".repeat(64),
    requestBindingProfile: "http:1",
    requestBindingParams: { headers: ["accept"] },
  },
};

function dualRail(error?: Parameters<typeof buildPaymentRequired>[0]["error"]) {
  return buildPaymentRequired({
    resourceUrl: "https://example.com/showcase/dual-rail",
    description: "Dual-rail showcase",
    mimeType: "text/markdown",
    serviceName: "MDF Demo Site",
    accepts: [EIP155, LNBTC],
    error,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    sourceBytes: 1234,
  });
}

console.log("mdf-server v2 402");
console.log("--------------------------------------------------");

test("the object is a v2 PaymentRequired with a resource object and both rails", () => {
  const doc = dualRail();
  eq(doc.x402Version, 2, "x402Version");
  eq(typeof doc.resource, "object", "resource is an object");
  eq(doc.resource.url, "https://example.com/showcase/dual-rail", "resource.url");
  eq(doc.resource.mimeType, "text/markdown", "mimeType");
  eq(doc.accepts.length, 2, "one entry per offered rail");
  eq(doc.accepts[0].network, "eip155:8453", "first rail");
  eq(doc.accepts[1].network, "lnbtc:000000000019d6689c085ae165831e93", "second rail");
});

test("MDF fields live under extensions.mdf.info, with the schema beside them", () => {
  const doc = dualRail();
  const mdf = doc.extensions.mdf;
  eq(mdf.info.version, "0.3.1", "spec version");
  eq(mdf.info.source_bytes, 1234, "source_bytes");
  assert(typeof mdf.info.expires_at === "string", "expires_at emitted");
  assert(mdf.info.price_summary.length > 0, "price_summary present");
  eq(mdf.schema, MDF_INFO_SCHEMA, "schema describes info");
  assert(MDF_SPEC_VERSION === "0.3.1", "spec version constant");
});

test("the info carries nothing that duplicates accepts[]", () => {
  const info = dualRail().extensions.mdf.info as unknown as Record<string, unknown>;
  for (const forbidden of ["amount", "payTo", "pay_to", "network", "asset"]) {
    assert(!(forbidden in info), `info must not restate '${forbidden}'`);
  }
});

test("the header is the base64 of the exact body bytes", () => {
  const res = render402(dualRail());
  const header = res.headers["PAYMENT-REQUIRED"];
  assert(typeof header === "string", "header present");
  const decoded = Buffer.from(header, "base64").toString("utf8");
  eq(decoded, res.body, "decoded header equals the body byte for byte");

  const parsed = decodeHeaderObject(header);
  eq(parsed.ok, true, "header decodes");
  if (parsed.ok) {
    eq(JSON.stringify(parsed.value), res.body, "round-trips to the same JSON");
  }
});

test("a 402 is no-store, carries X-MDF-Version 1, and has no L402 challenge", () => {
  const res = render402(dualRail());
  eq(res.status, 402, "status");
  eq(res.headers["Cache-Control"], "no-store", "cache-control");
  eq(res.headers["X-MDF-Version"], MDF_PROTOCOL_VERSION, "protocol family version");
  eq(MDF_PROTOCOL_VERSION, "1", "protocol family is 1");
  assert(!("WWW-Authenticate" in res.headers), "no L402 challenge on a v2 402");
  assert(!res.body.includes("macaroon"), "no macaroon anywhere in the body");
});

test("the summary is derived from the offered rails and agrees with them", () => {
  const res = render402(dualRail());
  const parsed = decodeHeaderObject<{ extensions: { mdf: { info: { price_summary: string } } } }>(
    res.headers["PAYMENT-REQUIRED"]
  );
  if (!parsed.ok) throw new Error("header must decode");
  const summary = parsed.value.extensions.mdf.info.price_summary;
  for (const rail of [EIP155, LNBTC]) {
    assert(summary.includes(rail.amount), `summary states ${rail.amount}`);
  }
  assert(summary.includes("eip155:8453"), "summary names the evm network");
});

test("a degraded rail simply does not appear, and the summary follows", () => {
  const doc = buildPaymentRequired({
    resourceUrl: "https://example.com/showcase/dual-rail",
    accepts: [EIP155],
  });
  eq(doc.accepts.length, 1, "one rail offered");
  assert(!doc.extensions.mdf.info.price_summary.includes("Lightning"), "no lightning clause");
  assert(!JSON.stringify(doc).includes("lnbc"), "no invoice anywhere");
});

test("the error field is coarse and cannot carry facilitator detail", () => {
  const doc = dualRail("replay_rejected");
  eq(doc.error, "replay_rejected", "class passes through");

  const res = render402(doc);
  // A revert string is exactly what used to leak; it must never be in the body.
  const leak = "FiatTokenV2: authorization is used or canceled";
  assert(!res.body.includes(leak), "no revert text in the body");
  assert(!res.body.includes("invalidReasonDetails"), "no facilitator detail field");
});

test("coarseErrorClass maps facilitator reasons to the closed vocabulary", () => {
  const cases: Array<[string, string]> = [
    ["", "payment_required"],
    ["duplicate_settlement", "replay_rejected"],
    ["invalid_exact_evm_nonce_already_used", "replay_rejected"],
    ["invalid_payment_expired", "payment_expired"],
    ["invalid_exact_evm_pay_to_mismatch", "wrong_recipient"],
    ["invalid_exact_evm_insufficient_balance", "wrong_amount"],
    ["unsupported_scheme", "unsupported_rail"],
    ["something else entirely", "invalid_payment"],
  ];
  for (const [input, expected] of cases) {
    eq(coarseErrorClass(input), expected, `classify '${input}'`);
  }
});

test("no rail can be offered → 503 with Retry-After, never an empty 402", () => {
  const res = renderUnavailable({
    resourceUrl: "https://example.com/micropayment/intro",
    error: "payment_unavailable",
    retryAfterSeconds: 12.4,
  });
  eq(res.status, 503, "503");
  eq(res.headers["Retry-After"], "13", "retry-after rounded up");
  eq(res.headers["Cache-Control"], "no-store", "no-store");
  const body = JSON.parse(res.body) as Record<string, unknown>;
  assert(!("accepts" in body), "no accepts array on an unavailable response");
  eq(body.error, "payment_unavailable", "coarse error");
});

test("oversized and malformed payment headers are refused before decoding", () => {
  const big = "A".repeat(MAX_PAYMENT_HEADER_CHARS + 1);
  eq(decodeHeaderObject(big).ok, false, "oversized refused");
  const bigRes = decodeHeaderObject(big);
  assert(!bigRes.ok && bigRes.reason === "too_large", "reason is too_large");

  eq(decodeHeaderObject("not base64 !!").ok, false, "invalid alphabet refused");
  eq(decodeHeaderObject(Buffer.from("[]").toString("base64")).ok, false, "array refused");
  eq(decodeHeaderObject(Buffer.from("{}").toString("base64")).ok, true, "object accepted");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
