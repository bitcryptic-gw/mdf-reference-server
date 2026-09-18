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
          "/docs/**": { amount: "0.0000", currency: null, chain: null },
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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
