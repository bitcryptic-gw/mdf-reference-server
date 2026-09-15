/**
 * Config loader tests
 *
 * loadConfig() resolves secrets (file > env > inline), validates the parsed
 * YAML against MdfConfigSchema, enforces cross-field startup constraints that
 * the schema alone can't express (wallet required once pricing is non-zero,
 * facilitator required once any chain is priced in x402, lightning secrets
 * required once a [lightning] block is configured), and builds the /mdf.json
 * payload. None of that had a regression test — this fills that gap
 * (Vikunja #15).
 *
 * Fixtures are real files under a temp directory rather than mocked fs calls,
 * since loadConfig reads mdf.yaml, the content directory, and /run/secrets/*
 * from disk directly.
 *
 * Run with: bun run src/config/loader.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { loadConfig } from "./loader.ts";

// ---------------------------------------------------------------------------
// Test harness (same shape as 402-schema.test.ts / handler.test.ts)
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

function assertThrows(fn: () => void, msgContains: string, what: string) {
  try {
    fn();
    throw new Error(`expected to throw (${what}), but it did not`);
  } catch (err) {
    const message = (err as Error).message;
    assert(
      message.includes(msgContains),
      `${what}: expected error to include "${msgContains}", got: ${message}`
    );
  }
}

function printSummary(): void {
  console.log("-------------------------------------------");
  console.log(`passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp working directory with a content/ folder and an mdf.yaml
 * built from the supplied config object. Returns the yaml path and a
 * secrets(name, value) helper that writes a Docker-secret-style file.
 *
 * Callers are responsible for calling rmSync(dir, { recursive: true }) via
 * withTempDir's cleanup — see below.
 */
function makeFixture(configObj: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "mdf-loader-test-"));
  const contentDir = join(dir, "content");
  mkdirSync(contentDir);
  writeFileSync(join(contentDir, "index.md"), "# Hello\n");

  const merged = {
    site: { url: "https://example.com", name: "Test Site" },
    content: { dir: contentDir },
    pricing: { default: { amount: "0.0000" } },
    ...configObj,
  };

  const yamlPath = join(dir, "mdf.yaml");
  writeFileSync(yamlPath, yaml.dump(merged));

  const secretsDir = join(dir, "secrets");
  mkdirSync(secretsDir);

  return {
    dir,
    yamlPath,
    contentDir,
    writeSecret(name: string, value: string) {
      writeFileSync(join(secretsDir, name), value);
    },
    secretPath(name: string) {
      return join(secretsDir, name);
    },
  };
}

function withTempDir<T>(configObj: Record<string, unknown>, fn: (f: ReturnType<typeof makeFixture>) => T): T {
  const fixture = makeFixture(configObj);
  try {
    return fn(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// loadConfig only checks /run/secrets/<name> on the real filesystem root, not
// a configurable secrets dir, so secret-file-precedence cases are exercised
// via MDF_* env vars instead (which loadConfig does honour) plus the
// inline-value fallback. This mirrors how the real container is actually
// configured (Docker secrets mount at /run/secrets/*) without requiring
// root or a bind mount inside this test.

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Basic load + mdf.json shape
// ---------------------------------------------------------------------------

console.log("\nBasic load\n");

test("loads a minimal free-content config with no payment block", () => {
  withTempDir({}, ({ yamlPath }) => {
    const loaded = loadConfig(yamlPath);
    assert(loaded.walletAddress === null, "no wallet configured for a free-only site");
    assert(loaded.facilitatorConfig === null, "no facilitator configured for a free-only site");
    const mdfJson = JSON.parse(loaded.mdfJson);
    assert(mdfJson.payment === undefined, "mdf.json should omit payment when nothing is priced");
  });
});

test("throws a descriptive error when the config file does not exist", () => {
  assertThrows(
    () => loadConfig("/nonexistent/path/mdf.yaml"),
    "config file not found",
    "missing config file"
  );
});

test("throws when the content directory does not exist", () => {
  withTempDir({ content: { dir: "/nonexistent/content/dir" } }, ({ yamlPath }) => {
    assertThrows(() => loadConfig(yamlPath), "content directory not found", "missing content dir");
  });
});

test("throws a descriptive error on invalid YAML shape", () => {
  withTempDir({}, ({ yamlPath }) => {
    writeFileSync(yamlPath, "site:\n  url: not-a-url\n");
    assertThrows(() => loadConfig(yamlPath), "invalid configuration", "schema validation failure");
  });
});

// ---------------------------------------------------------------------------
// Secret resolution precedence (env var > inline config value)
// ---------------------------------------------------------------------------

console.log("\nSecret resolution\n");

test("wallet resolves from MDF_WALLET env var when set", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: "0xFromEnv" }, () => {
        const loaded = loadConfig(yamlPath);
        assert(loaded.walletAddress === "0xFromEnv", "wallet should resolve from MDF_WALLET");
      });
    }
  );
});

test("wallet falls back to the inline config value when no env var is set", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xFromInline",
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: undefined }, () => {
        const loaded = loadConfig(yamlPath);
        assert(loaded.walletAddress === "0xFromInline", "wallet should fall back to the inline value");
      });
    }
  );
});

test("MDF_WALLET env var takes precedence over the inline config value", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xFromInline",
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: "0xFromEnv" }, () => {
        const loaded = loadConfig(yamlPath);
        assert(
          loaded.walletAddress === "0xFromEnv",
          "env var should win over the inline value per the documented precedence order"
        );
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Startup constraint validation
// ---------------------------------------------------------------------------

console.log("\nStartup constraint validation\n");

test("throws when pricing is non-zero but no [payment] block is configured", () => {
  withTempDir({ pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } } }, ({ yamlPath }) => {
    assertThrows(
      () => loadConfig(yamlPath),
      "non-zero amounts but no [payment] block",
      "priced with no payment block"
    );
  });
});

test("throws when pricing is non-zero and [payment] exists but no wallet resolves", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: { endpoint: "/mdf/pay", accepted_chains: ["base"], accepted_currencies: ["USDC"] },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: undefined }, () => {
        assertThrows(() => loadConfig(yamlPath), "requires a wallet address", "priced with no wallet");
      });
    }
  );
});

test("throws when an x402 chain is priced but no [facilitator] block is configured", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xDEAD",
      },
    },
    ({ yamlPath }) => {
      assertThrows(
        () => loadConfig(yamlPath),
        "no [facilitator] block is configured",
        "x402 priced with no facilitator block"
      );
    }
  );
});

test("throws when an x402 chain is priced but the facilitator has no asset entry for that chain", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xDEAD",
      },
      facilitator: { url: "https://x402.bitcryptic.com", chains: {} },
    },
    ({ yamlPath }) => {
      assertThrows(
        () => loadConfig(yamlPath),
        "requires facilitator.chains.base.asset",
        "x402 priced chain missing from facilitator.chains"
      );
    }
  );
});

test("loads cleanly when the facilitator has a matching chain asset entry", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xDEAD",
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.facilitatorConfig !== null, "facilitatorConfig should resolve");
      assert(
        loaded.facilitatorConfig!.chains.base?.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "resolved facilitator config should carry the configured chain asset"
      );
    }
  );
});

test("lightning-only pricing does not require a [facilitator] block", () => {
  // hasX402Price excludes chain === "lightning" — a lightning-only priced
  // site should never demand a facilitator config. LightningSchema requires
  // api_token/token_secret inline (min 1 / min 32 chars) just to parse, even
  // though loader.ts always overwrites both from file/env afterward — see
  // the note below on the two negative-path tests for why that inline value
  // is schema-required but loader-ignored.
  withTempDir(
    {
      pricing: { default: { amount: "0.00000001", currency: "BTC", chain: "lightning" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["lightning"],
        accepted_currencies: ["BTC"],
        wallet: "n/a",
      },
      lightning: {
        api_url: "https://alby.example.com",
        api_token: "inline-placeholder",
        token_secret: "inline-placeholder-padded-to-32ch",
      },
    },
    ({ yamlPath }) => {
      withEnv(
        { MDF_ALBY_TOKEN: "test-token", MDF_LIGHTNING_SECRET: "x".repeat(32) },
        () => {
          const loaded = loadConfig(yamlPath);
          assert(
            loaded.facilitatorConfig === null,
            "lightning-only pricing should not require a facilitator block"
          );
          assert(
            loaded.config.lightning?.api_token === "test-token",
            "MDF_ALBY_TOKEN should override the inline placeholder"
          );
        }
      );
    }
  );
});

// NOTE on the two tests below: the schema requires api_token (min 1 char)
// and token_secret (min 32 chars) inline just to satisfy LightningSchema
// (schema.ts:100-105), but loader.ts's secret-resolution call passes
// `undefined` as resolveSecret's inline-value argument for both fields
// (loader.ts:317, :324) rather than the config's own inline value — so
// whatever placeholder satisfies the schema is never actually consulted
// here, and the "secret not found" throw *is* reachable: a schema-valid
// placeholder plus no file/env still throws. The placeholder is dead
// weight from the loader's perspective, but required by the schema; worth
// its own follow-up (see Vikunja) on whether the schema should relax those
// fields to optional so the requirement lives in one place, but that's a
// design decision, not fixed here.
test("throws when [lightning] is configured but alby_api_token cannot be resolved", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
        api_token: "schema-placeholder-not-actually-consulted",
        token_secret: "x".repeat(32),
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_ALBY_TOKEN: undefined, MDF_LIGHTNING_SECRET: "x".repeat(32) }, () => {
        assertThrows(
          () => loadConfig(yamlPath),
          "alby_api_token secret not found",
          "lightning configured with no alby token resolvable via file or env"
        );
      });
    }
  );
});

test("throws when [lightning] is configured but lightning_token_secret cannot be resolved", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
        api_token: "test-token",
        token_secret: "schema-placeholder-padded-to-32-chars!!",
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_ALBY_TOKEN: "test-token", MDF_LIGHTNING_SECRET: undefined }, () => {
        assertThrows(
          () => loadConfig(yamlPath),
          "lightning_token_secret not found",
          "lightning configured with no token secret resolvable via file or env"
        );
      });
    }
  );
});

test("throws when [auth] is configured but no priced section meets its threshold", () => {
  withTempDir(
    {
      pricing: {
        default: { amount: "1.0000", currency: "USDC", chain: "base" },
      },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "0xDEAD",
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
      auth: { endpoint: "/mdf/auth", price_threshold: "50.0000" },
    },
    ({ yamlPath }) => {
      assertThrows(
        () => loadConfig(yamlPath),
        "no section is priced at or above that amount",
        "auth threshold with nothing priced high enough"
      );
    }
  );
});

// ---------------------------------------------------------------------------
// mdf.json generation
// ---------------------------------------------------------------------------

console.log("\nmdf.json generation\n");

test("emits the wallet in mdf.json's payment object once resolved", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: "0xDEAD" }, () => {
        const loaded = loadConfig(yamlPath);
        const mdfJson = JSON.parse(loaded.mdfJson);
        assert(mdfJson.payment.wallet === "0xDEAD", "mdf.json payment.wallet should be the resolved wallet");
        assert(
          mdfJson.payment.endpoint === "https://example.com/mdf/pay",
          "root-relative payment endpoint should resolve against site.url"
        );
      });
    }
  );
});

test("resolves an already-absolute https:// endpoint unchanged", () => {
  withTempDir(
    {
      pricing: { default: { amount: "1.0000", currency: "USDC", chain: "base" } },
      payment: {
        endpoint: "https://pay.elsewhere.com/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: "0xDEAD" }, () => {
        const loaded = loadConfig(yamlPath);
        const mdfJson = JSON.parse(loaded.mdfJson);
        assert(
          mdfJson.payment.endpoint === "https://pay.elsewhere.com/mdf/pay",
          "an absolute https:// endpoint should be passed through unchanged"
        );
      });
    }
  );
});

printSummary();
