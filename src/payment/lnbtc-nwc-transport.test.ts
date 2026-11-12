/**
 * NWC over a real WebSocket, against an in-process fake relay and wallet.
 *
 * The transport is the part of the lnbtc rail that cannot be unit-tested by
 * inspection: event ids, BIP-340 signatures, the subscription filter, NIP-44 in
 * both directions, and the timeout. So this test stands up an actual WS relay
 * (Bun.serve) acting as the wallet — it decrypts our request, answers it, and the
 * client has to verify and accept it — and then breaks it in the specific ways
 * that matter.
 *
 * Run with: bun run src/payment/lnbtc-nwc-transport.test.ts
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { decrypt, encrypt, getConversationKey } from "./lnbtc/nip44.ts";
import { NwcClient, NwcError, classifyErrorCode } from "./lnbtc/nwc.ts";
import { eventId, signEvent, verifyEvent } from "./lnbtc/relay.ts";

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

async function throwsKind(fn: () => Promise<unknown>, kind: string, m: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NwcError) {
      eq(err.kind, kind, `${m} (got: ${err.message})`);
      return;
    }
    throw err;
  }
  throw new Error(`${m}: expected a rejection`);
}

// ---------------------------------------------------------------------------
// An in-process relay that also behaves as the wallet
// ---------------------------------------------------------------------------

const WALLET_PRIV = Buffer.from(
  createHash("sha256").update("mdf-nwc-test-wallet").digest()
).toString("hex");
const WALLET_PUB = Buffer.from(schnorr.getPublicKey(Buffer.from(WALLET_PRIV, "hex"))).toString("hex");

interface WalletBehaviour {
  /** What get_info reports for `methods` (undefined = omit the field). */
  methods?: string[] | null;
  /** force a NIP-47 error response. */
  error?: { code: string; message: string };
  /** do not answer at all. */
  silent?: boolean;
  /** answer from a different (wrong) key. */
  impostor?: boolean;
}

let behaviour: WalletBehaviour = {};
let lastRequest: { method?: string; params?: Record<string, unknown> } = {};

async function startRelay(): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve<{ subId?: string; requestId?: string; clientPubkey?: string }>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} })) return;
      return new Response("relay", { status: 200 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as unknown[];
        const type = msg[0];

        if (type === "REQ") {
          ws.data.subId = String(msg[1]);
          return;
        }

        if (type !== "EVENT") return;
        const event = msg[1] as {
          id: string;
          pubkey: string;
          kind: number;
          tags: string[][];
          content: string;
        };
        if (event.kind !== 23194) return;

        const clientPubkey = event.pubkey;
        const encryptionTag = event.tags.find((t) => t[0] === "encryption");
        const conversationKey = getConversationKey(WALLET_PRIV, clientPubkey);
        lastRequest = JSON.parse(decrypt(event.content, conversationKey)) as {
          method?: string;
          params?: Record<string, unknown>;
        };

        // Only NIP-44 is implemented; a client that asked for NIP-04 would fail here.
        if (!encryptionTag || encryptionTag[1] !== "nip44_v2") {
          ws.send(JSON.stringify(["OK", event.id, false, "unsupported encryption"]));
          return;
        }

        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        if (behaviour.silent) return;

        const result =
          lastRequest.method === "make_invoice"
            ? {
                invoice: "lnbc10n1p3faketestinvoice",
                payment_hash: "ab".repeat(32),
                amount: lastRequest.params?.amount,
                expiry: lastRequest.params?.expiry,
              }
            : {
                alias: "fake-wallet",
                pubkey: WALLET_PUB,
                network: "bitcoin",
                ...(behaviour.methods === null ? {} : { methods: behaviour.methods ?? ["make_invoice", "get_info"] }),
              };

        const payload = behaviour.error
          ? { result_type: lastRequest.method, error: behaviour.error, result: null }
          : { result_type: lastRequest.method, error: null, result };

        const signerPriv = behaviour.impostor
          ? Buffer.from(createHash("sha256").update("impostor").digest()).toString("hex")
          : WALLET_PRIV;

        const response = signEvent(
          {
            kind: 23195,
            tags: [
              ["e", event.id],
              ["p", clientPubkey],
              ["encryption", "nip44_v2"],
            ],
            content: encrypt(JSON.stringify(payload), conversationKey, Buffer.from("11".repeat(32), "hex")),
          },
          signerPriv
        );

        ws.send(JSON.stringify(["EVENT", ws.data.subId ?? "sub", response]));
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const relay = await startRelay();
const uri = (relays: string[] = [relay.url]) =>
  `nostr+walletconnect://${WALLET_PUB}?${relays
    .map((r) => `relay=${encodeURIComponent(r)}`)
    .join("&")}&secret=${"cd".repeat(32)}`;

console.log("mdf-server NWC transport");
console.log("--------------------------------------------------");

// ---------------------------------------------------------------------------
// Event primitives
// ---------------------------------------------------------------------------

await test("an event id is the NIP-01 hash of its serialisation, and the signature verifies", () => {
  const event = signEvent(
    { kind: 23194, tags: [["p", WALLET_PUB]], content: "hello", created_at: 1_700_000_000 },
    WALLET_PRIV
  );
  const expectedId = createHash("sha256")
    .update(
      JSON.stringify([0, event.pubkey, 1_700_000_000, 23194, [["p", WALLET_PUB]], "hello"]),
      "utf8"
    )
    .digest("hex");
  eq(event.id, expectedId, "id");
  assert(schnorr.verify(Buffer.from(event.sig,"hex"), Buffer.from(event.id,"hex"), Buffer.from(event.pubkey,"hex")), "signature verifies");
  eq(verifyEvent(event, event.pubkey).ok, true, "our verifier accepts it");
});

await test("a tampered event is rejected, and so is one from the wrong author", () => {
  const event = signEvent({ kind: 23195, tags: [], content: "x", created_at: 1_700_000_000 }, WALLET_PRIV);
  eq(verifyEvent({ ...event, content: "y" }, event.pubkey).ok, false, "content change breaks the id");
  eq(verifyEvent(event, "e".repeat(64)).ok, false, "author mismatch");
  eq(verifyEvent({ ...event, sig: "00".repeat(64) }, event.pubkey).ok, false, "bad signature");
  eq(verifyEvent({ nonsense: true }, event.pubkey).ok, false, "malformed");
});

// ---------------------------------------------------------------------------
// make_invoice over the wire
// ---------------------------------------------------------------------------

await test("makeInvoice sends amount, description hash and expiry, and returns the invoice", async () => {
  behaviour = {};
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 3000, connectTimeoutMs: 2000 });
  const made = await client.makeInvoice({
    amountMsat: 20_000,
    descriptionHash: "ef".repeat(32),
    expirySeconds: 300,
  });

  eq(lastRequest.method, "make_invoice", "method");
  eq(lastRequest.params?.amount, 20_000, "amount in millisatoshis");
  eq(lastRequest.params?.description_hash, "ef".repeat(32), "description hash");
  eq(lastRequest.params?.expiry, 300, "expiry equals maxTimeoutSeconds");
  eq(made.invoice, "lnbc10n1p3faketestinvoice", "invoice returned");
  eq(made.paymentHash, "ab".repeat(32), "payment hash returned");
});

await test("makeInvoice refuses a bad description hash or sub-satoshi amount before connecting", async () => {
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 1000, connectTimeoutMs: 1000 });
  await throwsKind(
    () => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "nope", expirySeconds: 300 }),
    "malformed",
    "bad hash"
  );
  await throwsKind(
    () => client.makeInvoice({ amountMsat: 1500, descriptionHash: "ef".repeat(32), expirySeconds: 300 }),
    "malformed",
    "sub-satoshi amount"
  );
});

await test("getInfo reports the connection's methods", async () => {
  behaviour = { methods: ["make_invoice", "get_info"] };
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 3000, connectTimeoutMs: 2000 });
  const info = await client.getInfo();
  eq(info.alias, "fake-wallet", "alias");
  eq(info.methods?.join(","), "make_invoice,get_info", "methods");
});

await test("getInfo reports null methods when the wallet does not list them", async () => {
  behaviour = { methods: null };
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 3000, connectTimeoutMs: 2000 });
  const info = await client.getInfo();
  eq(info.methods, null, "unreported, not invented");
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

await test("a NIP-47 error becomes a categorised NwcError", async () => {
  behaviour = { error: { code: "UNAUTHORIZED", message: "restricted" } };
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 3000, connectTimeoutMs: 2000 });
  await throwsKind(() => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "ef".repeat(32), expirySeconds: 300 }), "auth", "auth error");

  behaviour = { error: { code: "INTERNAL", message: "no liquidity" } };
  await throwsKind(() => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "ef".repeat(32), expirySeconds: 300 }), "rejected", "rejection");
});

await test("a silent wallet times out rather than hanging the request", async () => {
  behaviour = { silent: true };
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 300, connectTimeoutMs: 1000 });
  await throwsKind(
    () => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "ef".repeat(32), expirySeconds: 300 }),
    "timeout",
    "silent wallet"
  );
});

await test("a response signed by the wrong key is ignored, so the call times out", async () => {
  behaviour = { impostor: true };
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 300, connectTimeoutMs: 1000 });
  await throwsKind(
    () => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "ef".repeat(32), expirySeconds: 300 }),
    "timeout",
    "impostor response must not be accepted"
  );
});

await test("an unreachable relay is 'unreachable'", async () => {
  behaviour = {};
  const client = new NwcClient({
    uri: uri(["ws://127.0.0.1:1"]),
    responseTimeoutMs: 500,
    connectTimeoutMs: 500,
  });
  await throwsKind(
    () => client.makeInvoice({ amountMsat: 20_000, descriptionHash: "ef".repeat(32), expirySeconds: 300 }),
    "unreachable",
    "no relay"
  );
});

await test("a malformed URI never leaks the secret in the error", async () => {
  const secret = "ff".repeat(32);
  const bad = `nostr+walletconnect://short?relay=${encodeURIComponent(relay.url)}&secret=${secret}`;
  try {
    new NwcClient({ uri: bad });
    throw new Error("should have thrown");
  } catch (err) {
    assert(err instanceof NwcError, "typed error");
    assert(!String((err as Error).message).includes(secret), "secret must not appear in the message");
  }
});

await test("describe() redacts the secret", () => {
  const client = new NwcClient({ uri: uri(), responseTimeoutMs: 1000, connectTimeoutMs: 1000 });
  const described = client.describe();
  assert(!described.includes("cd".repeat(32)), "secret redacted");
  assert(described.includes(WALLET_PUB), "wallet pubkey retained");
});

await test("error codes classify onto the breaker's categories", () => {
  eq(classifyErrorCode("UNAUTHORIZED", ""), "auth", "unauthorized");
  eq(classifyErrorCode("RESTRICTED", ""), "auth", "restricted");
  eq(classifyErrorCode("INTERNAL", "timed out"), "timeout", "timeout");
  eq(classifyErrorCode("NOT_FOUND", ""), "rejected", "not found");
  eq(classifyErrorCode("INTERNAL", "insufficient balance"), "rejected", "insufficient");
  eq(classifyErrorCode("", "connection refused"), "unreachable", "connection");
});

relay.stop();

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
