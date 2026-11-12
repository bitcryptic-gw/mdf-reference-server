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
import type { PricingConfig, RailConfig } from "../payment/rails.ts";
import type { FacilitatorPool } from "../payment/facilitator.ts";
import type { ReplayStore } from "../payment/lnbtc/replay-store.ts";
import { ValkeyReplayStore, MemoryReplayStore } from "../payment/lnbtc/replay-store.ts";
import type { TokenStore } from "../auth/token-store.ts";
import { ValkeyTokenStore, MemoryTokenStore } from "../auth/token-store.ts";
import { NwcClient } from "../payment/lnbtc/nwc.ts";
import { LnbtcGate } from "../payment/lnbtc/availability.ts";
import { MintLimiter } from "../payment/rate-limit.ts";
import { FacilitatorPool as Pool } from "../payment/facilitator.ts";

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
 * Read a secret from `/run/secrets/<name>`. Deliberately no env fallback: the
 * baseline says file-mounted only, and an env var is visible in
 * `docker inspect`.
 */
export function readSecretFile(name: string): string | null {
  const path = `/run/secrets/${name}`;
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
      `mdf-server: ${why} requires the '${name}' secret — mount it at /run/secrets/${name}`
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
 * Rails are emitted verbatim as configured — including a rail whose runtime
 * dependency happens to be down. `access` is emitted only when it is `token`,
 * matching the spec's default.
 */
export function buildMdfJson(
  config: MdfConfig,
  walletAddress: string | null
): Record<string, unknown> {
  const siteUrl = config.site.url.replace(/\/$/, "");

  const renderEntry = (entry: PriceEntry): Record<string, unknown> => ({
    rails: entry.rails.map((rail) => ({
      scheme: rail.scheme,
      network: rail.network,
      asset: rail.asset,
      amount: rail.amount,
    })),
    ...(entry.access === "token" ? { access: "token" } : {}),
  });

  const pricing: Record<string, unknown> = { default: renderEntry(config.pricing.default) };
  if (config.pricing.sections && Object.keys(config.pricing.sections).length > 0) {
    pricing.sections = Object.fromEntries(
      Object.entries(config.pricing.sections).map(([pattern, entry]) => [pattern, renderEntry(entry)])
    );
  }

  const doc: Record<string, unknown> = {
    mdf_version: mdfVersion(),
    site: siteUrl,
  };
  if (config.site.name) doc.name = config.site.name;
  doc.pricing = pricing;

  if (config.auth) {
    doc.auth = {
      endpoint: resolveEndpoint(config.auth.endpoint, siteUrl),
      token_ttl_seconds: config.auth.token_ttl_seconds,
    };
  }

  doc.content_signals = {
    ai_train: config.signals.ai_train,
    ai_input: config.signals.ai_input,
    search: config.signals.search,
    human_only: config.signals.human_only,
  };
  doc.formats = {
    dialect: config.content.dialect,
    frontmatter: config.content.frontmatter,
    math: config.content.math,
  };

  if (config.feed) {
    doc.feed = {
      url: resolveEndpoint(config.feed.url, siteUrl),
      format: config.feed.format,
      ...(config.feed.websub_hub ? { websub_hub: config.feed.websub_hub } : {}),
      ...(config.feed.change_types?.length ? { change_types: config.feed.change_types } : {}),
    };
  }
  if (config.site.contact) doc.contact = config.site.contact;

  // walletAddress is not emitted: the authoritative recipient is accepts[].payTo
  // in the live offer (decision 19), never a static document.
  void walletAddress;
  return doc;
}

function resolveEndpoint(endpoint: string, siteUrl: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  return `${siteUrl.replace(/\/$/, "")}${endpoint}`;
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

/** The pricing view the payment layer consumes (structurally identical). */
export function pricingView(config: MdfConfig): PricingConfig {
  return {
    default: { rails: config.pricing.default.rails as RailConfig[], access: config.pricing.default.access },
    ...(config.pricing.sections
      ? {
          sections: Object.fromEntries(
            Object.entries(config.pricing.sections).map(([k, v]) => [
              k,
              { rails: v.rails as RailConfig[], access: v.access },
            ])
          ),
        }
      : {}),
  };
}

function validate(config: MdfConfig, walletAddress: string | null): void {
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
    console.warn(
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
        console.warn(
          `[mdf:config] no facilitator.rpc entry for ${rail.rail.network} — on-chain confirmation is disabled for it`
        );
      }
    }
  }

  // lnbtc: rails require the lightning block, and the block requires Valkey.
  const lnbtcRails = everyRail.filter(({ rail }) => isLnbtcNetwork(rail.rail.network));
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
    console.warn(
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

  const walletAddress = readSecret("wallet_address");
  validate(config, walletAddress);

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
          perMinute: lightning.mint.per_client_minute ?? lightning.mint.per_client_per_minute,
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
    mdfJson: JSON.stringify(buildMdfJson(config, walletAddress), null, 2),
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
