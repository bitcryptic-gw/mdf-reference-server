/**
 * Config loading: validation, secret resolution, and `/mdf.json` generation.
 *
 * Two rules shape this file.
 *
 * **`/mdf.json` is rendered from the configured rails, never from runtime
 * state.** A rail that is degraded, breaker-open or rate-limited is still
 * declared; only the 402 omits it — the spec's subtraction-only divergence. The
 * one exception is `lightning.enabled: false`: that rail is not configured, so it
 * is not declared either. Rendering from config is what makes the 402's
 * `accepts[]` match `mdf.json` "one-to-one by construction" rather than by
 * coincidence; if it read runtime state the two would disagree exactly when
 * something was wrong, which is the worst time to be ambiguous.
 *
 * **Secrets come from files, and absence is a startup error when required.**
 * Wallet address, `nwc_uri` and the Valkey password are read from
 * `/run/secrets/<name>`; the config file never holds them, and an unset required
 * secret refuses to start rather than failing at request time.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";
import yaml from "js-yaml";
import {
  MdfConfigSchema,
  type MdfConfig,
  type PriceEntry,
  type LightningConfig,
  type ValkeyConfig,
} from "./schema.ts";
import { isValidEip55Address } from "./wallet.ts";
import {
  SUPPORTED_NETWORKS,
  isLnbtcNetwork,
  tokenScopeForPath,
  validateRail,
} from "../payment/rails.ts";
import type { RailConfig } from "../payment/rails.ts";
import { buildMdfJson } from "./mdf-json.ts";
import type { FacilitatorPool } from "../payment/facilitator.ts";
import type { ReplayStore } from "../payment/lnbtc/replay-store.ts";
import { ValkeyReplayStore, MemoryReplayStore } from "../payment/lnbtc/replay-store.ts";
import type { TokenStore } from "../auth/token-store.ts";
import { ValkeyTokenStore, MemoryTokenStore } from "../auth/token-store.ts";
import { NwcClient } from "../payment/lnbtc/nwc.ts";
import { LnbtcGate } from "../payment/lnbtc/availability.ts";
import { MintLimiter } from "../payment/rate-limit.ts";
import { FacilitatorPool as Pool } from "../payment/facilitator.ts";
import type { LightningBreaker } from "../payment/breaker.ts";
import type { DecodedInvoice } from "../payment/lnbtc/bolt11.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LnbtcRuntime {
  enabled: true;
  network: string;
  /** Receiver node pubkey (payTo). Null until resolved from get_info. */
  payeePubkey: string | null;
  client: NwcClient;
  gate: LnbtcGate;
  limiter: MintLimiter;
  replay: ReplayStore;
  invoiceExpirySeconds: number;
  breaker: { initialBackoffMs: number; maxBackoffMs: number };
  /**
   * Invoice decoder. Production always uses `decodeBolt11`; the seam exists so
   * the payment facade's preimage/replay/expiry handling can be tested without a
   * BOLT11 signer (minting an invoice for an arbitrary binding is the one thing
   * the test suite cannot do offline).
   */
  decodeInvoiceFrom?: (invoice: string) => DecodedInvoice;
  /**
   * The invoice-creation breaker, set by `index.ts` once the startup check has
   * run (its probe needs a live gate). `/health` reads its snapshot.
   */
  breakerRuntime?: LightningBreaker;
}

export interface LoadedConfig {
  config: MdfConfig;
  /** Ready-to-serve `/mdf.json`, generated from the configured rails. */
  mdfJson: string;
  contentDir: string;
  walletAddress: string | null;
  facilitator: { legs: string[]; timeoutMs: number; rpc: Record<string, string> } | null;
  pool: FacilitatorPool | null;
  tokenStore: TokenStore;
  tokenStoreBackend: "valkey" | "memory";
  replayStore: ReplayStore | null;
  lnbtc: LnbtcRuntime | null;
  valkey: { password?: string } | null;
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * Read a secret from `<secrets dir>/<name>`, `/run/secrets` by default.
 * Deliberately no env fallback for the *value*: the baseline says file-mounted
 * only, and a secret in an env var is visible in `docker inspect`. The directory
 * itself may be overridden (a path, never a secret) so a local acceptance run
 * can use a private directory instead of the container's mount point.
 */
export function secretsDir(): string {
  return process.env.MDF_SECRETS_DIR ?? "/run/secrets";
}

export function readSecretFile(name: string): string | null {
  const path = `${secretsDir()}/${name}`;
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (stat.size > 4096) throw new Error(`secret ${name} is implausibly large`);
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    throw new Error(`mdf-server: cannot read secret '${name}': ${(err as Error).message}`);
  }
}

function requireSecret(name: string, why: string): string {
  const value = readSecretFile(name);
  if (!value) {
    throw new Error(
      `mdf-server: ${why} requires the '${name}' secret — mount it at ${secretsDir()}/${name}`
    );
  }
  return value;
}

/** Test seam: the loader reads secrets through this hook. */
export type SecretReader = (name: string) => string | null;
let secretReader: SecretReader = readSecretFile;

export function setSecretReaderForTests(reader: SecretReader | null): void {
  secretReader = reader ?? readSecretFile;
}

// ---------------------------------------------------------------------------
// /mdf.json
// ---------------------------------------------------------------------------

function mdfVersion(): string {
  // The document declares the specification version this server targets.
  return "0.3.1";
}

/**
 * Render `/mdf.json` from configuration alone.
 *
 * Delegates to `config/mdf-json.ts`, which is structurally typed so it cannot
 * reach a breaker, a gate, a limiter or a clock — the guarantee that a rail is
 * declared whenever it is configured, even while it is degraded.
 */
export function buildMdfJsonFor(config: MdfConfig): Record<string, unknown> {
  const pricing: { default: (typeof config.pricing)["default"]; sections?: typeof config.pricing.sections } = {
    default: config.pricing.default,
    ...(config.pricing.sections ? { sections: config.pricing.sections } : {}),
  };
  return buildMdfJson({
    site: config.site,
    pricing,
    ...(config.auth ? { auth: config.auth } : {}),
    signals: config.signals,
    formats: {
      dialect: config.content.dialect,
      frontmatter: config.content.frontmatter,
      math: config.content.math,
    },
    ...(config.feed ? { feed: config.feed } : {}),
    mdfVersion: mdfVersion(),
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function pricingEntries(config: MdfConfig): Array<{ label: string; entry: PriceEntry }> {
  const entries: Array<{ label: string; entry: PriceEntry }> = [
    { label: "pricing.default", entry: config.pricing.default },
  ];
  for (const [pattern, entry] of Object.entries(config.pricing.sections ?? {})) {
    entries.push({ label: `pricing.sections['${pattern}']`, entry });
  }
  return entries;
}

function validate(
  config: MdfConfig,
  walletAddress: string | null,
  log: (message: string) => void
): void {
  const errors: string[] = [];
  const entries = pricingEntries(config);

  const hasTokenEntry = entries.some(({ entry }) => entry.access === "token");
  const hasNonEmpty = entries.some(({ entry }) => entry.rails.length > 0);
  const everyRail = entries.flatMap(({ label, entry }) =>
    entry.rails.map((rail) => ({ label, rail }))
  );

  // Rails: every one must be servable by this build.
  for (const { label, rail } of everyRail) {
    const result = validateRail(rail as RailConfig, label);
    if (!result.ok) errors.push(result.reason);
  }

  // Networks this build cannot settle are refused even if the rail is otherwise
  // well-formed (validateRail covers it, kept here as an explicit statement).
  for (const { label, rail } of everyRail) {
    if (!SUPPORTED_NETWORKS.has(rail.network)) {
      errors.push(`${label}: network '${rail.network}' is not served by this build`);
    }
  }

  if (hasTokenEntry && !config.auth) {
    errors.push("a `access: token` price entry requires an [auth] block with an endpoint");
  }
  if (config.auth && !hasTokenEntry) {
    // Not an error: an auth endpoint with no token section is inert. Warn only.
    log(
      "[mdf:config] [auth] is configured but no price entry uses `access: token` — the endpoint is inert"
    );
  }

  // Wallet: required once any eip155 rail is priced, and must be EIP-55.
  const eip155Priced = everyRail.some(({ rail }) => rail.network.startsWith("eip155:"));
  if (eip155Priced) {
    if (!walletAddress) {
      errors.push(
        "an eip155 rail is priced but no wallet address was resolved — mount /run/secrets/wallet_address"
      );
    } else if (!isValidEip55Address(walletAddress)) {
      errors.push(
        `the wallet address is not a valid EIP-55 checksummed address (starts '${walletAddress.slice(0, 6)}')`
      );
    }
    if (!config.facilitator) {
      errors.push("an eip155 rail is priced but no [facilitator] block is configured");
    }
  }

  if (config.facilitator) {
    for (const rail of everyRail) {
      if (!rail.rail.network.startsWith("eip155:")) continue;
      if (!config.facilitator.rpc[rail.rail.network]) {
        log(
          `[mdf:config] no facilitator.rpc entry for ${rail.rail.network} — on-chain confirmation is disabled for it`
        );
      }
    }
  }

  // lnbtc: rails require the lightning block, and the block requires Valkey.
  const lnbtcRails = everyRail.filter(({ rail }) => isLnbtcNetwork(rail.network));
  const lightning = config.lightning;
  if (lnbtcRails.length > 0) {
    if (!lightning?.enabled) {
      errors.push(
        `an lnbtc rail is configured but lightning.enabled is false (${lnbtcRails[0].label}) — ` +
          `either enable lightning or remove the rail`
      );
    }
    if (!config.valkey) {
      errors.push(
        "lightning is enabled but no [valkey] block is configured — the lnbtc replay store requires it"
      );
    }
  }
  if (lightning?.enabled && lnbtcRails.length === 0) {
    log(
      "[mdf:config] lightning is enabled but no lnbtc rail is priced — no invoice will be minted"
    );
  }
  if (lightning) {
    if (!isLnbtcNetwork(lightning.network)) {
      errors.push(`lightning.network '${lightning.network}' is not an lnbtc network`);
    }
    if (lightning.breaker_max_backoff_seconds < lightning.breaker_initial_backoff_seconds) {
      errors.push(
        `lightning.breaker_max_backoff_seconds (${lightning.breaker_max_backoff_seconds}) must be >= ` +
          `lightning.breaker_initial_backoff_seconds (${lightning.breaker_initial_backoff_seconds})`
      );
    }
  }

  // Token store is explicit; valkey needs a URL, and so does anything lnbtc.
  if (config.token_store === "valkey" && !config.valkey) {
    errors.push("token_store: valkey requires a [valkey] block");
  }
  if (hasNonEmpty && !config.token_store) {
    errors.push("token_store must be set to 'valkey' or 'memory'");
  }

  if (errors.length > 0) {
    throw new Error(
      `mdf-server: configuration errors:\n${errors.map((e) => `  • ${e}`).join("\n")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** Path to mdf.yaml. */
  configPath?: string;
  /** Override the secret reader (tests). */
  readSecret?: SecretReader;
  /** Inject the logger used for startup warnings. */
  log?: (message: string) => void;
}

function parseValkeyUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`mdf-server: invalid Valkey port in ${url}`);
  }
  return { host: parsed.hostname, port };
}

export function loadConfig(options: LoadOptions | string = "./mdf.yaml"): LoadedConfig {
  const opts: LoadOptions = typeof options === "string" ? { configPath: options } : options;
  const configPath = opts.configPath ?? "./mdf.yaml";
  const log = opts.log ?? ((m: string) => console.warn(m));
  const readSecret = opts.readSecret ?? secretReader;

  const absPath = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  if (!existsSync(absPath)) throw new Error(`mdf-server: config file not found: ${absPath}`);

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new Error(`mdf-server: failed to parse YAML: ${(err as Error).message}`);
  }

  const parsed = MdfConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`mdf-server: invalid configuration:\n${issues}`);
  }
  const config = parsed.data;

  // Trimmed here as well as in the file reader: a reader injected by a test (or
  // a future secret backend) must not be able to break EIP-55 on a trailing \n.
  const walletAddress = readSecret("wallet_address")?.trim() || null;
  validate(config, walletAddress, log);

  const valkeyPassword = config.valkey ? readSecret("valkey_password") ?? undefined : undefined;

  // ---- stores -------------------------------------------------------------
  let tokenStore: TokenStore;
  if (config.token_store === "valkey") {
    const { host, port } = parseValkeyUrl(config.valkey!.url);
    tokenStore = new ValkeyTokenStore({
      host,
      port,
      password: valkeyPassword,
      connectTimeoutMs: config.valkey!.connect_timeout_ms,
      commandTimeoutMs: config.valkey!.command_timeout_ms,
    });
  } else {
    tokenStore = new MemoryTokenStore();
    log(
      "[mdf:config] token_store is 'memory': tokens are instance-local. Behind a load balancer a " +
        "token will only be accepted by the instance that minted it, and a restart drops it. " +
        "Production should set token_store: valkey."
    );
  }

  const replayStore: ReplayStore | null = config.valkey
    ? new ValkeyReplayStore({
        host: parseValkeyUrl(config.valkey.url).host,
        port: parseValkeyUrl(config.valkey.url).port,
        password: valkeyPassword,
        connectTimeoutMs: config.valkey.connect_timeout_ms,
        commandTimeoutMs: config.valkey.command_timeout_ms,
      })
    : null;

  // ---- facilitator --------------------------------------------------------
  const pool = config.facilitator
    ? new Pool({
        legs: config.facilitator.legs,
        timeoutMs: config.facilitator.timeout_ms,
        rpc: config.facilitator.rpc,
      })
    : null;

  // ---- lnbtc --------------------------------------------------------------
  let lnbtc: LnbtcRuntime | null = null;
  if (config.lightning?.enabled) {
    const nwcUri = requireSecret("nwc_uri", "lightning.enabled");
    const lightning: LightningConfig = config.lightning;
    const client = new NwcClient({
      uri: nwcUri,
      connectTimeoutMs: lightning.nwc.connect_timeout_ms,
      responseTimeoutMs: lightning.nwc.response_timeout_ms,
    });
    lnbtc = {
      enabled: true,
      network: lightning.network,
      payeePubkey: lightning.node_pubkey ?? null,
      client,
      // Starts degraded; index.ts runs the automated check and applies the result.
      gate: new LnbtcGate({ enabled: true }),
      limiter: new MintLimiter({
        global: {
          capacity: lightning.mint.global_burst,
          perMinute: lightning.mint.global_per_minute,
        },
        perClient: {
          capacity: lightning.mint.per_client_burst,
          perMinute: lightning.mint.per_client_per_minute,
        },
      }),
      replay: replayStore ?? new MemoryReplayStore(),
      invoiceExpirySeconds: config.payment.max_timeout_seconds,
      breaker: {
        initialBackoffMs: lightning.breaker_initial_backoff_seconds * 1000,
        maxBackoffMs: lightning.breaker_max_backoff_seconds * 1000,
      },
    };
  }

  const contentDir = isAbsolute(config.content.dir)
    ? config.content.dir
    : resolve(process.cwd(), config.content.dir);
  if (!existsSync(contentDir)) {
    throw new Error(`mdf-server: content directory not found: ${contentDir}`);
  }

  return {
    config,
    mdfJson: JSON.stringify(buildMdfJsonFor(config), null, 2),
    contentDir,
    walletAddress,
    facilitator: config.facilitator
      ? {
          legs: config.facilitator.legs,
          timeoutMs: config.facilitator.timeout_ms,
          rpc: config.facilitator.rpc,
        }
      : null,
    pool,
    tokenStore,
    tokenStoreBackend: config.token_store,
    replayStore,
    lnbtc,
    valkey: config.valkey ? { password: valkeyPassword } : null,
  };
}

/** Section prefix a token is scoped to (`/private/internals` → `/private/`). */
export function tokenScopeFor(urlPath: string): string {
  return tokenScopeForPath(urlPath);
}
