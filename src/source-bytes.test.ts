/**
 * source_bytes semantic conformance test
 *
 * The earlier 402-schema drift was caught by shape validation; this covers the
 * orthogonal failure where a field is present, correctly named and correctly
 * typed everywhere, but holds a value that means something different from what
 * the spec prose defines. Here, `source_bytes` must be the byte length of the
 * rendered-HTML representation — not the markdown body or the markdown file
 * size — on both the 200 header and the 402 body.
 *
 * The assertions cross-check the value against the server's own HTML response
 * for the same URL, so they test the definition rather than re-running the
 * implementation's own arithmetic.
 *
 * Run with: bun run src/source-bytes.test.ts
 */

import { join } from "path";
import { serveContent } from "./content/handler.ts";
import { build402Response } from "./payment/payment.ts";
import type { VerificationResult } from "./payment/payment.ts";
import type { LoadedConfig } from "./config/loader.ts";

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

function noProof(): VerificationResult {
  return {
    status: "no_proof",
    proof: null,
    l402Credential: null,
    reason: "payment required: 1.0000 USDC",
    requiresToken: false,
    rail: "none",
  };
}

function htmlBytes(loaded: LoadedConfig, urlPath: string): number {
  const res = serveContent(urlPath, "text/html", null, loaded);
  return Buffer.byteLength(res.body, "utf8");
}

function markdownBytes(loaded: LoadedConfig, urlPath: string): number {
  const res = serveContent(urlPath, "text/markdown", null, loaded);
  return Buffer.byteLength(res.body, "utf8");
}

async function main(): Promise<void> {
  console.log("mdf-server source_bytes semantic conformance test");
  console.log("--------------------------------------------------");

  const loaded = makeLoaded();

  await test("200: source_bytes is the rendered-HTML byte length, not the markdown size", () => {
    const urlPath = "/docs/getting-started";
    const html = htmlBytes(loaded, urlPath);
    const markdown = markdownBytes(loaded, urlPath);

    assert(
      html !== markdown,
      `fixture must have differing HTML and markdown sizes or the test is vacuous (html=${html}, markdown=${markdown})`
    );

    const mdRes = serveContent(urlPath, "text/markdown", null, loaded);
    const htmlRes = serveContent(urlPath, "text/html", null, loaded);

    assertEquals(
      mdRes.headers["X-MDF-Source-Bytes"],
      String(html),
      "markdown 200 header source_bytes must equal the HTML representation's byte length"
    );
    assertEquals(
      htmlRes.headers["X-MDF-Source-Bytes"],
      String(Buffer.byteLength(htmlRes.body, "utf8")),
      "html 200 header source_bytes must equal its own rendered body byte length"
    );
    assert(
      mdRes.headers["X-MDF-Source-Bytes"] !== String(markdown),
      "markdown 200 source_bytes must not be the served markdown body size"
    );
  });

  await test("402: source_bytes is the rendered-HTML byte length, not the markdown file size", async () => {
    const urlPath = "/premium/deep-dive";
    const html = htmlBytes(loaded, urlPath);
    const markdown = markdownBytes(loaded, urlPath);

    const res = await build402Response(urlPath, noProof(), loaded);
    assertEquals(res.status, 402, "status should be 402");

    const body = JSON.parse(res.body);
    assert(
      typeof body.source_bytes === "number",
      "402 body should carry a numeric source_bytes for a resolved content file"
    );

    assertEquals(
      body.source_bytes,
      html,
      "402 source_bytes must equal the rendered-HTML representation's byte length"
    );
    assert(
      body.source_bytes !== markdown,
      "402 source_bytes must not be the served markdown size"
    );

    const htmlRes = serveContent(urlPath, "text/html", null, loaded);
    assertEquals(
      body.source_bytes,
      Number(htmlRes.headers["X-MDF-Source-Bytes"]),
      "402 body and 200 header must report the same HTML baseline for the same resource"
    );
  });

  console.log("--------------------------------------------------");
  console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
