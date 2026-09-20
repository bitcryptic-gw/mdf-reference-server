/**
 * Router ordering regression test
 *
 * The unknown-path bug: the router ran payment verification before checking
 * whether the requested resource existed, so an unknown path under a section
 * with non-zero default pricing was advertised as a payable resource (402)
 * instead of returning 404. A genuine 404 only surfaced under a $0 section.
 *
 * These tests exercise the real router (handleRequest) in-process, so they
 * assert the ordering itself — existence before pricing — not just the
 * content handler's own 404 behaviour.
 *
 * Run with: bun run src/router.test.ts
 */

import { join } from "path";
import { handleRequest } from "./router.ts";
import type { LoadedConfig } from "./config/loader.ts";

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

const CONTENT_DIR = join(import.meta.dir, "..", "content");

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
          "/private/**": { amount: "100.00", currency: "USDC", chain: "base" },
        },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
    } as LoadedConfig["config"],
  };
}

const loaded = makeLoaded();

// handleRequest logs a JSON line per request; silence it so test output stays
// readable without muting a genuine failure (assertions throw independently).
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const realLog = console.log;
  console.log = () => {};
  try {
    return await handleRequest(
      new Request(`https://example.com${path}`, init),
      loaded
    );
  } finally {
    console.log = realLog;
  }
}

// ---------------------------------------------------------------------------
// Existence-before-pricing ordering
// ---------------------------------------------------------------------------

console.log("\nExistence before pricing\n");

await test("unknown path under a non-zero-priced section returns 404, not 402", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "unknown paid-section path must be 404");
  assert(
    !res.headers.get("content-type")?.includes("application/json"),
    "404 is not a 402 offer body"
  );
});

await test("unknown path falling to the non-zero default price returns 404, not 402", async () => {
  const res = await request("/totally/unknown/path", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "unknown default-priced path must be 404");
});

await test("unknown path under a $0 section still returns 404 (preserved)", async () => {
  const res = await request("/docs/nope", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "$0-section unknown path must remain 404");
});

await test("404 honours markdown negotiation with a markdown body", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 404, "status");
  assert(res.headers.get("content-type")?.includes("text/markdown") ?? false, "markdown 404");
  const body = await res.text();
  assert(body.startsWith("# 404"), "markdown 404 heading");
});

await test("unknown path with a browser Accept header returns HTML 404", async () => {
  const res = await request("/premium/does-not-exist", { headers: { Accept: "text/html" } });
  assertEquals(res.status, 404, "status");
  assert(res.headers.get("content-type")?.includes("text/html") ?? false, "html 404");
});

// ---------------------------------------------------------------------------
// Existing resources are unaffected by the gate
// ---------------------------------------------------------------------------

console.log("\nExisting resources\n");

await test("existing paid content without payment still returns 402", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 402, "real paid resource must still offer payment");
});

await test("existing free content returns 200", async () => {
  const res = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 200, "free content served");
});

await test("non-GET on an unknown content path is still 405, not 404", async () => {
  const res = await request("/premium/does-not-exist", { method: "POST" });
  assertEquals(res.status, 405, "POST unknown content path is 405");
});

// ---------------------------------------------------------------------------
// Caching safety on the payment path (0.2.5)
//
// A 402 is a per-request payment offer and must never be stored by a shared
// cache; a paid 200 must be impossible for a shared cache to store or serve;
// and an unpaid conditional request to a priced route must always get 402,
// never 304. These run the real router so the ordering is asserted end to end.
// ---------------------------------------------------------------------------

console.log("\n402 responses are no-store on every priced route and rail\n");

await test("x402 priced route: 402 no-store (markdown)", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("x402 priced route: 402 no-store (HTML)", async () => {
  const res = await request("/premium/deep-dive", { headers: { Accept: "text/html" } });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("L402/lightning priced route: 402 no-store (markdown)", async () => {
  const res = await request("/micropayment/intro", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("L402/lightning priced route: 402 no-store (HTML)", async () => {
  const res = await request("/micropayment/intro", { headers: { Accept: "text/html" } });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

console.log("\nPayment failures are no-store\n");

await test("malformed X-PAYMENT on an x402 route is a no-store 402", async () => {
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "X-PAYMENT": "not-base64-not-json" },
  });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("malformed L402 credential is a no-store 402", async () => {
  const res = await request("/micropayment/intro", {
    headers: { Accept: "text/markdown", Authorization: "L402 nonsense" },
  });
  assertEquals(res.status, 402, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("an X-PAYMENT attempt against a lightning offer is rejected, not approved", async () => {
  const res = await request("/micropayment/intro", {
    headers: { Accept: "text/markdown", "X-PAYMENT": "garbage" },
  });
  assertEquals(res.status, 402, "lightning offer must demand L402, never serve on X-PAYMENT");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("/mdf/pay with no X-PAYMENT returns a no-store 400", async () => {
  const res = await request("/mdf/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource: "/premium/deep-dive" }),
  });
  assertEquals(res.status, 400, "status");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

console.log("\nUnpaid conditional requests never 304 on a priced route\n");

await test("unpaid If-None-Match on a priced route returns 402, not 304", async () => {
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "If-None-Match": "*" },
  });
  assertEquals(res.status, 402, "status");
  assert(res.status !== 304, "must never be 304 without payment");
  assertEquals(res.headers.get("cache-control"), "no-store", "cache-control");
});

await test("unpaid far-future If-Modified-Since on a priced route returns 402, not 304", async () => {
  const res = await request("/premium/deep-dive", {
    headers: { Accept: "text/markdown", "If-Modified-Since": "Tue, 01 Jan 2999 00:00:00 GMT" },
  });
  assertEquals(res.status, 402, "status");
  assert(res.status !== 304, "must never be 304 without payment");
});

console.log("\nFree-route behaviour and source_bytes unchanged\n");

await test("free 200 keeps no-cache and its validators", async () => {
  const res = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  assertEquals(res.status, 200, "status");
  assertEquals(res.headers.get("cache-control"), "no-cache", "free cache-control");
  assert(!!res.headers.get("etag"), "free ETag present");
  assert(!!res.headers.get("last-modified"), "free Last-Modified present");
});

await test("free conditional request still returns 304", async () => {
  const first = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  const etag = first.headers.get("etag") ?? "";
  const second = await request("/docs/getting-started", {
    headers: { Accept: "text/markdown", "If-None-Match": etag },
  });
  assertEquals(second.status, 304, "free conditional 304");
});

await test("free-route source_bytes match the current content baseline", async () => {
  const root = await request("/", { headers: { Accept: "text/markdown" } });
  const docs = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  assertEquals(root.status, 200, "root is free");
  // / moved 1241 -> 1239 when the demo content page prices were corrected in
  // content/index.md (commit b2172c5): "$100.00" -> "$0.10" removes exactly 2
  // bytes of rendered HTML; "$1.00" -> "$0.01" is length-neutral.
  assertEquals(root.headers.get("x-mdf-source-bytes"), "1239", "root source_bytes");
  assertEquals(docs.headers.get("x-mdf-source-bytes"), "1003", "docs source_bytes");
});

console.log("\nVary and per-representation ETags end to end\n");

await test("HEAD carries Vary: Accept and a representation ETag", async () => {
  const res = await request("/docs/getting-started", {
    method: "HEAD",
    headers: { Accept: "text/markdown" },
  });
  assertEquals(res.status, 200, "HEAD status");
  assertEquals(res.headers.get("vary"), "Accept", "HEAD Vary");
  assert(!!res.headers.get("etag"), "HEAD ETag");
});

await test("cross-representation conditional request does not 304 via the router", async () => {
  const md = await request("/docs/getting-started", { headers: { Accept: "text/markdown" } });
  const mdEtag = md.headers.get("etag") ?? "";
  const cross = await request("/docs/getting-started", {
    headers: { Accept: "text/html", "If-None-Match": mdEtag },
  });
  assertEquals(cross.status, 200, "HTML request with markdown ETag must be 200");
  const same = await request("/docs/getting-started", {
    headers: { Accept: "text/markdown", "If-None-Match": mdEtag },
  });
  assertEquals(same.status, 304, "markdown request with markdown ETag is 304");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
