/**
 * Content negotiation handler tests
 * Run with: bun run src/content/handler.test.ts
 */

import { parseAccept, prefersMarkdown } from "./accept.ts";
import { serveContent } from "./handler.ts";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CONTENT_DIR = "/home/claude/mdf-server/content";

function makeLoaded(overrides: Partial<LoadedConfig["config"]["pricing"]> = {}): LoadedConfig {
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
        ...overrides,
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: true, port: 9090 },
    } as LoadedConfig["config"],
  };
}

const loaded = makeLoaded();

// ---------------------------------------------------------------------------
// Accept header parsing
// ---------------------------------------------------------------------------

console.log("\nAccept header parsing\n");

test("parses single type", () => {
  const result = parseAccept("text/html");
  assertEquals(result[0].type, "text/html", "type");
  assertEquals(result[0].q, 1.0, "q");
});

test("parses multiple types with quality values", () => {
  const result = parseAccept("text/markdown, text/html;q=0.9, */*;q=0.8");
  assertEquals(result[0].type, "text/markdown", "highest q first");
  assertEquals(result[1].q, 0.9, "html q");
  assertEquals(result[2].q, 0.8, "wildcard q");
});

test("sorts by quality descending", () => {
  const result = parseAccept("text/html;q=0.5, text/markdown;q=0.9");
  assertEquals(result[0].type, "text/markdown", "markdown ranked higher");
});

test("handles null/empty header", () => {
  assertEquals(parseAccept(null).length, 0, "null");
  assertEquals(parseAccept("").length, 0, "empty");
});

// ---------------------------------------------------------------------------
// prefersMarkdown
// ---------------------------------------------------------------------------

console.log("\nprefersMarkdown\n");

test("standard agent header prefers markdown", () => {
  assert(prefersMarkdown("text/markdown, text/html;q=0.9"), "should prefer markdown");
});

test("browser-like header does not prefer markdown", () => {
  assert(!prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), "browser header");
});

test("markdown-only header prefers markdown", () => {
  assert(prefersMarkdown("text/markdown"), "markdown only");
});

test("explicit q=0 for markdown is not preferred", () => {
  assert(!prefersMarkdown("text/markdown;q=0, text/html"), "q=0 markdown excluded");
});

test("null header does not prefer markdown", () => {
  assert(!prefersMarkdown(null), "null header");
});

test("equal q prefers markdown when listed first", () => {
  assert(prefersMarkdown("text/markdown;q=0.9, text/html;q=0.9"), "equal q, markdown first");
});

// ---------------------------------------------------------------------------
// Content serving
// ---------------------------------------------------------------------------

console.log("\nContent serving\n");

test("serves markdown for agent Accept header", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assertEquals(result.status, 200, "status");
  assert(result.headers["Content-Type"].includes("text/markdown"), "content-type");
  assert(result.body.includes("# Getting Started"), "markdown body");
});

test("serves HTML for browser Accept header", () => {
  const result = serveContent(
    "/docs/getting-started",
    "text/html,application/xhtml+xml,*/*;q=0.8",
    null,
    loaded
  );
  assertEquals(result.status, 200, "status");
  assert(result.headers["Content-Type"].includes("text/html"), "content-type");
  assert(result.body.includes("<!DOCTYPE html>"), "html wrapper");
  assert(result.body.includes("<h1>"), "rendered heading");
});

test("serves HTML when no Accept header provided", () => {
  const result = serveContent("/docs/getting-started", null, null, loaded);
  assert(result.headers["Content-Type"].includes("text/html"), "defaults to html");
});

test("resolves root path to index.md", () => {
  const result = serveContent("/", "text/markdown", null, loaded);
  assertEquals(result.status, 200, "status");
  assert(result.body.includes("Welcome to MDF Demo"), "index content");
});

test("resolves path without extension", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assertEquals(result.status, 200, "status");
});

test("returns 404 for missing content", () => {
  const result = serveContent("/does/not/exist", "text/markdown", null, loaded);
  assertEquals(result.status, 404, "status");
});

test("returns markdown 404 body for agent", () => {
  const result = serveContent("/nope", "text/markdown", null, loaded);
  assertEquals(result.status, 404, "status");
  assert(result.headers["Content-Type"].includes("text/markdown"), "markdown 404");
  assert(result.body.startsWith("# 404"), "404 heading");
});

test("returns HTML 404 body for browser", () => {
  const result = serveContent("/nope", "text/html", null, loaded);
  assertEquals(result.status, 404, "status");
  assert(result.headers["Content-Type"].includes("text/html"), "html 404");
});

test("emits X-MDF-Version header", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assertEquals(result.headers["X-MDF-Version"], "1", "X-MDF-Version");
});

test("emits X-MDF-Tokens header with positive integer", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  const tokens = parseInt(result.headers["X-MDF-Tokens"], 10);
  assert(tokens > 0, `tokens should be positive, got ${tokens}`);
});

test("emits X-MDF-Price and X-MDF-Currency for paid content", () => {
  const result = serveContent("/premium/deep-dive", "text/markdown", null, loaded);
  assertEquals(result.headers["X-MDF-Price"], "1.0000", "price");
  assertEquals(result.headers["X-MDF-Currency"], "USDC", "currency");
});

test("omits X-MDF-Price for free content", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assert(!result.headers["X-MDF-Price"], "no price header for free content");
});

test("private section uses $100 price", () => {
  const result = serveContent("/private/internals", "text/markdown", null, loaded);
  assertEquals(result.headers["X-MDF-Price"], "100.00", "private price");
});

test("emits ETag header", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assert(result.headers["ETag"]?.startsWith('"'), "ETag present and quoted");
});

test("returns 304 on matching If-None-Match", () => {
  const first = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  const etag = first.headers["ETag"];
  const second = serveContent("/docs/getting-started", "text/markdown", etag, loaded);
  assertEquals(second.status, 304, "304 Not Modified");
  assertEquals(second.body, "", "empty body on 304");
});

test("returns 200 on mismatched If-None-Match", () => {
  const result = serveContent("/docs/getting-started", "text/markdown", '"stale-etag"', loaded);
  assertEquals(result.status, 200, "200 on stale ETag");
});

test("path traversal attempt returns 404", () => {
  const result = serveContent("/../../../etc/passwd", "text/markdown", null, loaded);
  assertEquals(result.status, 404, "traversal blocked");
});

test("ETag is stable across identical fetches", () => {
  const r1 = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  const r2 = serveContent("/docs/getting-started", "text/markdown", null, loaded);
  assertEquals(r1.headers["ETag"], r2.headers["ETag"], "ETag stable");
});

test("frontmatter stripped from HTML render", () => {
  const result = serveContent("/docs/getting-started", "text/html", null, loaded);
  assert(!result.body.includes("title: Getting Started"), "frontmatter not in HTML");
  assert(result.body.includes("Getting Started with MDF"), "title in HTML");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
