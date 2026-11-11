/**
 * lnbtc binding and BOLT11 decoding, against the scheme's own test vectors.
 *
 * Two independent things are checked here:
 *
 *  - the `http:1` request hash equals the digests `scheme_exact_lnbtc.md` @
 *    513dd66 publishes for `GET https://api.example.com/article/A` (and B), which
 *    pins JCS canonicalisation, the body hash and the header hashing;
 *  - a real BOLT11 invoice decodes to exactly the values the same spec states —
 *    amount in millisatoshis, creation time, description hash, payment hash and
 *    the recovered signing key (`02…f81798`, the test-only key).
 *
 * Run with: bun run src/payment/lnbtc.test.ts
 */

import { createHash } from "node:crypto";
import {
  BINDING_DOMAIN,
  bodyHash,
  computeRequestHash,
  headerValueHash,
  jcs,
} from "./lnbtc/binding.ts";
import {
  checkInvoice,
  decodeBolt11,
  preimageMatches,
  type InvoiceRequirements,
} from "./lnbtc/bolt11.ts";

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

// The scheme's HTTP test vector (empty body, no bound headers).
const VECTOR_A = {
  url: "https://api.example.com/article/A",
  canonical:
    '{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}',
  hash: "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
};
const VECTOR_B_HASH = "4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509";

const SPEC_INVOICE =
  "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f";

console.log("mdf-server lnbtc binding + BOLT11");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// JCS
// ---------------------------------------------------------------------------

test("JCS sorts members and emits no whitespace", () => {
  eq(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}', "sorted");
  eq(jcs({ a: [1, "x"] }), '{"a":[1,"x"]}', "arrays keep order");
  eq(jcs("x"), '"x"', "scalars");
  assert(jcs({ "": 1 }).startsWith("{"), "empty key allowed");
});

test("bodyHash of an absent and an empty body agree", () => {
  const empty = createHash("sha256").update("").digest("hex");
  eq(bodyHash(null), empty, "absent");
  eq(bodyHash(""), empty, "empty string");
  eq(bodyHash(Buffer.alloc(0)), empty, "empty buffer");
  assert(bodyHash("x") !== empty, "non-empty differs");
});

test("a present header hashes differently from an absent one", () => {
  const absent = createHash("sha256").update(Buffer.from([0x00])).digest("hex");
  eq(headerValueHash(null), absent, "absent is 0x00");
  const present = createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x01]), Buffer.from("text/markdown", "ascii")]))
    .digest("hex");
  eq(headerValueHash("text/markdown"), present, "present is 0x01 || value");
  assert(headerValueHash("") !== absent, "an empty header is not an absent header");
});

// ---------------------------------------------------------------------------
// The scheme's HTTP binding vectors
// ---------------------------------------------------------------------------

test("the http:1 vector: GET article A hashes to 0d6623f7…", () => {
  const r = computeRequestHash({
    method: "GET",
    url: VECTOR_A.url,
    body: null,
    boundHeaders: [],
  });
  eq(r.canonical, VECTOR_A.canonical, "canonical description matches the spec byte for byte");
  eq(r.requestHash, VECTOR_A.hash, "request hash");
  eq(r.requestBindingParams.headers.length, 0, "no bound headers in the vector");
});

test("the http:1 vector: changing only the URL changes the digest", () => {
  const r = computeRequestHash({
    method: "GET",
    url: "https://api.example.com/article/B",
    body: null,
    boundHeaders: [],
  });
  eq(r.requestHash, VECTOR_B_HASH, "vector B");
});

test("for this server, accept is bound and payment-signature never is", () => {
  const a = computeRequestHash({
    method: "GET",
    url: VECTOR_A.url,
    boundHeaders: ["accept", "payment-signature"],
    headers: { accept: "text/markdown" },
  });
  eq(a.requestBindingParams.headers.join(","), "accept", "payment-signature filtered out");
  assert(a.requestHash !== VECTOR_A.hash, "binding accept changes the digest");

  const html = computeRequestHash({
    method: "GET",
    url: VECTOR_A.url,
    boundHeaders: ["accept"],
    headers: { accept: "text/html" },
  });
  assert(html.requestHash !== a.requestHash, "a different representation is a different binding");

  const absent = computeRequestHash({
    method: "GET",
    url: VECTOR_A.url,
    boundHeaders: ["accept"],
  });
  assert(absent.requestHash !== a.requestHash, "an absent accept is not the markdown one");
});

test("the domain tag is the scheme's", () => {
  eq(BINDING_DOMAIN, "x402:exact:lnbtc:bolt11:http:1", "domain");
});

// ---------------------------------------------------------------------------
// BOLT11: the scheme's invoice vector
// ---------------------------------------------------------------------------

test("the spec invoice decodes to its stated amount, time, hashes and key", () => {
  const inv = decodeBolt11(SPEC_INVOICE);
  eq(inv.currency, "bc", "mainnet currency");
  eq(inv.amountMsat, 25000, "25000 msat (250 nBTC)");
  eq(inv.timestamp, 1700000000, "creation time");
  eq(
    inv.descriptionHash,
    "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
    "description hash is the binding"
  );
  eq(
    inv.paymentHash,
    "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
    "payment hash"
  );
  eq(
    inv.signingKey,
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "recovered signing key (the test-only key 1)"
  );
  eq(inv.description, null, "no inline description");
});

test("malformed invoices are rejected rather than half-parsed", () => {
  for (const bad of ["", "not-an-invoice", SPEC_INVOICE.toUpperCase(), SPEC_INVOICE.slice(0, -1)]) {
    let threw = false;
    try {
      decodeBolt11(bad);
    } catch {
      threw = true;
    }
    assert(threw, `'${bad.slice(0, 16)}…' must throw`);
  }
});

// ---------------------------------------------------------------------------
// checkInvoice
// ---------------------------------------------------------------------------

const DECODED = decodeBolt11(SPEC_INVOICE);
const PUBKEY = DECODED.signingKey;
const NOW = DECODED.timestamp + 10;

// NOTE: the spec's own example invoice carries x=75 s while its
// `PaymentRequirements` example states maxTimeoutSeconds 300, so that pair is
// not itself a conformant challenge. The requirement below uses the invoice's
// real expiry; the mismatch case is asserted separately.
const GOOD: InvoiceRequirements = {
  network: "lnbtc:000000000019d6689c085ae165831e93",
  amountMsat: 25000,
  requestHash: DECODED.descriptionHash!,
  payeePubkey: PUBKEY,
  maxTimeoutSeconds: 75,
};

test("a fully matching invoice passes every check", () => {
  eq(checkInvoice(DECODED, GOOD, NOW).ok, true, "all checks pass");
});

test("each binding violation is refused with its own reason", () => {
  const cases: Array<[string, InvoiceRequirements, string]> = [
    ["amount", { ...GOOD, amountMsat: 24000 }, "amount"],
    ["binding", { ...GOOD, requestHash: "b".repeat(64) }, "description hash"],
    ["payee", { ...GOOD, payeePubkey: "02" + "cd".repeat(32) }, "signing key"],
    ["expiry", { ...GOOD, maxTimeoutSeconds: 300 }, "expiry"],
    [
      "network",
      { ...GOOD, network: "lnbtc:000000000933ea01ad0ee984209779ba" },
      "currency",
    ],
  ];
  for (const [label, req, needle] of cases) {
    const r = checkInvoice(DECODED, req, NOW);
    eq(r.ok, false, `${label} must fail`);
    if (!r.ok) assert(r.reason.includes(needle), `${label} reason mentions '${needle}': ${r.reason}`);
  }
});

test("an expired or future-dated invoice is refused", () => {
  const expired = checkInvoice(DECODED, GOOD, DECODED.timestamp + 75 + 61);
  eq(expired.ok, false, "expired");
  if (!expired.ok) assert(expired.reason.includes("expired"), "expiry reason");

  const future = checkInvoice(DECODED, GOOD, DECODED.timestamp - 120);
  eq(future.ok, false, "created in the future beyond skew");
  if (!future.ok) assert(future.reason.includes("future"), "future reason");

  // Exactly at the skew boundary is still valid, per the scheme.
  eq(checkInvoice(DECODED, GOOD, DECODED.timestamp - 60).ok, true, "inside skew");
});

test("the scheme's own example pair fails its expiry rule (maxTimeout 300 vs x=75)", () => {
  const r = checkInvoice(DECODED, { ...GOOD, maxTimeoutSeconds: 300 }, NOW);
  eq(r.ok, false, "must fail: the invoice expiry is what binds");
  if (!r.ok) assert(r.reason.includes("expiry"), "reason names expiry");
});

// ---------------------------------------------------------------------------
// Preimage
// ---------------------------------------------------------------------------

test("a preimage must be 32 bytes of lowercase hex and hash to the payment hash", () => {
  const preimage = "ab".repeat(32); // letters, so casing is meaningful
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");

  eq(preimageMatches(preimage, hash).ok, true, "matching preimage");
  eq(preimageMatches(preimage.toUpperCase(), hash).ok, false, "uppercase is refused");
  eq(preimageMatches(preimage, "00".repeat(32)).ok, false, "wrong hash");
  eq(preimageMatches("ab".repeat(31), hash).ok, false, "short preimage");
  eq(preimageMatches("zz".repeat(32), hash).ok, false, "non-hex");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
