/**
 * /health release-version regression test
 *
 * The server previously exposed no release version anywhere reachable, so a
 * deploy could only be confirmed by indirect behavioural probes. /health now
 * carries a `version` field, read once from package.json. This test pins the
 * two together so the field cannot silently go stale relative to the release
 * it is supposed to report (the same class of protection as the value-level
 * source_bytes regression test).
 *
 * Run with: bun run src/health.test.ts
 */

import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest } from "./router.ts";
import { SERVER_VERSION } from "./version.ts";
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
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function makeLoaded(contentDir: string): LoadedConfig {
  return {
    contentDir,
    walletAddress: "0xDEAD",
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: contentDir, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: { amount: "0.0000", currency: null, chain: null },
        sections: {},
      },
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
    } as LoadedConfig["config"],
  };
}

async function getHealth(loaded: LoadedConfig): Promise<Response> {
  const realLog = console.log;
  console.log = () => {};
  try {
    return await handleRequest(new Request("https://example.com/health"), loaded);
  } finally {
    console.log = realLog;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n/health release version\n");

const dataDir = mkdtempSync(join(tmpdir(), "mdf-health-"));
process.env.MDF_DATA_DIR = dataDir;

await test("SERVER_VERSION matches package.json version", () => {
  assertEquals(SERVER_VERSION, PACKAGE_VERSION, "cached version must match package.json");
});

await test("healthy /health returns 200 JSON with status ok and package version", async () => {
  const res = await getHealth(makeLoaded(CONTENT_DIR));
  assertEquals(res.status, 200, "healthy status");
  assertEquals(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
    "health content-type"
  );

  const body = JSON.parse(await res.text()) as { status: string; version: string };
  assertEquals(body.status, "ok", "status field");
  assertEquals(body.version, PACKAGE_VERSION, "version field must match package.json");
});

await test("unhealthy /health returns 503 but still carries version", async () => {
  const res = await getHealth(makeLoaded(join(CONTENT_DIR, "does-not-exist-dir")));
  assertEquals(res.status, 503, "unhealthy status");

  const body = JSON.parse(await res.text()) as { status: string; version: string };
  assertEquals(body.status, "unavailable", "status field");
  assertEquals(body.version, PACKAGE_VERSION, "version present even when unhealthy");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
