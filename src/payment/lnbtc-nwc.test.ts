/**
 * NWC credentials, NIP-44, and the replay store.
 *
 * The three things most likely to be silently wrong in a Lightning integration
 * are pinned here: the encryption (against NIP-44's published vector), the
 * credential's blast radius (a connection that can spend money must stop the
 * server), and the replay TTL (too short leaves a window where a preimage
 * outlives its record).
 *
 * Run with: bun run src/payment/lnbtc-nwc.test.ts
 */

import { getPublicKey } from "@noble/secp256k1";
import { randomBytes } from "node:crypto";
import {
  calcPaddedLen,
  decrypt,
  encrypt,
  getConversationKey,
  getMessageKeys,
  pad,
  unpad,
} from "./lnbtc/nip44.ts";
import {
  ALLOWED_NWC_METHODS,
  judgeNwcPermissions,
  parseNwcUri,
  redactNwcUri,
} from "./lnbtc/nwc-uri.ts";
import {
  MemoryReplayStore,
  REPLAY_RETENTION_AFTER_EXPIRY_SECONDS,
  REPLAY_SKEW_SECONDS,
  parseResp,
  replayKey,
  replayTtlSeconds,
} from "./lnbtc/replay-store.ts";

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

function throws(fn: () => unknown, m: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, m);
}

// NIP-44's published vector: secret keys 1 and 2, nonce 1.
const SEC1 = "0000000000000000000000000000000000000000000000000000000000000001";
const SEC2 = "0000000000000000000000000000000000000000000000000000000000000002";
const PUB2 = Buffer.from(getPublicKey(SEC2)).toString("hex");
const NONCE = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000001",
  "hex"
);
const VECTOR_KEY = "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d";
const VECTOR_PAYLOAD =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";

console.log("mdf-server NWC credential, NIP-44 and replay store");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// NIP-44 v2
// ---------------------------------------------------------------------------

await test("the conversation key matches the NIP-44 vector", () => {
  const ck = Buffer.from(getConversationKey(SEC1, PUB2)).toString("hex");
  eq(ck, VECTOR_KEY, "HKDF-Extract over the raw x coordinate");
  // The reverse direction must agree.
  const PUB1 = Buffer.from(getPublicKey(SEC1)).toString("hex");
  eq(Buffer.from(getConversationKey(SEC2, PUB1)).toString("hex"), VECTOR_KEY, "symmetric");
});

await test("encrypting 'a' with nonce 1 reproduces the published payload byte for byte", () => {
  const ck = getConversationKey(SEC1, PUB2);
  eq(encrypt("a", ck, NONCE), VECTOR_PAYLOAD, "payload");
});

await test("decrypt returns the plaintext, and a tampered payload is rejected", () => {
  const ck = getConversationKey(SEC1, PUB2);
  eq(decrypt(VECTOR_PAYLOAD, ck), "a", "round trip");

  const raw = Buffer.from(VECTOR_PAYLOAD, "base64");
  const tampered = Buffer.from(raw);
  tampered[40] ^= 0x01; // flip a ciphertext byte
  throws(
    () => decrypt(tampered.toString("base64"), ck),
    "a modified ciphertext must fail the MAC"
  );

  const wrongVersion = Buffer.from(raw);
  wrongVersion[0] = 1;
  throws(() => decrypt(wrongVersion.toString("base64"), ck), "version must be 2");

  throws(() => decrypt("not base64 !!", ck), "base64 alphabet enforced");
  throws(() => decrypt("", ck), "empty payload refused");
});

await test("padding follows the NIP's chunking rule", () => {
  eq(calcPaddedLen(1), 32, "1 byte → 32");
  eq(calcPaddedLen(32), 32, "32 → 32");
  eq(calcPaddedLen(33), 64, "33 → 64");
  eq(calcPaddedLen(100), 128, "100 → 128");
  eq(calcPaddedLen(1024), 1024, "exact chunk stays");
  eq(calcPaddedLen(1025), 1280, "1025 → 1280 (chunk = next_power/8 = 256)");

  // A long message round-trips, which is the property that matters at any size.
  const ck = getConversationKey(SEC1, PUB2);
  const long = "x".repeat(70_000); // crosses the 65536 extended-prefix boundary
  const payload = encrypt(long, ck, randomBytes(32) as unknown as Uint8Array);
  eq(decrypt(payload, ck), long, "extended prefix round-trips");
});

await test("unpad rejects a length that does not match the padding rule", () => {
  const padded = pad("abc");
  eq(unpad(padded), "abc", "round trip");
  throws(() => unpad(padded.subarray(0, padded.length - 1)), "short padded buffer");
  const badLength = Buffer.from(padded);
  badLength[1] = 40; // claim 40 bytes for a 3-byte plaintext
  throws(() => unpad(new Uint8Array(badLength)), "mismatched prefix length");
});

await test("message keys are 32/12/32 bytes split from 76", () => {
  const ck = getConversationKey(SEC1, PUB2);
  const keys = getMessageKeys(ck, NONCE);
  eq(keys.chachaKey.length, 32, "chacha key");
  eq(keys.chachaNonce.length, 12, "chacha nonce");
  eq(keys.hmacKey.length, 32, "hmac key");
});

// ---------------------------------------------------------------------------
// NWC URI
// ---------------------------------------------------------------------------

const PUB_WALLET = "b".repeat(64);
const SECRET = "c".repeat(64);
const VALID_URI = `nostr+walletconnect://${PUB_WALLET}?relay=wss%3A%2F%2Frelay.getalby.com&secret=${SECRET}`;

await test("a well-formed URI parses", () => {
  const r = parseNwcUri(VALID_URI);
  eq(r.ok, true, "parsed");
  if (r.ok) {
    eq(r.value.walletPubkey, PUB_WALLET, "wallet pubkey");
    eq(r.value.relays[0], "wss://relay.getalby.com", "relay decoded");
    eq(r.value.secret, SECRET, "secret");
  }
});

await test("multiple relays and a ws:// self-hosted relay are accepted", () => {
  const uri = `nostr+walletconnect://${PUB_WALLET}?relay=${encodeURIComponent(
    "wss://relay.getalby.com"
  )}&relay=${encodeURIComponent("ws://mdf-relay:7777")}&secret=${SECRET}`;
  const r = parseNwcUri(uri);
  eq(r.ok, true, "parsed");
  if (r.ok) eq(r.value.relays.length, 2, "both relays");
});

await test("malformed URIs are refused with a specific reason", () => {
  const cases: Array<[string, string]> = [
    ["https://example.com", "not_a_nwc_uri"],
    [`nostr+walletconnect://short?relay=wss%3A%2F%2Fr&secret=${SECRET}`, "malformed_wallet_pubkey"],
    [`nostr+walletconnect://${PUB_WALLET}?relay=wss%3A%2F%2Fr`, "malformed_secret"],
    [`nostr+walletconnect://${PUB_WALLET}?secret=${SECRET}`, "no_relay"],
    [`nostr+walletconnect://${PUB_WALLET}?relay=http%3A%2F%2Fr&secret=${SECRET}`, "malformed_relay"],
  ];
  for (const [uri, reason] of cases) {
    const r = parseNwcUri(uri);
    eq(r.ok, false, `${reason} must be refused`);
    if (!r.ok) eq(r.reason, reason, "reason");
  }
});

await test("redaction keeps the pubkey and relays but never the secret", () => {
  const red = redactNwcUri(VALID_URI);
  assert(!red.includes(SECRET), "secret must not appear");
  assert(red.includes(PUB_WALLET), "wallet pubkey may appear (it is public)");
  assert(red.includes("relay.getalby.com"), "relay visible for diagnosis");
  assert(red.includes("<redacted>"), "marks the removal");
  eq(redactNwcUri("garbage"), "nostr+walletconnect://<unparseable>", "unparseable input");
});

// ---------------------------------------------------------------------------
// Least privilege
// ---------------------------------------------------------------------------

await test("make_invoice alone is exactly what we want", () => {
  const v = judgeNwcPermissions(["make_invoice"]);
  eq(v.ok, true, "accepted");
  if (v.ok) eq(v.verified, true, "verified from the reported methods");
});

await test("make_invoice plus get_info is accepted (get_info only verifies)", () => {
  const v = judgeNwcPermissions(["make_invoice", "get_info"]);
  eq(v.ok, true, "accepted");
});

await test("any spending method refuses startup", () => {
  for (const spend of ["pay_invoice", "pay_keysend", "multi_pay_invoice", "multi_pay_keysend"]) {
    const v = judgeNwcPermissions(["make_invoice", spend]);
    eq(v.ok, false, `${spend} must be refused`);
    if (!v.ok) assert(v.reason.includes("spending"), "reason says why");
  }
});

await test("an unexpected non-spending method is refused too (least privilege)", () => {
  const v = judgeNwcPermissions(["make_invoice", "lookup_invoice"]);
  eq(v.ok, false, "lookup_invoice is not requested, so it is a wider credential than needed");
  if (!v.ok) assert(v.reason.includes("lookup_invoice"), "names the method");
});

await test("a connection without make_invoice is useless and refused", () => {
  const v = judgeNwcPermissions(["get_info"]);
  eq(v.ok, false, "no minting possible");
});

await test("no reported permissions is unverified, not a refusal", () => {
  const v = judgeNwcPermissions(null);
  eq(v.ok, true, "startup may continue");
  if (v.ok) {
    eq(v.verified, false, "but it is flagged");
    assert(v.reason.includes("get_info"), "explains the manual check");
  }
});

await test("the allowlist is exactly make_invoice + get_info", () => {
  eq([...ALLOWED_NWC_METHODS].sort().join(","), "get_info,make_invoice", "allowlist");
});

// ---------------------------------------------------------------------------
// Replay store
// ---------------------------------------------------------------------------

await test("the replay TTL covers the invoice window plus the retention floor", () => {
  // 300 s offer + 60 s skew + 3600 s retention.
  eq(replayTtlSeconds(300), 3960, "demo numbers");
  eq(replayTtlSeconds(300, 0), 3900, "no skew");
  eq(REPLAY_SKEW_SECONDS, 60, "skew default");
  eq(REPLAY_RETENTION_AFTER_EXPIRY_SECONDS, 3600, "retention floor");

  for (const expiry of [60, 300, 3600, 86400]) {
    assert(
      replayTtlSeconds(expiry) >= expiry + REPLAY_SKEW_SECONDS + REPLAY_RETENTION_AFTER_EXPIRY_SECONDS,
      `TTL must outlive the payable window at ${expiry}s`
    );
  }
  throws(() => replayTtlSeconds(0), "a zero expiry is not a TTL");
});

await test("the key is the scheme's canonical network:payment_hash", () => {
  eq(
    replayKey("lnbtc:000000000019d6689c085ae165831e93", "AABB".repeat(16)),
    "lnbtc:000000000019d6689c085ae165831e93:" + "aabb".repeat(16),
    "network colon hash, hash lowercased"
  );
});

await test("a claim is single-use, and the same hash on another network is a different key", async () => {
  const store = new MemoryReplayStore();
  const hash = "11".repeat(32);
  const net = "lnbtc:000000000019d6689c085ae165831e93";

  eq(await store.claim(net, hash, 3960), "claimed", "first claim");
  eq(await store.claim(net, hash, 3960), "duplicate", "second claim refused");
  eq(
    await store.claim("lnbtc:000000000933ea01ad0ee984209779ba", hash, 3960),
    "claimed",
    "a different network is a different payment"
  );
});

await test("a claim expires with its TTL, and only then", async () => {
  let now = 1_000_000;
  const store = new MemoryReplayStore(() => now);
  const hash = "22".repeat(32);
  const net = "lnbtc:000000000019d6689c085ae165831e93";

  eq(await store.claim(net, hash, 100), "claimed", "claim");
  now += 99_000;
  eq(await store.claim(net, hash, 100), "duplicate", "still inside the TTL");
  now += 2_000;
  eq(await store.claim(net, hash, 100), "claimed", "expired record no longer blocks");
});

await test("concurrent claims on one hash settle exactly once", async () => {
  const store = new MemoryReplayStore();
  const hash = "33".repeat(32);
  const net = "lnbtc:000000000019d6689c085ae165831e93";
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.claim(net, hash, 3960))
  );
  eq(results.filter((r) => r === "claimed").length, 1, "exactly one claim wins");
  eq(results.filter((r) => r === "duplicate").length, 7, "the rest are duplicates");
});

await test("RESP replies parse, including NX returning nil", () => {
  const ok = parseResp(Buffer.from("+OK\r\n"));
  eq(ok?.reply.kind, "simple", "simple string");
  eq(ok?.reply.value, "OK", "value");
  eq(parseResp(Buffer.from("$-1\r\n"))?.reply.kind, "nil", "nil bulk (NX failure)");
  eq(parseResp(Buffer.from("-ERR nope\r\n"))?.reply.kind, "error", "error");
  eq(parseResp(Buffer.from(":1\r\n"))?.reply.value, "1", "integer");
  eq(parseResp(Buffer.from("$5\r\nhel")), null, "incomplete bulk returns null");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
