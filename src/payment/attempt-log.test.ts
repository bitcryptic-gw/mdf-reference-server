/**
 * Attempt logging and its redaction contract.
 *
 * Run with: bun run src/payment/attempt-log.test.ts
 */

import {
  FORBIDDEN_ATTEMPT_FIELDS,
  attemptRecord,
  headerPresent,
  logAttempt,
} from "./attempt-log.ts";

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

const NOW = 1_700_000_000_000;

console.log("mdf-server payment attempt log");
console.log("--------------------------------------------------");

test("the header is recorded by name, and v2 wins when both are present", () => {
  eq(headerPresent({ paymentSignature: "abc", xPayment: null }), "PAYMENT-SIGNATURE", "v2");
  eq(headerPresent({ paymentSignature: null, xPayment: "abc" }), "X-PAYMENT", "v1 name only");
  eq(headerPresent({}), "NONE", "none");
  eq(headerPresent({ paymentSignature: "", xPayment: "" }), "NONE", "empty counts as absent");
  eq(
    headerPresent({ paymentSignature: "abc", xPayment: "def" }),
    "PAYMENT-SIGNATURE",
    "the header the server actually reads"
  );
});

test("a record has exactly the allowlisted fields", () => {
  const record = attemptRecord({
    path: "/premium/deep-dive",
    rail: "exact/eip155:8453",
    headers: { paymentSignature: "super-secret-header-value" },
    outcome: "settled",
    status: 200,
    startedAtMs: NOW - 12,
    nowMs: NOW,
    client: "203.0.113.9",
  });

  eq(Object.keys(record).sort().join(","), "client,event,ms,outcome,path,payment_header,rail,status,ts", "keys");
  eq(record.event, "payment_attempt", "event name");
  eq(record.outcome, "settled", "outcome");
  eq(record.ms, 12, "duration");
  assert(!JSON.stringify(record).includes("super-secret-header-value"), "header value never logged");
});

test("no forbidden field name or secret-shaped value can appear", () => {
  const record = attemptRecord({
    path: "/micropayment/intro",
    rail: "exact/lnbtc:000000000019d6689c085ae165831e93",
    headers: { xPayment: "eyJ4NDAyVmVyc2lvbiI6MX0=" },
    outcome: "verify_fail",
    reason: "invalid_payment",
    status: 402,
    startedAtMs: NOW,
    nowMs: NOW,
  });

  // Field names: none of the forbidden names may exist as a key. (Values are
  // allowed to *name* a header — `payment_header: "X-PAYMENT"` is the point.)
  const keys = Object.keys(record).map((k) => k.toLowerCase());
  for (const field of FORBIDDEN_ATTEMPT_FIELDS) {
    assert(!keys.includes(field), `field '${field}' must not exist (got: ${keys.join(",")})`);
  }
  const serialised = JSON.stringify(record).toLowerCase();
  assert(!serialised.includes("eyj4nday"), "no base64 payload");
  // 64+ hex would be a payment hash, preimage, signature or key. (The lnbtc
  // network id is 32 hex and is a public identifier, not a secret.)
  assert(!/[0-9a-f]{64,}/.test(serialised), "no 64+ hex run (hash, nonce, preimage, signature)");
});

test("the reason is truncated to the coarse vocabulary's scale", () => {
  const record = attemptRecord({
    path: "/x",
    headers: {},
    outcome: "verify_fail",
    reason: "a".repeat(200),
    status: 402,
    startedAtMs: NOW,
    nowMs: NOW,
  });
  eq(record.reason?.length, 64, "capped");
});

test("logAttempt emits one JSON line and returns the record", () => {
  const lines: string[] = [];
  const record = logAttempt(
    {
      path: "/premium/deep-dive",
      headers: { paymentSignature: "abc" },
      outcome: "no_payment",
      status: 402,
      startedAtMs: NOW - 3,
      nowMs: NOW,
    },
    (line) => lines.push(line)
  );
  eq(lines.length, 1, "one line");
  eq(JSON.parse(lines[0]).event, "payment_attempt", "parseable");
  eq(record.status, 402, "returned");
  assert(!lines[0].includes("abc"), "header value absent from the line");
});

test("outcomes are from the fixed vocabulary", () => {
  const outcomes = ["no_payment", "settled", "replay_rejected", "rate_limited", "degraded", "verify_fail", "error"];
  for (const outcome of outcomes) {
    const record = attemptRecord({
      path: "/x",
      headers: {},
      outcome: outcome as never,
      status: 402,
      startedAtMs: NOW,
      nowMs: NOW,
    });
    eq(record.outcome, outcome, `${outcome} accepted`);
  }
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
