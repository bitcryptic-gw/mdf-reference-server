import { readFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import yaml from "js-yaml";
import { MdfConfigSchema, type MdfConfig, type FacilitatorConfig } from "./schema.ts";
import { isValidEip55Address } from "./wallet.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  /** Validated, fully-resolved config */
  config: MdfConfig;
  /** Ready-to-serve /mdf.json payload (serialised) */
  mdfJson: string;
  /** Resolved absolute path to the content directory */
  contentDir: string;
  /** Wallet address — from config or secret */
  walletAddress: string | null;
  /** Facilitator config — resolved from config, optional */
  facilitatorConfig: FacilitatorConfig | null;
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a secret value using the priority order:
 *   1. Docker secret file at /run/secrets/<name>
 *   2. Environment variable <envVar>
 *   3. Inline value from config (least preferred)
 *
 * Returns null if not found anywhere.
 */
function resolveSecret(
  secretName: string,
  envVar: string,
  inlineValue?: string
): string | null {
  const secretPath = `/run/secrets/${secretName}`;
  if (existsSync(secretPath)) {
    const val = readFileSync(secretPath, "utf8").trim();
    if (val.length > 0) return val;
  }

  const envVal = process.env[envVar];
  if (envVal && envVal.trim().length > 0) return envVal.trim();

  if (inlineValue && inlineValue.trim().length > 0) return inlineValue.trim();

  return null;
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an endpoint value against the site base URL.
 * Root-relative paths (/mdf/pay) are joined to the site URL.
 * Absolute https:// URLs are returned as-is.
 */
function resolveEndpoint(endpoint: string, siteUrl: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  const base = siteUrl.replace(/\/$/, "");
  return `${base}${endpoint}`;
}

// ---------------------------------------------------------------------------
// mdf.json generation
// ---------------------------------------------------------------------------

function buildMdfJson(config: MdfConfig, walletAddress: string | null): object {
  const siteUrl = config.site.url.replace(/\/$/, "");

  const resolve = (ep: string) => resolveEndpoint(ep, siteUrl);

  const doc: Record<string, unknown> = {
    mdf_version: "1.0",
    site: siteUrl,
  };

  if (config.site.name) doc.name = config.site.name;

  // Pricing
  const pricing: Record<string, unknown> = {
    default: normalisePriceEntry(config.pricing.default),
  };
  if (config.pricing.sections && Object.keys(config.pricing.sections).length > 0) {
    pricing.sections = Object.fromEntries(
      Object.entries(config.pricing.sections).map(([k, v]) => [
        k,
        normalisePriceEntry(v),
      ])
    );
  }
  doc.pricing = pricing;

  // Payment (only if configured and at least one non-zero price exists)
  if (config.payment && hasNonZeroPrice(config)) {
    const paymentDoc: Record<string, unknown> = {
      endpoint: resolve(config.payment.endpoint),
      accepted_chains: config.payment.accepted_chains,
      accepted_currencies: config.payment.accepted_currencies,
    };
    if (walletAddress) paymentDoc.wallet = walletAddress;
    doc.payment = paymentDoc;
  }

  // Auth
  if (config.auth) {
    doc.auth = {
      endpoint: resolve(config.auth.endpoint),
      token_ttl_seconds: config.auth.token_ttl_seconds,
      price_threshold: config.auth.price_threshold,
    };
  }

  // Content signals (only emit if non-default)
  doc.content_signals = {
    ai_train: config.signals.ai_train,
    ai_input: config.signals.ai_input,
    search: config.signals.search,
    human_only: config.signals.human_only,
  };

  // Formats
  doc.formats = {
    dialect: config.content.dialect,
    frontmatter: config.content.frontmatter,
    math: config.content.math,
  };

  // Feed
  if (config.feed) {
    const feedDoc: Record<string, unknown> = {
      url: resolve(config.feed.url),
      format: config.feed.format,
    };
    if (config.feed.websub_hub) feedDoc.websub_hub = config.feed.websub_hub;
    if (config.feed.change_types?.length) {
      feedDoc.change_types = config.feed.change_types;
    }
    doc.feed = feedDoc;
  }

  if (config.site.contact) doc.contact = config.site.contact;

  return doc;
}

function normalisePriceEntry(entry: { amount: string; currency?: string | null; chain?: string | null }) {
  return {
    amount: entry.amount,
    currency: entry.currency ?? null,
    chain: entry.chain ?? null,
  };
}

function hasNonZeroPrice(config: MdfConfig): boolean {
  if (parseFloat(config.pricing.default.amount) > 0) return true;
  if (config.pricing.sections) {
    return Object.values(config.pricing.sections).some(
      (s) => parseFloat(s.amount) > 0
    );
  }
  return false;
}

function hasX402Price(config: MdfConfig): boolean {
  const entries = [config.pricing.default];
  if (config.pricing.sections) {
    entries.push(...Object.values(config.pricing.sections));
  }
  return entries.some(
    (s) => parseFloat(s.amount) > 0 && (!s.chain || s.chain !== "lightning")
  );
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Enforce startup preconditions that cannot be expressed in the Zod schema alone.
 * Throws with a descriptive message on any violation.
 */
/**
 * Non-lightning chains carrying a non-zero price. These are the chains for
 * which the x402 rail is selected, and therefore the chains that need a
 * facilitator asset entry.
 */
function x402ChainsUsed(config: MdfConfig): string[] {
  const entries = [
    config.pricing.default,
    ...Object.values(config.pricing.sections ?? {}),
  ];
  const chains = new Set<string>();
  for (const entry of entries) {
    const chain = entry.chain?.toLowerCase();
    if (parseFloat(entry.amount) > 0 && chain && chain !== "lightning") {
      chains.add(chain);
    }
  }
  return [...chains];
}

function validateStartupConstraints(
  config: MdfConfig,
  walletAddress: string | null,
  facilitatorConfig: FacilitatorConfig | null
): void {
  const errors: string[] = [];

  if (hasNonZeroPrice(config)) {
    if (!config.payment) {
      errors.push(
        "pricing has non-zero amounts but no [payment] block is configured"
      );
    } else {
      if (!walletAddress) {
        errors.push(
          "non-zero pricing requires a wallet address — set via /run/secrets/wallet_address, MDF_WALLET env var, or payment.wallet in config"
        );
      }
    }
  }

  // Wallet format: strict EIP-55 checksum once any pricing is non-zero. A
  // present-but-malformed wallet with nothing priced is a warning only, so a
  // free-only site can carry a stale/placeholder value without failing to boot.
  if (walletAddress && !isValidEip55Address(walletAddress)) {
    // Never echo more than the first 6 characters of a resolved value.
    const prefix = walletAddress.slice(0, 6);
    if (hasNonZeroPrice(config)) {
      errors.push(
        `payment.wallet is not a valid EIP-55 checksummed address (value starts with '${prefix}') — expected 0x + 40 hex digits with checksum casing, and not the zero address`
      );
    } else {
      console.warn(
        `[mdf:config] payment.wallet is set but is not a valid EIP-55 checksummed address (value starts with '${prefix}') — nothing is priced, so this is a warning only`
      );
    }
  }

  if (hasX402Price(config)) {
    if (!facilitatorConfig) {
      errors.push(
        "x402 pricing (non-lightning chain with amount > 0) detected but no [facilitator] block is configured"
      );
    } else {
      for (const chain of x402ChainsUsed(config)) {
        if (!facilitatorConfig.chains[chain]) {
          errors.push(
            `x402 pricing on chain '${chain}' requires facilitator.chains.${chain}.asset`
          );
        } else if (!facilitatorConfig.chains[chain].rpc_url) {
          console.warn(
            `[mdf:config] facilitator.chains.${chain} has no rpc_url — on-chain settlement confirmation on /settle errors is disabled for this chain`
          );
        }
      }
    }
  }

  if (config.auth) {
    if (!config.payment) {
      errors.push("[auth] block requires [payment] to also be configured");
    }
    const threshold = parseFloat(config.auth.price_threshold);
    const hasAboveThreshold =
      parseFloat(config.pricing.default.amount) >= threshold ||
      Object.values(config.pricing.sections ?? {}).some(
        (s) => parseFloat(s.amount) >= threshold
      );
    if (!hasAboveThreshold) {
      errors.push(
        `auth.price_threshold is ${config.auth.price_threshold} but no section is priced at or above that amount`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `mdf-server: configuration errors:\n${errors.map((e) => `  • ${e}`).join("\n")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export function loadConfig(configPath = "./mdf.yaml"): LoadedConfig {
  const absPath = isAbsolute(configPath)
    ? configPath
    : resolve(process.cwd(), configPath);

  if (!existsSync(absPath)) {
    throw new Error(`mdf-server: config file not found: ${absPath}`);
  }

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new Error(`mdf-server: failed to parse YAML: ${(err as Error).message}`);
  }

  const result = MdfConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`mdf-server: invalid configuration:\n${issues}`);
  }

  const config = result.data;

  // Resolve wallet secret
  const walletAddress = resolveSecret(
    "wallet_address",
    "MDF_WALLET",
    config.payment?.wallet
  );

  // Facilitator config is taken verbatim from mdf.yaml. Unlike the previous
  // [oracle] block there is no signer pubkey to resolve — verification is
  // delegated to a standard facilitator's /verify and /settle endpoints.
  const facilitatorConfig: FacilitatorConfig | null = config.facilitator ?? null;

  // Resolve lightning secrets — only if a [lightning] block is present.
  // The schema's api_token/token_secret fields are optional and inert (Vikunja
  // #27): this resolution is the single source of truth, so a placeholder left
  // in mdf.yaml is never read, and a missing file/env secret still refuses to
  // start.
if (config.lightning) {
  const apiToken = resolveSecret("alby_api_token", "MDF_ALBY_TOKEN", undefined);
  if (!apiToken) {
    throw new Error(
      "mdf-server: lightning block configured but alby_api_token secret not found — " +
      "mount at /run/secrets/alby_api_token or set MDF_ALBY_TOKEN env var"
    );
  }
  const tokenSecret = resolveSecret("lightning_token_secret", "MDF_LIGHTNING_SECRET", undefined);
  if (!tokenSecret) {
    throw new Error(
      "mdf-server: lightning block configured but lightning_token_secret not found — " +
      "mount at /run/secrets/lightning_token_secret or set MDF_LIGHTNING_SECRET env var"
    );
  }
  config.lightning.api_token = apiToken;
  config.lightning.token_secret = tokenSecret;
}
  
  // Startup constraint validation
  validateStartupConstraints(config, walletAddress, facilitatorConfig);

  // Resolve content directory to absolute path
  const contentDir = isAbsolute(config.content.dir)
    ? config.content.dir
    : resolve(process.cwd(), config.content.dir);

  if (!existsSync(contentDir)) {
    throw new Error(
      `mdf-server: content directory not found: ${contentDir}`
    );
  }

  const mdfJsonObj = buildMdfJson(config, walletAddress);
  const mdfJson = JSON.stringify(mdfJsonObj, null, 2);

  return { config, mdfJson, contentDir, walletAddress, facilitatorConfig };
}
