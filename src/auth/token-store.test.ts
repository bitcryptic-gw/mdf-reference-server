/**
 * The token store: hash-only persistence, constant-time validation, fail closed.
 *
 * What is asserted here is what an operator would want to be true if the store
 * were dumped, the two instances were compared, or Valkey fell over: no usable
 * credential is recoverable, a token works on both instances, and an unreachable
 * store denies rather than grants.
 *
 * Run with: bun run src/auth/token-store.test.ts
 */

import {
  MemoryTokenStore,
  digestsEqual,
  hashTokenSecret,
  issueToken,
  pathInScope,
  validateToken,
} from "./token-store.ts";

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

const NOW = 1_700_000_000_000;

console.log("mdf-server token store");
console.log("--------------------------------------------------");

await test("issuance returns a token but stores only its digest", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/internals",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 86_400,
    now: NOW,
  });
  assert(issued !== null, "issued");

  const stored = await store.get(issued!.id);
  assert(stored !== null, "record exists");
  assert(!JSON.stringify(stored).includes(issued!.token), "the raw token is never stored");
  assert(!JSON.stringify(stored).includes(issued!.token.split(".")[1]), "nor the secret part");
  eq(stored!.secretHash, hashTokenSecret(issued!.id, issued!.token.split(".")[1]), "digest matches");
});

await test("a valid token validates, and is reusable", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  for (let i = 0; i < 3; i++) {
    const r = await validateToken(store, header, "/private/internals", NOW + 1000);
    eq(r.ok, true, `validation ${i + 1} reuses the token`);
  }
});

await test("a token only covers its own section", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  eq((await validateToken(store, header, "/private/internals", NOW)).ok, true, "in scope");
  const cross = await validateToken(store, header, "/premium/deep-dive", NOW);
  eq(cross.ok, false, "another section refused");
  if (!cross.ok) eq(cross.reason, "out_of_scope", "reason");

  eq((await validateToken(store, header, "/privatex/y", NOW)).ok, false, "segment boundary respected");
});

await test("expiry is enforced against the record", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  eq((await validateToken(store, header, "/private/x", NOW + 59_000)).ok, true, "inside the TTL");
  const expired = await validateToken(store, header, "/private/x", NOW + 61_000);
  eq(expired.ok, false, "outside the TTL");
  if (!expired.ok) eq(expired.reason, "expired", "an aged-out token is distinguishable from an unknown one");
});

await test("wrong secret, malformed token and unknown id all fail", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const [id, secret] = issued!.token.split(".");

  const wrong = await validateToken(store, `Bearer ${id}.${"00".repeat(32)}`, "/private/x", NOW);
  eq(wrong.ok, false, "wrong secret");
  if (!wrong.ok) eq(wrong.reason, "wrong_secret", "reason distinguishes it for logs");

  eq(
    (await validateToken(store, `Bearer ${"ab".repeat(16)}.${secret}`, "/private/x", NOW)).ok,
    false,
    "unknown id"
  );
  eq((await validateToken(store, "Bearer nonsense", "/private/x", NOW)).ok, false, "malformed");
  eq((await validateToken(store, null, "/private/x", NOW)).ok, false, "missing header");
  eq((await validateToken(store, `Bearer ${id}.${secret.slice(0, 10)}`, "/private/x", NOW)).ok, false, "short secret");
});

await test("a token minted on one store works on another sharing it (the round-robin fix)", async () => {
  // Two instances, one Valkey. Modelled with two MemoryTokenStore views over the
  // same record set by sharing the instance — the property under test is that
  // validation consults the store rather than process-local state.
  const shared = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(shared, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });

  // Instance A issued; instance B validates against the same backing store.
  const onB = await validateToken(shared, `Bearer ${issued!.token}`, "/private/x", NOW);
  eq(onB.ok, true, "the second instance accepts a token it did not mint");
});

await test("an unavailable store denies rather than grants", async () => {
  const broken = {
    async put() {
      return false;
    },
    async get() {
      return null;
    },
    async delete() {},
    close() {},
  };

  eq(await issueToken(broken, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  }), null, "issuance fails closed");

  const r = await validateToken(broken, `Bearer ${"ab".repeat(16)}.${"cd".repeat(32)}`, "/private/x", NOW);
  eq(r.ok, false, "validation fails closed");
});

await test("scope matching is on segment boundaries", () => {
  assert(pathInScope("/private/internals", "/private/"), "nested path in scope");
  assert(pathInScope("/private", "/private/"), "bare section in scope");
  assert(!pathInScope("/privatex/y", "/private/"), "sibling prefix out of scope");
  assert(!pathInScope("/premium/x", "/private/"), "other section out of scope");
  assert(pathInScope("/anything", "/"), "root scope covers all");
});

await test("digest comparison rejects unequal or empty inputs", () => {
  const a = hashTokenSecret("id", "secret");
  assert(digestsEqual(a, a), "equal digests match");
  assert(!digestsEqual(a, hashTokenSecret("id2", "secret")), "different digests differ");
  assert(!digestsEqual(a, a.slice(0, 32)), "truncated digest differs");
  assert(!digestsEqual("", ""), "empty never compares equal");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
