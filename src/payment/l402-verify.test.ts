/**
 * L402 verifier tests (Vikunja #42)
 *
 * `verifyL402()` is the only code that enforces payment on the L402 rail
 * (HMAC macaroon, path scope, preimage SHA-256, Alby settlement) and had no
 * test — which is how a stub bypass survived for a week. These exercise it
 * directly with a mocked Alby (no network, no wallet, no real preimage) and
 * through the real router.
 *
 * Run with: bun run src/payment/l402-verify.test.ts
 */

import { createHash, randomBytes } from "crypto";
import { join } from "path";
import { createMacaroon, verifyL402 } from "./payment.ts";
import { handleRequest } from "../router.ts";
import type { LoadedConfig } from "../config/loader.ts";

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

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CONTENT_DIR = join(import.meta.dir, "..", "..", "content");
const TOKEN_SECRET = "TEST-SECRET-NOT-REAL";

function makeLoaded(): LoadedConfig {
  return {
    contentDir: CONTENT_DIR,
    walletAddress: "0xDEAD",
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: CONTENT_DIR, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: {
          "/": { amount: "0.0000", currency: null, chain: null },
          "/docs/**": { amount: "0.0000", currency: null, chain: null },
          "/micropayment/**": { amount: "0.00000001", currency: "BTC", chain: "lightning" },
          "/premium/**": { amount: "1.0000", currency: "USDC", chain: "base" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base", "lightning"],
        accepted_currencies: ["USDC", "BTC"],
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      lightning: {
        api_url: "http://alby.invalid/api",
        invoice_expiry_seconds: 3600,
        api_token: "TEST-TOKEN-NOT-REAL",
        token_secret: TOKEN_SECRET,
      },
    } as LoadedConfig["config"],
  };
}

function scopeOf(urlPath: string): string {
  const parts = urlPath.split("/").filter(Boolean);
  return parts.length > 0 ? `/${parts[0]}` : "/";
}

/** A fresh random 32-byte preimage as 64 hex chars, plus its SHA-256 hex. */
function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString("hex");
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { preimage, paymentHash };
}

function credentialFor(
  urlPath: string,
  ttlSeconds = 300,
  paymentHash?: string,
  preimage?: string
): { header: string; paymentHash: string; preimage: string } {
  const p = paymentHash && preimage
    ? { paymentHash, preimage }
    : makePreimage();
  const macaroon = createMacaroon(p.paymentHash, scopeOf(urlPath), ttlSeconds, TOKEN_SECRET);
  return { header: `L402 ${macaroon}:${p.preimage}`, paymentHash: p.paymentHash, preimage: p.preimage };
}

// ---------------------------------------------------------------------------
// Alby mock
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let albyTransactions: Array<{ paymentHash: string; state: string; preimage: string | null }> = [];

function installFetchMock() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
    const u = String(url);
    if (u.includes("/transactions")) {
      return new Response(JSON.stringify({ transactions: albyTransactions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
function restoreFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
}

function settle(hash: string, preimage: string) {
  albyTransactions = [{ paymentHash: hash, state: "settled", preimage }];
}

async function mute<T>(fn: () => T | Promise<T>): Promise<T> {
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

installFetchMock();
const loaded = makeLoaded();

// ---------------------------------------------------------------------------
// Unit: verifyL402
// ---------------------------------------------------------------------------

console.log("\nverifyL402 — accept\n");

await test("valid credential with matching settled invoice is accepted", async () => {
  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "approved", "approved");
  assertEquals(r.rail, "l402", "rail");
});

await test("scope covers any resource under the paid section", async () => {
  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);
  const r = await mute(() => verifyL402("/micropayment/other-page", c.header, loaded));
  assertEquals(r.status, "approved", "same section is in scope");
});

console.log("\nverifyL402 — reject\n");

await test("wrong preimage is rejected (hash mismatch)", async () => {
  const c = credentialFor("/micropayment/intro");
  const other = randomBytes(32).toString("hex"); // valid hex, wrong preimage
  settle(c.paymentHash, c.preimage);
  const r = await mute(() => verifyL402("/micropayment/intro", `L402 ${c.header.slice(5).split(":")[0]}:${other}`, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("hash"), `reason mentions hash: ${r.reason}`);
});

await test("macaroon scoped to a different path is rejected", async () => {
  const c = credentialFor("/premium/deep-dive"); // scope /premium
  settle(c.paymentHash, c.preimage);
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("scoped"), `reason mentions scope: ${r.reason}`);
});

await test("tampered macaroon signature is rejected", async () => {
  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);
  const mac = c.header.slice(5).split(":")[0];
  const flipped = mac.slice(0, -1) + (mac.slice(-1) === "A" ? "B" : "A");
  const r = await mute(() => verifyL402("/micropayment/intro", `L402 ${flipped}:${c.preimage}`, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("invalid"), `reason mentions invalid: ${r.reason}`);
});

await test("truncated macaroon (no signature separator) is rejected", async () => {
  const c = credentialFor("/micropayment/intro");
  const r = await mute(() =>
    verifyL402("/micropayment/intro", `L402 not-a-macaroon:${c.preimage}`, loaded)
  );
  assertEquals(r.status, "rejected", "rejected");
});

await test("malformed L402 header is rejected", async () => {
  const r = await mute(() => verifyL402("/micropayment/intro", "L402 nonsense", loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("malformed"), `reason: ${r.reason}`);
});

await test("unsettled / pending invoice is rejected", async () => {
  const c = credentialFor("/micropayment/intro");
  albyTransactions = [{ paymentHash: c.paymentHash, state: "pending", preimage: null }];
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("not yet settled"), `reason: ${r.reason}`);
});

await test("unknown invoice (no matching transaction) is rejected", async () => {
  const c = credentialFor("/micropayment/intro");
  albyTransactions = []; // Alby has never seen this hash
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "rejected", "rejected");
});

await test("expired credential is rejected", async () => {
  const c = credentialFor("/micropayment/intro", -10); // expires 10s ago
  settle(c.paymentHash, c.preimage);
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("expired"), `reason: ${r.reason}`);
});

await test("scope is a path-segment boundary, not a bare string prefix", async () => {
  const c = credentialFor("/premium/deep-dive"); // scope /premium
  settle(c.paymentHash, c.preimage);
  const exact = await mute(() => verifyL402("/premium", c.header, loaded));
  const child = await mute(() => verifyL402("/premium/other", c.header, loaded));
  const siblingNoSep = await mute(() => verifyL402("/premiumx/secret", c.header, loaded));
  const siblingDash = await mute(() => verifyL402("/premium-other/x", c.header, loaded));
  assertEquals(exact.status, "approved", "exact scope accepted");
  assertEquals(child.status, "approved", "child of scope accepted");
  assertEquals(siblingNoSep.status, "rejected", "/premiumx must not match scope /premium");
  assertEquals(siblingDash.status, "rejected", "/premium-other must not match scope /premium");
});

await test("credential for one paid section cannot be reused on another", async () => {
  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);
  const ok = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  const cross = await mute(() => verifyL402("/premium/deep-dive", c.header, loaded));
  assertEquals(ok.status, "approved", "own section accepted");
  assertEquals(cross.status, "rejected", "other priced section rejected");
});

await test("settled invoice with a mismatched recorded preimage is rejected", async () => {
  const c = credentialFor("/micropayment/intro");
  // The macaroon/hash are consistent, but Alby's settled record holds a
  // different preimage — belt-and-braces check must reject.
  const recorded = randomBytes(32).toString("hex");
  settle(c.paymentHash, recorded);
  const r = await mute(() => verifyL402("/micropayment/intro", c.header, loaded));
  assertEquals(r.status, "rejected", "rejected");
  assert(r.reason.includes("record") || r.reason.includes("preimage"), `reason: ${r.reason}`);
});

// ---------------------------------------------------------------------------
// Router integration
// ---------------------------------------------------------------------------

console.log("\nRouter integration\n");

async function routerRequest(path: string, headers: Record<string, string>): Promise<Response> {
  return mute(() => handleRequest(new Request(`https://example.com${path}`, { headers }), loaded));
}

await test("router: a valid L402 credential serves a lightning-priced route", async () => {
  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);
  const res = await routerRequest("/micropayment/intro", {
    Accept: "text/markdown",
    Authorization: c.header,
  });
  assertEquals(res.status, 200, "served");
  assertEquals(res.headers.get("vary"), "Accept", "Vary still present");
});

await test("router: an invalid L402 credential returns 402, not content", async () => {
  albyTransactions = [];
  const res = await routerRequest("/micropayment/intro", {
    Accept: "text/markdown",
    Authorization: "L402 nope:nope",
  });
  assertEquals(res.status, 402, "402");
});

await test("router: X-PAYMENT alone never satisfies a lightning route", async () => {
  albyTransactions = [];
  const res = await routerRequest("/micropayment/intro", {
    Accept: "text/markdown",
    "X-PAYMENT": "garbage",
  });
  assertEquals(res.status, 402, "402");
  assertEquals(res.headers.get("cache-control"), "no-store", "no-store");
});

// ---------------------------------------------------------------------------
// Fail closed when lightning is not configured (Vikunja #43)
// ---------------------------------------------------------------------------

await test("verifyL402 rejects, and the router returns 402 (never 200), when lightning is unconfigured", async () => {
  const withoutLightning = makeLoaded();
  delete (withoutLightning.config as { lightning?: unknown }).lightning;

  const c = credentialFor("/micropayment/intro");
  settle(c.paymentHash, c.preimage);

  const direct = await mute(() => verifyL402("/micropayment/intro", c.header, withoutLightning));
  assertEquals(
    direct.status,
    "rejected",
    "the former stub_approved is gone — no approval without verification"
  );

  const res = await mute(() =>
    handleRequest(
      new Request("https://example.com/micropayment/intro", {
        headers: { Accept: "text/markdown", Authorization: c.header },
      }),
      withoutLightning
    )
  );
  assert(res.status !== 200 && res.status !== 304, `never 200/304, got ${res.status}`);
  assertEquals(res.status, 402, "402 for a lightning offer with no configured rail");
});

restoreFetch();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
