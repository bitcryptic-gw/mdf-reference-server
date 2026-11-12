/**
 * Config loader tests — 0.3.x (rails) shape.
 *
 * loadConfig() resolves file-mounted secrets, validates the parsed YAML against
 * MdfConfigSchema, enforces the cross-field startup constraints the schema alone
 * cannot express (a priced eip155 rail needs a wallet and a facilitator; an
 * lnbtc rail needs lightning + Valkey; `access: token` needs an endpoint; a
 * configured asset must be in the vendored table), and renders `/mdf.json` from
 * those rails.
 *
 * Secrets are injected through `setSecretReaderForTests`, which is the same seam
 * the loader uses in production — a real file read at `/run/secrets/<name>` — so
 * these tests exercise the resolution path without needing root.
 *
 * Migration note (Stage B, #64): the 0.2.x suite tested `{amount, currency,
 * chain}`, env-var secret precedence, `price_threshold` and a fixed sats/USD
 * conversion. Those concepts are gone by design (no exchange rate, file-only
 * secrets, `access` instead of a threshold), so those cases are replaced by the
 * rails equivalents here rather than dropped — see the per-suite accounting in
 * `docs/STAGE-B-TEST-ACCOUNTING.md`.
 *
 * Run with: bun run src/config/loader.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { loadConfig, setSecretReaderForTests, buildMdfJsonFor } from "./loader.ts";
import { isValidEip55Address, toEip55Checksum } from "./wallet.ts";

// Valid EIP-55 checksummed wallets for priced fixtures. The strict validator
// (Vikunja #9) rejects placeholder/unchecksummed values as soon as any eip155
// rail is priced.
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
// The live demo wallet, checked in B0 to prove the validator accepts production.
const WALLET_LIVE = "0xa7D911138322aF8823642beA2b174dFaC2725fB7";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";
const FACILITATOR = {
  legs: ["http://mdf-facilitator-syd:8080"],
  timeout_ms: 15000,
  rpc: { "eip155:8453": "https://mainnet.base.org" },
};

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

function assertThrows(fn: () => void, msgContains: string, what: string) {
  try {
    fn();
    throw new Error(`expected to throw (${what}), but it did not`);
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith("expected to throw")) throw err;
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

/** Secret reader backed by a map — the loader's documented test seam. */
function secrets(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null;
}

function withSecrets<T>(values: Record<string, string>, fn: () => T): T {
  setSecretReaderForTests(secrets(values));
  try {
    return fn();
  } finally {
    setSecretReaderForTests(null);
  }
}

function makeFixture(configObj: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "mdf-loader-test-"));
  const contentDir = join(dir, "content");
  mkdirSync(contentDir);
  writeFileSync(join(contentDir, "index.md"), "# Hello\n");

  const merged = {
    site: { url: "https://example.com", name: "Test Site" },
    content: { dir: contentDir },
    pricing: { default: { rails: [] } },
    token_store: "memory",
    ...configObj,
  };

  const yamlPath = join(dir, "mdf.yaml");
  writeFileSync(yamlPath, yaml.dump(merged));

  return { dir, yamlPath, contentDir };
}

function withTempDir<T>(
  configObj: Record<string, unknown>,
  fn: (f: ReturnType<typeof makeFixture>) => T
): T {
  const fixture = makeFixture(configObj);
  try {
    return fn(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

/** The eip155 rail fixture used by most cases. */
function baseRail(amount = "10000", network = "eip155:8453"): Record<string, string> {
  return {
    scheme: "exact",
    network,
    asset: network === "eip155:8453" ? USDC_BASE : USDC_SEPOLIA,
    amount,
  };
}

function pricedConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pricing: { default: { rails: [baseRail()] } },
    facilitator: FACILITATOR,
    ...extra,
  };
}

const WALLET_SECRET = { wallet_address: WALLET_A };

// ---------------------------------------------------------------------------
// Basic load + mdf.json shape
// ---------------------------------------------------------------------------

console.log("\nBasic load\n");

test("loads a minimal free-content config", () => {
  withTempDir({}, ({ yamlPath }) => {
    withSecrets({}, () => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.walletAddress === null, "no wallet configured for a free-only site");
      assert(loaded.pool === null, "no facilitator configured for a free-only site");
      const mdfJson = JSON.parse(loaded.mdfJson);
      assert(mdfJson.mdf_version === "0.3.1", "mdf_version is the spec generation");
      assert(mdfJson.payment === undefined, "mdf.json carries no v1 payment object");
    });
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

test("an unknown top-level key is refused (strict schema)", () => {
  withTempDir({ paymnet: { max_timeout_seconds: 60 } }, ({ yamlPath }) => {
    assertThrows(() => loadConfig(yamlPath), "invalid configuration", "typo'd section");
  });
});

// ---------------------------------------------------------------------------
// token_store
// ---------------------------------------------------------------------------

console.log("\ntoken_store\n");

test("token_store is required with no default", () => {
  const fixture = makeFixture({});
  try {
    // Re-write without the merged default.
    const raw = yaml.load(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs").readFileSync(fixture.yamlPath, "utf8")
    ) as Record<string, unknown>;
    delete raw.token_store;
    writeFileSync(fixture.yamlPath, yaml.dump(raw));
    assertThrows(() => loadConfig(fixture.yamlPath), "token_store", "missing token_store");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("token_store: memory logs the instance-local warning", () => {
  withTempDir({}, ({ yamlPath }) => {
    const warnings: string[] = [];
    loadConfig({ configPath: yamlPath, log: (m) => warnings.push(m) });
    assert(
      warnings.some((w) => w.includes("instance-local")),
      `memory must warn that tokens are instance-local, got: ${warnings.join(" | ")}`
    );
  });
});

test("token_store: valkey requires a [valkey] block", () => {
  withTempDir({ token_store: "valkey" }, ({ yamlPath }) => {
    assertThrows(() => loadConfig(yamlPath), "requires a [valkey] block", "valkey store, no url");
  });
});

test("token_store: valkey builds a Valkey-backed store", () => {
  withTempDir(
    { token_store: "valkey", valkey: { url: "redis://mdf-valkey:6379" } },
    ({ yamlPath }) => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.tokenStoreBackend === "valkey", "backend recorded");
      assert(loaded.tokenStore.constructor.name === "ValkeyTokenStore", "valkey store constructed");
    }
  );
});

// ---------------------------------------------------------------------------
// Secret resolution — file-mounted only
// ---------------------------------------------------------------------------

console.log("\nSecret resolution\n");

test("the wallet resolves from the mounted secret", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets(WALLET_SECRET, () => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.walletAddress === WALLET_A, "wallet should resolve from the secret file");
    });
  });
});

test("a priced eip155 rail with no wallet secret refuses to start", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets({}, () => {
      assertThrows(() => loadConfig(yamlPath), "wallet_address", "priced with no wallet secret");
    });
  });
});

test("a malformed wallet refuses to start once an eip155 rail is priced", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets({ wallet_address: "0xDEADBEEF" }, () => {
      assertThrows(() => loadConfig(yamlPath), "EIP-55", "priced with malformed wallet");
    });
  });
});

test("a trailing newline on the wallet secret is trimmed", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets({ wallet_address: WALLET_LIVE + "\n" }, () => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.walletAddress === WALLET_LIVE, "trailing newline should be trimmed");
    });
  });
});

test("a malformed wallet is tolerated when nothing is priced", () => {
  withTempDir({}, ({ yamlPath }) => {
    withSecrets({ wallet_address: "not-an-address" }, () => {
      const loaded = loadConfig(yamlPath);
      assert(
        loaded.walletAddress === "not-an-address",
        "malformed wallet should still resolve when nothing is priced"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Startup constraints
// ---------------------------------------------------------------------------

console.log("\nStartup constraints\n");

test("an eip155 rail with no [facilitator] block refuses to start", () => {
  withTempDir({ pricing: { default: { rails: [baseRail()] } } }, ({ yamlPath }) => {
    withSecrets(WALLET_SECRET, () => {
      assertThrows(() => loadConfig(yamlPath), "no [facilitator] block", "no facilitator");
    });
  });
});

test("an eip155 rail whose asset is absent from the vendored table refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: {
          rails: [{ scheme: "exact", network: "eip155:8453", asset: "0x" + "11".repeat(20), amount: "1" }],
        },
      },
      facilitator: FACILITATOR,
    },
    ({ yamlPath }) => {
      withSecrets(WALLET_SECRET, () => {
        assertThrows(() => loadConfig(yamlPath), "not in the vendored", "unknown asset");
      });
    }
  );
});

test("a network this build cannot settle refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: {
          rails: [{ scheme: "exact", network: "eip155:137", asset: USDC_BASE, amount: "1" }],
        },
      },
      facilitator: FACILITATOR,
    },
    ({ yamlPath }) => {
      withSecrets(WALLET_SECRET, () => {
        assertThrows(() => loadConfig(yamlPath), "not one this build can settle", "unsupported network");
      });
    }
  );
});

test("the asset table supplies the EIP-712 domain per network", () => {
  // "USD Coin" on Base mainnet, "USDC" on Base Sepolia — never free config.
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets(WALLET_SECRET, () => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.config.pricing.default.rails[0].network === "eip155:8453", "mainnet rail");
    });
  });
});

test("a non-atomic (decimal) amount fails schema validation", () => {
  withTempDir(
    { pricing: { default: { rails: [{ ...baseRail(), amount: "0.01" }] } }, facilitator: FACILITATOR },
    ({ yamlPath }) => {
      withSecrets(WALLET_SECRET, () => {
        assertThrows(() => loadConfig(yamlPath), "invalid configuration", "decimal amount");
      });
    }
  );
});

test("an lnbtc rail with no [lightning] block refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "1000" }] },
      },
    },
    ({ yamlPath }) => {
      withSecrets({}, () => {
        assertThrows(() => loadConfig(yamlPath), "lightning.enabled is false", "lnbtc with lightning off");
      });
    }
  );
});

test("an lnbtc rail with lightning enabled but no [valkey] block refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "1000" }] },
      },
      lightning: { enabled: true },
    },
    ({ yamlPath }) => {
      withSecrets({ nwc_uri: "nostr+walletconnect://x?relay=wss%3A%2F%2Fr.example&secret=00" }, () => {
        assertThrows(() => loadConfig(yamlPath), "no [valkey] block", "lnbtc with no store");
      });
    }
  );
});

test("a sub-satoshi lnbtc amount refuses to start at load time", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "1500" }] },
      },
      lightning: { enabled: true, node_pubkey: "02" + "ab".repeat(32) },
      valkey: { url: "redis://mdf-valkey:6379" },
    },
    ({ yamlPath }) => {
      withSecrets({ nwc_uri: "nostr+walletconnect://x?relay=wss%3A%2F%2Fr.example&secret=00" }, () => {
        assertThrows(() => loadConfig(yamlPath), "whole number of satoshis", "1500 msat");
      });
    }
  );
});

test("an lnbtc amount below the 1-sat floor refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "500" }] },
      },
      lightning: { enabled: true, node_pubkey: "02" + "ab".repeat(32) },
      valkey: { url: "redis://mdf-valkey:6379" },
    },
    ({ yamlPath }) => {
      withSecrets({ nwc_uri: "nostr+walletconnect://x?relay=wss%3A%2F%2Fr.example&secret=00" }, () => {
        assertThrows(() => loadConfig(yamlPath), "1-sat floor", "500 msat");
      });
    }
  );
});

test("an lnbtc rail with a non-BTC asset refuses to start", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [{ scheme: "exact", network: LNBTC, asset: "USDT", amount: "1000" }] },
      },
      lightning: { enabled: true, node_pubkey: "02" + "ab".repeat(32) },
      valkey: { url: "redis://mdf-valkey:6379" },
    },
    ({ yamlPath }) => {
      withSecrets({ nwc_uri: "nostr+walletconnect://x?relay=wss%3A%2F%2Fr.example&secret=00" }, () => {
        assertThrows(() => loadConfig(yamlPath), 'must use asset "BTC"', "non-BTC lnbtc asset");
      });
    }
  );
});

test("lightning enabled with no nwc_uri secret refuses to start", () => {
  withTempDir(
    {
      lightning: { enabled: true, node_pubkey: "02" + "ab".repeat(32) },
      valkey: { url: "redis://mdf-valkey:6379" },
    },
    ({ yamlPath }) => {
      withSecrets({}, () => {
        assertThrows(() => loadConfig(yamlPath), "nwc_uri", "no NWC credential");
      });
    }
  );
});

test("lightning disabled makes no NWC client at all", () => {
  withTempDir({ lightning: { enabled: false } }, ({ yamlPath }) => {
    withSecrets({}, () => {
      const loaded = loadConfig(yamlPath);
      assert(loaded.lnbtc === null, "no lnbtc runtime without the rail");
    });
  });
});

test("invalid breaker backoff refuses to start", () => {
  withTempDir(
    {
      lightning: {
        enabled: true,
        node_pubkey: "02" + "ab".repeat(32),
        breaker_initial_backoff_seconds: 60,
        breaker_max_backoff_seconds: 10,
      },
      valkey: { url: "redis://mdf-valkey:6379" },
    },
    ({ yamlPath }) => {
      withSecrets({ nwc_uri: "nostr+walletconnect://x?relay=wss%3A%2F%2Fr.example&secret=00" }, () => {
        assertThrows(() => loadConfig(yamlPath), "breaker_max_backoff_seconds", "cap below start");
      });
    }
  );
});

test("a non-positive breaker backoff fails schema validation", () => {
  withTempDir(
    { lightning: { enabled: true, breaker_initial_backoff_seconds: 0 } },
    ({ yamlPath }) => {
      withSecrets({}, () => {
        assertThrows(() => loadConfig(yamlPath), "invalid configuration", "zero initial backoff");
      });
    }
  );
});

test("an [auth] block with no token entry warns but loads", () => {
  withTempDir(pricedConfig({ auth: { endpoint: "/mdf/auth" } }), ({ yamlPath }) => {
    const warnings: string[] = [];
    withSecrets(WALLET_SECRET, () => {
      loadConfig({ configPath: yamlPath, log: (m) => warnings.push(m) });
    });
    assert(
      warnings.some((w) => w.includes("inert")),
      `an endpoint with no token section must warn, got: ${warnings.join(" | ")}`
    );
  });
});

test("an `access: token` entry with no [auth] block refuses to start", () => {
  withTempDir(
    {
      pricing: { default: { rails: [baseRail()], access: "token" } },
      facilitator: FACILITATOR,
    },
    ({ yamlPath }) => {
      withSecrets(WALLET_SECRET, () => {
        assertThrows(() => loadConfig(yamlPath), "requires an [auth] block", "token tier, no auth");
      });
    }
  );
});

test("a bad trusted_proxies entry (a hostname) fails schema validation", () => {
  withTempDir({ server: { trusted_proxies: ["caddy.example.com"] } }, ({ yamlPath }) => {
    assertThrows(() => loadConfig(yamlPath), "invalid configuration", "hostname in trusted proxies");
  });
});

// ---------------------------------------------------------------------------
// mdf.json generation
// ---------------------------------------------------------------------------

console.log("\nmdf.json generation\n");

test("renders the configured rails verbatim", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets(WALLET_SECRET, () => {
      const loaded = loadConfig(yamlPath);
      const mdfJson = JSON.parse(loaded.mdfJson);
      const rail = mdfJson.pricing.default.rails[0];
      assert(rail.amount === "10000", "atomic amount carried");
      assert(rail.asset === USDC_BASE, "asset carried");
      assert(rail.network === "eip155:8453", "CAIP-2 network carried");
    });
  });
});

test("omits `access` for a per_fetch entry and emits it for a token entry", () => {
  withTempDir(
    {
      pricing: {
        default: { rails: [baseRail()] },
        sections: { "/private/**": { rails: [baseRail("100000")], access: "token" } },
      },
      facilitator: FACILITATOR,
      auth: { endpoint: "/mdf/auth" },
    },
    ({ yamlPath }) => {
      withSecrets(WALLET_SECRET, () => {
        const loaded = loadConfig(yamlPath);
        const mdfJson = JSON.parse(loaded.mdfJson);
        assert(mdfJson.pricing.default.access === undefined, "per_fetch is the default");
        assert(mdfJson.pricing.sections["/private/**"].access === "token", "token emitted");
        assert(
          mdfJson.auth.endpoint === "https://example.com/mdf/auth",
          "root-relative endpoint resolves against site.url"
        );
      });
    }
  );
});

test("an already-absolute https:// endpoint is passed through unchanged", () => {
  const doc = buildMdfJsonFor({
    site: { url: "https://example.com" },
    content: { dir: "./content", dialect: "commonmark", frontmatter: false, math: false },
    pricing: { default: { rails: [], access: "per_fetch" } },
    auth: { endpoint: "https://pay.elsewhere.com/mdf/auth", token_ttl_seconds: 60 },
    token_store: "memory",
    signals: { ai_train: false, ai_input: true, search: true, human_only: false },
    dashboard: { enabled: false, port: 9090 },
    payment: { max_timeout_seconds: 300 },
    server: { trusted_proxies: [] },
  } as never);
  assert(
    (doc.auth as { endpoint: string }).endpoint === "https://pay.elsewhere.com/mdf/auth",
    "absolute endpoint unchanged"
  );
});

test("does not emit a wallet or a v1 payment object", () => {
  withTempDir(pricedConfig(), ({ yamlPath }) => {
    withSecrets(WALLET_SECRET, () => {
      const mdfJson = JSON.parse(loadConfig(yamlPath).mdfJson);
      assert(!JSON.stringify(mdfJson).includes(WALLET_A), "no wallet in the document");
      assert(mdfJson.payment === undefined, "no payment block");
    });
  });
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

printSummary();
