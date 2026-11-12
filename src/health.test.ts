/**
 * /health regression test
 *
 * Two contracts are pinned here.
 *
 * **The release version.** /health carries `version`, read once from
 * package.json, so a deploy can be confirmed by asking the running process
 * directly instead of inferring it from behaviour.
 *
 * **The per-rail shape (0.3.x).** Kuma matches substrings over this body, so the
 * encoding is a contract: one compact `{"rail":"<network>","status":"<state>"}`
 * per configured rail, in config order, plus `replay_store` when lnbtc is
 * configured and a `lightning` block only while that rail is degraded. HTTP 200
 * with `status:"ok"` is preserved while a rail is degraded — Caddy must never
 * pull a working instance out of rotation for a rail-local fault.
 *
 * Run with: bun run src/health.test.ts
 */

import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest } from "./router.ts";
import { SERVER_VERSION } from "./version.ts";
import { LnbtcGate } from "./payment/lnbtc/availability.ts";
import { MemoryReplayStore } from "./payment/lnbtc/replay-store.ts";
import type { LoadedConfig, LnbtcRuntime } from "./config/loader.ts";

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

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";

/** A minimal lnbtc runtime: only the fields /health reads. */
function lnbtcRuntime(available: boolean): LnbtcRuntime {
  const gate = new LnbtcGate({ enabled: true });
  if (available) {
    gate.applyCheck({ status: "pass", methods: ["make_invoice"], unverified: false });
  } else {
    gate.applyCheck({ status: "unreachable", reason: "relay down" });
  }
  return {
    enabled: true,
    network: LNBTC,
    payeePubkey: "02" + "ab".repeat(32),
    gate,
    invoiceExpirySeconds: 300,
  } as unknown as LnbtcRuntime;
}

function makeLoaded(
  options: { contentDir?: string; lnbtcAvailable?: boolean; withLnbtc?: boolean } = {}
): LoadedConfig {
  const contentDir = options.contentDir ?? CONTENT_DIR;
  const sections: Record<string, unknown> = {
    "/testnet/**": {
      rails: [
        { scheme: "exact", network: "eip155:84532", asset: USDC_SEPOLIA, amount: "1000" },
      ],
    },
  };
  if (options.withLnbtc) {
    sections["/showcase/**"] = {
      rails: [
        { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
        { scheme: "exact", network: LNBTC, asset: "BTC", amount: "20000" },
      ],
    };
  }

  return {
    contentDir,
    walletAddress: "0xa7D911138322aF8823642beA2b174dFaC2725fB7",
    mdfJson: "{}",
    config: {
      site: { url: "https://example.com", name: "Test" },
      content: { dir: contentDir, dialect: "commonmark", frontmatter: true, math: false },
      pricing: {
        default: {
          rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "100" }],
        },
        sections,
      },
      token_store: "memory",
      signals: { ai_train: false, ai_input: true, search: true, human_only: false },
      dashboard: { enabled: false, port: 9090 },
      payment: { max_timeout_seconds: 300 },
      server: { trusted_proxies: [] },
    } as unknown as LoadedConfig["config"],
    tokenStore: {
      put: async () => true,
      get: async () => null,
      delete: async () => {},
      putPending: async () => true,
      getPending: async () => null,
      health: async () => "ok",
      close: () => {},
    },
    tokenStoreBackend: "memory",
    facilitator: null,
    pool: null,
    replayStore: options.withLnbtc ? new MemoryReplayStore() : null,
    lnbtc: options.withLnbtc ? lnbtcRuntime(options.lnbtcAvailable ?? true) : null,
    valkey: null,
  } as LoadedConfig;
}

async function getHealth(loaded: LoadedConfig): Promise<{ res: Response; body: string }> {
  const realLog = console.log;
  console.log = () => {};
  try {
    const res = await handleRequest(new Request("https://example.com/health"), loaded);
    return { res, body: await res.text() };
  } finally {
    console.log = realLog;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n/health\n");

const dataDir = mkdtempSync(join(tmpdir(), "mdf-health-"));
process.env.MDF_DATA_DIR = dataDir;

await test("SERVER_VERSION matches package.json version", () => {
  assertEquals(SERVER_VERSION, PACKAGE_VERSION, "cached version must match package.json");
});

await test("healthy /health returns 200 JSON with status ok and package version", async () => {
  const { res, body: text } = await getHealth(makeLoaded());
  assertEquals(res.status, 200, "healthy status");
  assertEquals(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
    "health content-type"
  );

  const body = JSON.parse(text) as { status: string; version: string };
  assertEquals(body.status, "ok", "status field");
  assertEquals(body.version, PACKAGE_VERSION, "version field must match package.json");
});

await test("unhealthy /health returns 503 but still carries version", async () => {
  const { res, body: text } = await getHealth(
    makeLoaded({ contentDir: join(CONTENT_DIR, "does-not-exist-dir") })
  );
  assertEquals(res.status, 503, "unhealthy status");

  const body = JSON.parse(text) as { status: string; version: string };
  assertEquals(body.status, "unavailable", "status field");
  assertEquals(body.version, PACKAGE_VERSION, "version present even when unhealthy");
});

await test("rails[] lists every configured rail, deduplicated, in config order", async () => {
  const { body: text } = await getHealth(makeLoaded({ withLnbtc: true }));
  const body = JSON.parse(text) as { rails: Array<{ rail: string; status: string }> };
  assertEquals(body.rails.length, 3, "default 8453, section 84532 and the lnbtc rail");
  assertEquals(body.rails[0].rail, "eip155:8453", "config order: default first");
  assertEquals(body.rails[1].rail, "eip155:84532", "section rail second");
  assertEquals(body.rails[2].rail, LNBTC, "lnbtc last");
  assertEquals(body.rails[0].status, "ok", "an eip155 rail is ok when configured");
});

await test("Kuma's exact substring is present for a healthy rail", async () => {
  const { body: text } = await getHealth(makeLoaded());
  assert(
    text.includes('"rail":"eip155:8453","status":"ok"'),
    `expected the documented compact encoding, got: ${text}`
  );
});

await test("a degraded lnbtc rail is reported in rails[] and in the lightning block", async () => {
  const { res, body: text } = await getHealth(
    makeLoaded({ withLnbtc: true, lnbtcAvailable: false })
  );
  assertEquals(res.status, 200, "a rail-local fault must not fail the probe");
  assert(
    text.includes(`"rail":"${LNBTC}","status":"degraded"`),
    `lnbtc rail should be degraded, got: ${text}`
  );

  const body = JSON.parse(text) as { status: string; lightning?: { status: string } };
  assertEquals(body.status, "ok", "top-level status stays ok");
  assertEquals(body.lightning?.status, "degraded", "lightning block present while degraded");
});

await test("replay_store is reported when lnbtc is configured, and omitted otherwise", async () => {
  const withStore = JSON.parse((await getHealth(makeLoaded({ withLnbtc: true }))).body) as {
    replay_store?: { status: string };
  };
  assertEquals(withStore.replay_store?.status, "ok", "memory store reports ok");

  const without = JSON.parse((await getHealth(makeLoaded())).body) as {
    replay_store?: { status: string };
  };
  assertEquals(without.replay_store, undefined, "no lnbtc, no replay_store key");
});

await test("token_store is always probed, and reports the failure kind", async () => {
  const healthy = JSON.parse((await getHealth(makeLoaded())).body) as {
    token_store?: { status: string; category?: string };
  };
  assertEquals(healthy.token_store?.status, "ok", "healthy store");

  for (const kind of ["unreachable", "auth"] as const) {
    const config = makeLoaded();
    (config as { tokenStore: unknown }).tokenStore = {
      put: async () => false,
      get: async () => null,
      delete: async () => {},
      putPending: async () => false,
      getPending: async () => null,
      health: async () => kind,
      close: () => {},
    };
    const body = JSON.parse((await getHealth(config)).body) as {
      token_store?: { status: string; category?: string };
    };
    assertEquals(body.token_store?.status, "unavailable", `${kind}: unavailable`);
    assertEquals(body.token_store?.category, kind, `${kind}: the kind is reported`);
  }
});

await test("an unavailable replay store degrades the lnbtc rail and says which kind", async () => {
  const config = makeLoaded({ withLnbtc: true, lnbtcAvailable: true });
  (config as { replayStore: unknown }).replayStore = {
    claim: async () => "unavailable",
    health: async () => "auth",
    close: () => {},
  };
  const body = JSON.parse((await getHealth(config)).body) as {
    replay_store?: { status: string; category?: string };
    rails: Array<{ rail: string; status: string }>;
  };
  assertEquals(body.replay_store?.status, "unavailable", "store unavailable");
  assertEquals(body.replay_store?.category, "auth", "an auth failure is named");
  assertEquals(
    body.rails.find((r) => r.rail.startsWith("lnbtc:"))?.status,
    "degraded",
    "the rail that depends on it is degraded"
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
