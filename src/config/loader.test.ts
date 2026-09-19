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
import { isValidEip55Address, toEip55Checksum } from "./wallet.ts";

// Valid EIP-55 checksummed wallets for priced fixtures. The strict validator
// added for Vikunja #9 rejects placeholder/unchecksummed values as soon as any
// pricing is non-zero, so these fixtures can no longer use "0xDEAD"/"n/a".
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
// The live demo wallet, checked in B0 to prove the validator accepts production.
const WALLET_LIVE = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";

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
      withEnv({ MDF_WALLET: WALLET_B }, () => {
        const loaded = loadConfig(yamlPath);
        assert(loaded.walletAddress === WALLET_B, "wallet should resolve from MDF_WALLET");
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
        wallet: WALLET_A,
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: undefined }, () => {
        const loaded = loadConfig(yamlPath);
        assert(loaded.walletAddress === WALLET_A, "wallet should fall back to the inline value");
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
        wallet: WALLET_A,
      },
      facilitator: {
        url: "https://x402.bitcryptic.com",
        chains: { base: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: WALLET_B }, () => {
        const loaded = loadConfig(yamlPath);
        assert(
          loaded.walletAddress === WALLET_B,
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
        wallet: WALLET_A,
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
        wallet: WALLET_A,
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
        wallet: WALLET_A,
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
  // site should never demand a facilitator config. Since Vikunja #27 the
  // LightningSchema fields are optional, so this config carries no inline
  // api_token/token_secret at all and resolution comes from the environment.
  withTempDir(
    {
      pricing: { default: { amount: "0.00000001", currency: "BTC", chain: "lightning" } },
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["lightning"],
        accepted_currencies: ["BTC"],
        wallet: WALLET_A,
      },
      lightning: {
        api_url: "https://alby.example.com",
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
            "resolved api_token should come from the environment"
          );
        }
      );
    }
  );
});

// The test harness cannot write /run/secrets (root-owned), so secret-file
// resolution is exercised via the MDF_* env vars that share resolveSecret's
// precedence chain — the same stand-in used by the wallet-precedence tests.

test("lightning block with no inline fields and a resolvable secret loads", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
      },
    },
    ({ yamlPath }) => {
      withEnv(
        { MDF_ALBY_TOKEN: "resolved-token", MDF_LIGHTNING_SECRET: "y".repeat(32) },
        () => {
          const loaded = loadConfig(yamlPath);
          assert(
            loaded.config.lightning?.api_token === "resolved-token",
            "api_token should resolve with no inline field present"
          );
          assert(
            loaded.config.lightning?.token_secret === "y".repeat(32),
            "token_secret should resolve with no inline field present"
          );
        }
      );
    }
  );
});

test("throws when [lightning] has no inline fields and nothing resolvable", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_ALBY_TOKEN: undefined, MDF_LIGHTNING_SECRET: undefined }, () => {
        assertThrows(
          () => loadConfig(yamlPath),
          "alby_api_token secret not found",
          "lightning configured with nothing resolvable via file or env"
        );
      });
    }
  );
});

test("throws when the lightning token secret alone cannot be resolved", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
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

test("legacy inline placeholders still parse and remain inert", () => {
  // Both live hosts carry inline placeholders in mdf.yaml. They must keep
  // parsing, but must never be read: the resolved value is the env secret.
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
        api_token: "inline-placeholder",
        token_secret: "inline-placeholder-padded-to-32ch",
      },
    },
    ({ yamlPath }) => {
      withEnv(
        { MDF_ALBY_TOKEN: "env-token", MDF_LIGHTNING_SECRET: "z".repeat(32) },
        () => {
          const loaded = loadConfig(yamlPath);
          assert(
            loaded.config.lightning?.api_token === "env-token",
            "inline placeholder must not win over the resolved secret"
          );
          assert(
            loaded.config.lightning?.token_secret === "z".repeat(32),
            "inline token_secret must not win over the resolved secret"
          );
        }
      );
    }
  );
});

test("legacy inline placeholders alone do not satisfy secret resolution", () => {
  withTempDir(
    {
      lightning: {
        api_url: "https://alby.example.com",
        api_token: "inline-placeholder",
        token_secret: "inline-placeholder-padded-to-32ch",
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_ALBY_TOKEN: undefined, MDF_LIGHTNING_SECRET: undefined }, () => {
        assertThrows(
          () => loadConfig(yamlPath),
          "alby_api_token secret not found",
          "inline placeholder must be inert and not satisfy resolution"
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
        wallet: WALLET_A,
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
      withEnv({ MDF_WALLET: WALLET_A }, () => {
        const loaded = loadConfig(yamlPath);
        const mdfJson = JSON.parse(loaded.mdfJson);
        assert(mdfJson.payment.wallet === WALLET_A, "mdf.json payment.wallet should be the resolved wallet");
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
      withEnv({ MDF_WALLET: WALLET_A }, () => {
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

// ---------------------------------------------------------------------------
// Wallet validation (Vikunja #9)
// ---------------------------------------------------------------------------

console.log("\nWallet validation\n");

test("accepts a valid EIP-55 checksummed address", () => {
  assert(isValidEip55Address(WALLET_A), "all-digit checksummed address should be valid");
  assert(isValidEip55Address(WALLET_B), "letter-containing checksummed address should be valid");
});

test("accepts the live production wallet captured in B0", () => {
  assert(isValidEip55Address(WALLET_LIVE), "live demo wallet must pass the validator");
});

test("toEip55Checksum normalises an unchecksummed address to canonical form", () => {
  assert(
    toEip55Checksum(WALLET_LIVE.toLowerCase()) === WALLET_LIVE,
    "lowercase input should normalise back to the canonical checksum form"
  );
});

test("rejects a single flipped-case character", () => {
  const flipped = WALLET_B.replace(/[A-F]/, (c) => (c === "A" ? "a" : c.toLowerCase()));
  assert(flipped !== WALLET_B, "fixture flip must actually change the string");
  assert(!isValidEip55Address(flipped), "flipped-case address must be rejected");
});

test("rejects all-lowercase and all-uppercase forms", () => {
  assert(!isValidEip55Address(WALLET_B.toLowerCase()), "all-lowercase must be rejected");
  assert(!isValidEip55Address(WALLET_B.toUpperCase()), "all-uppercase must be rejected");
});

test("rejects wrong length, missing 0x, and non-hex characters", () => {
  assert(!isValidEip55Address(WALLET_B.slice(0, -1)), "39 hex digits must be rejected");
  assert(!isValidEip55Address(WALLET_B + "0"), "41 hex digits must be rejected");
  assert(!isValidEip55Address(WALLET_B.slice(2)), "missing 0x must be rejected");
  assert(!isValidEip55Address("0x" + "g".repeat(40)), "non-hex characters must be rejected");
});

test("rejects the zero address", () => {
  assert(!isValidEip55Address("0x" + "0".repeat(40)), "zero address must be rejected");
});

test("priced config with a bad wallet refuses to start", () => {
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
      withEnv({ MDF_WALLET: "0xDEADBEEF" }, () => {
        assertThrows(() => loadConfig(yamlPath), "EIP-55", "priced with malformed wallet");
      });
    }
  );
});

test("unpriced config with a bad wallet warns only", () => {
  withTempDir(
    {
      payment: {
        endpoint: "/mdf/pay",
        accepted_chains: ["base"],
        accepted_currencies: ["USDC"],
        wallet: "not-an-address",
      },
    },
    ({ yamlPath }) => {
      withEnv({ MDF_WALLET: undefined }, () => {
        const loaded = loadConfig(yamlPath);
        assert(
          loaded.walletAddress === "not-an-address",
          "malformed wallet should still resolve when nothing is priced"
        );
      });
    }
  );
});

test("trailing newline on a wallet secret is trimmed, not treated as invalid", () => {
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
      withEnv({ MDF_WALLET: WALLET_LIVE + "\n" }, () => {
        const loaded = loadConfig(yamlPath);
        assert(
          loaded.walletAddress === WALLET_LIVE,
          "trailing newline should be trimmed before validation"
        );
      });
    }
  );
});

printSummary();
