import { readFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import yaml from "js-yaml";
import { MdfConfigSchema, type MdfConfig } from "./schema.ts";

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

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Enforce startup preconditions that cannot be expressed in the Zod schema alone.
 * Throws with a descriptive message on any violation.
 */
function validateStartupConstraints(
  config: MdfConfig,
  walletAddress: string | null
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

  // Startup constraint validation
  validateStartupConstraints(config, walletAddress);

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

  return { config, mdfJson, contentDir, walletAddress };
}
