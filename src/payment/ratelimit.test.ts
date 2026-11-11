/**
 * Client-key derivation and the mint buckets.
 *
 * The key test is the deployment we actually run: Caddy is on another host and
 * reaches the server over the tailnet, so *every* request's transport peer is
 * Caddy. Trusting `X-Real-IP` unconditionally would put every visitor in one
 * shared 12/min bucket; trusting it never would put them all behind Caddy's
 * address anyway. The trusted-proxy list is what makes the difference, and this
 * file pins all four quadrants of it.
 *
 * Run with: bun run src/payment/ratelimit.test.ts
 */

import { isTrustedProxy, normaliseIp, resolveClientKey } from "./client-key.ts";
import {
  DEFAULT_MINT_LIMITS,
  KeyedBuckets,
  MintLimiter,
  TokenBucket,
} from "./rate-limit.ts";

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

const CADDY = "100.76.221.87"; // caddy-linode, the only trusted proxy today
const USER = "203.0.113.9";

console.log("mdf-server client key + mint limiter");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// IP normalisation
// ---------------------------------------------------------------------------

test("IP literals normalise, and non-literals do not", () => {
  eq(normaliseIp("203.0.113.9"), "203.0.113.9", "ipv4");
  eq(normaliseIp(" 203.0.113.9 "), "203.0.113.9", "trimmed");
  eq(normaliseIp("2001:DB8::1"), "2001:db8::1", "ipv6 lowercased");
  eq(normaliseIp("::ffff:203.0.113.9"), "203.0.113.9", "ipv4-mapped ipv6");
  eq(normaliseIp("[2001:db8::1]"), "2001:db8::1", "bracketed");
  eq(normaliseIp("2001:db8::1%eth0"), "2001:db8::1", "zone dropped");

  eq(normaliseIp("203.0.113.9:443"), null, "port is not an IP literal");
  eq(normaliseIp("example.com"), null, "hostname is not an IP literal");
  eq(normaliseIp("203.0.113.9, 198.51.100.1"), null, "a chain is not a single literal");
  eq(normaliseIp(""), null, "empty");
  eq(normaliseIp(null), null, "null");
});

// ---------------------------------------------------------------------------
// Trusted-proxy decisions (the review's four cases)
// ---------------------------------------------------------------------------

test("trusted proxy + valid header → the header's IP", () => {
  const r = resolveClientKey({
    peer: CADDY,
    forwardedForHeader: USER,
    trustedProxies: [CADDY],
  });
  eq(r.key, USER, "keys on the real client");
  eq(r.source, "header", "source records why");
});

test("untrusted peer + header → the peer's IP", () => {
  const r = resolveClientKey({
    peer: "198.51.100.7",
    forwardedForHeader: USER,
    trustedProxies: [CADDY],
  });
  eq(r.key, "198.51.100.7", "a direct caller cannot claim another IP");
  eq(r.source, "peer", "source records the fallback");
});

test("trusted proxy + junk header → the peer's IP", () => {
  for (const junk of ["not-an-ip", "203.0.113.9, 198.51.100.1", "203.0.113.9:443", ""]) {
    const r = resolveClientKey({
      peer: CADDY,
      forwardedForHeader: junk,
      trustedProxies: [CADDY],
    });
    eq(r.key, CADDY, `junk '${junk}' must not be used`);
    eq(r.source, "peer", "falls back to the peer");
  }
});

test("empty trusted-proxy list → the peer's IP, even from Caddy", () => {
  const r = resolveClientKey({
    peer: CADDY,
    forwardedForHeader: USER,
    trustedProxies: [],
  });
  eq(r.key, CADDY, "trusts nothing by default");
  eq(r.source, "peer", "peer source");
});

test("a missing peer keys as 'unknown' rather than throwing", () => {
  const r = resolveClientKey({ peer: null, forwardedForHeader: USER, trustedProxies: [CADDY] });
  eq(r.key, "unknown", "no peer, no trust");
  eq(r.source, "unknown", "source");
});

test("the trust list is compared after normalisation", () => {
  assert(isTrustedProxy("::ffff:100.76.221.87", [CADDY]), "ipv4-mapped peer matches");
  assert(isTrustedProxy(CADDY, ["100.76.221.087".replace("087", "87")]), "same IP");
  assert(!isTrustedProxy("100.76.221.88", [CADDY]), "different IP does not match");
  assert(!isTrustedProxy(CADDY, ["caddy-linode"]), "a hostname in the list never matches");
});

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

test("a bucket allows a burst, then refuses with a retry hint", () => {
  const b = new TokenBucket({ capacity: 3, perMinute: 60 }, 0);
  eq(b.take(0).ok, true, "1");
  eq(b.take(0).ok, true, "2");
  eq(b.take(0).ok, true, "3");
  const refused = b.take(0);
  eq(refused.ok, false, "burst exhausted");
  assert((refused.retryAfterSeconds ?? 0) > 0, "retry hint present");
});

test("tokens refill continuously", () => {
  const b = new TokenBucket({ capacity: 2, perMinute: 60 }, 0); // 1 token/second
  b.take(0);
  b.take(0);
  eq(b.take(500).ok, false, "half a second is not a token");
  eq(b.take(1000).ok, true, "one second is");
});

test("the per-client bucket isolates clients", () => {
  const buckets = new KeyedBuckets({ capacity: 2, perMinute: 60 });
  eq(buckets.take("a", 0).ok, true, "a1");
  eq(buckets.take("a", 0).ok, true, "a2");
  eq(buckets.take("a", 0).ok, false, "a exhausted");
  eq(buckets.take("b", 0).ok, true, "b is unaffected");
});

test("the global bucket is checked first and refuses everyone", () => {
  const limiter = new MintLimiter(
    { global: { capacity: 2, perMinute: 60 }, perClient: { capacity: 5, perMinute: 60 } },
    0
  );
  eq(limiter.tryTake("a", 0).ok, true, "1");
  eq(limiter.tryTake("b", 0).ok, true, "2");
  const refused = limiter.tryTake("c", 0);
  eq(refused.ok, false, "global ceiling");
  eq(refused.scope, "global", "reports which ceiling");
});

test("a client that exhausts its own bucket does not touch the global ceiling", () => {
  const limiter = new MintLimiter(
    { global: { capacity: 10, perMinute: 60 }, perClient: { capacity: 1, perMinute: 60 } },
    0
  );
  eq(limiter.tryTake("noisy", 0).ok, true, "first");
  const refused = limiter.tryTake("noisy", 0);
  eq(refused.ok, false, "own bucket");
  eq(refused.scope, "client", "client scope");
  eq(limiter.tryTake("quiet", 0).ok, true, "another client still mints");
});

test("the defaults keep Kuma probes under 10% of both budgets", () => {
  // Two monitors at one probe per 5 minutes = 0.4/min; at 60 s cadence = 2/min.
  const globalShare = 2 / DEFAULT_MINT_LIMITS.global.perMinute;
  const clientShare = 2 / DEFAULT_MINT_LIMITS.perClient.perMinute;
  assert(globalShare < 0.1, `global share ${globalShare}`);
  assert(clientShare < 0.1, `client share ${clientShare}`);
  eq(DEFAULT_MINT_LIMITS.global.perMinute, 180, "global/min");
  eq(DEFAULT_MINT_LIMITS.perClient.perMinute, 24, "per-client/min");
});

test("the keyed bucket map stays bounded under a wide scan", () => {
  const buckets = new KeyedBuckets({ capacity: 1, perMinute: 60 }, 50);
  for (let i = 0; i < 500; i++) {
    buckets.take(`10.0.${Math.floor(i / 250)}.${i % 250}`, i * 1000);
  }
  assert(buckets.size() <= 50, `map size ${buckets.size()} must stay at or below the cap`);
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
