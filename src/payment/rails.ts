/**
 * Rails: the 0.3.x pricing model, resolved for a request.
 *
 * A price entry is `{ rails: [...], access?: "per_fetch" | "token" }` — one
 * entry per payment rail, each with its own atomic amount in that rail's own
 * units. There is no exchange rate anywhere (decision 12/49): the publisher
 * sets each rail's price. `/mdf.json` and the 402's `accepts[]` are rendered
 * from these same rails, which is what makes the one-to-one rule hold by
 * construction rather than by coincidence.
 *
 * This module is deliberately pure: it decides what a path's rails *are* and
 * how a rail becomes an x402 v2 `PaymentRequirements` object. Whether a rail
 * can actually be offered right now (breaker open, mint budget empty, invoice
 * node down) is a runtime question answered by the caller, which then drops
 * the rail from `accepts[]` — the spec's "minus any rail that is degraded".
 */

import { lookupAsset, requireAsset, type AssetEntry } from "../config/assets.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One rail as configured. Mirrors the spec's `pricing.*.rails[]` entry. */
export interface RailConfig {
  scheme: string;
  /** CAIP-2 identifier. `mdf.json` always uses CAIP-2. */
  network: string;
  /** Token contract on eip155; `BTC` on lnbtc. */
  asset: string;
  /** Atomic integer amount, as a string (micro-USDC, millisatoshis, …). */
  amount: string;
}

export interface PriceEntryConfig {
  rails: RailConfig[];
  access?: "per_fetch" | "token";
}

export interface PricingConfig {
  default: PriceEntryConfig;
  sections?: Record<string, PriceEntryConfig>;
}

/** An x402 v2 PaymentRequirements object, as it appears in `accepts[]`. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** Context a requirement needs but the rails themselves do not carry. */
export interface RequirementContext {
  /** Wallet address for eip155 rails (from the wallet secret). */
  eip155PayTo: string | null;
  /** Receiver node pubkey for lnbtc rails, compressed secp256k1 hex. */
  lnbtcPayTo: string | null;
  /** Offer window; on lnbtc this is also the BOLT11 expiry. */
  maxTimeoutSeconds: number;
}

export const LNBTC_MAINNET = "lnbtc:000000000019d6689c085ae165831e93";

/** Rails this build can settle. Anything else is a config error. */
export const SUPPORTED_NETWORKS = new Set<string>([
  "eip155:1",
  "eip155:8453",
  "eip155:84532",
  LNBTC_MAINNET,
]);

export function isLnbtcNetwork(network: string): boolean {
  return network.startsWith("lnbtc:");
}

export function isEip155Network(network: string): boolean {
  return network.startsWith("eip155:");
}

/**
 * The payment layer's view of the config's pricing block.
 *
 * Structurally typed and located here rather than in the loader so that
 * `content/handler.ts` can resolve a price entry without importing the loader,
 * which imports the payment layer — a cycle through two value imports that
 * ESM would tolerate but no one should have to reason about.
 */
export function pricingView(config: {
  pricing: { default: PriceEntryConfig; sections?: Record<string, PriceEntryConfig> };
}): PricingConfig {
  return {
    default: config.pricing.default,
    ...(config.pricing.sections ? { sections: config.pricing.sections } : {}),
  };
}

// ---------------------------------------------------------------------------
// Path → price entry
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLE§")
    .replace(/\*/g, "[^/]+")
    .replace(/§DOUBLE§/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * The price entry governing `urlPath`: the most specific matching section, or
 * `pricing.default`. Longest pattern wins, matching the 0.2.x behaviour so a
 * more specific override always beats a broader one.
 */
export function resolvePriceEntry(
  urlPath: string,
  pricing: PricingConfig
): { pattern: string | null; entry: PriceEntryConfig } {
  let best: { pattern: string | null; entry: PriceEntryConfig; length: number } = {
    pattern: null,
    entry: pricing.default,
    length: -1,
  };
  for (const [pattern, entry] of Object.entries(pricing.sections ?? {})) {
    if (!globToRegex(pattern).test(urlPath)) continue;
    if (pattern.length > best.length) best = { pattern, entry, length: pattern.length };
  }
  return { pattern: best.pattern, entry: best.entry };
}

/** True when the path's entry has no rails at all (free content). */
export function isFreeEntry(entry: PriceEntryConfig): boolean {
  return entry.rails.length === 0;
}

/** True when the entry issues a bearer token instead of serving per fetch. */
export function isTokenEntry(entry: PriceEntryConfig): boolean {
  return entry.access === "token";
}

/**
 * The section prefix a token is scoped to: the first path segment, as 0.2.x
 * did (`/private/internals` → `/private/`).
 */
export function tokenScopeForPath(urlPath: string): string {
  const parts = urlPath.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts[0]}/`;
}

// ---------------------------------------------------------------------------
// Rail validation (startup)
// ---------------------------------------------------------------------------

/**
 * Validate one configured rail against the rules this build can enforce, and
 * return the asset-table entry for an eip155 rail. Called by the loader, so an
 * unservable rail refuses to start rather than failing at request time.
 */
export function validateRail(
  rail: RailConfig,
  label: string
): { ok: true; asset: AssetEntry | null } | { ok: false; reason: string } {
  if (!SUPPORTED_NETWORKS.has(rail.network)) {
    return {
      ok: false,
      reason:
        `${label}: network '${rail.network}' is not one this build can settle ` +
        `(supported: ${[...SUPPORTED_NETWORKS].join(", ")})`,
    };
  }

  if (rail.scheme !== "exact") {
    return {
      ok: false,
      reason: `${label}: only the 'exact' scheme is implemented here, got '${rail.scheme}'`,
    };
  }

  if (!/^[1-9][0-9]*$/.test(rail.amount)) {
    return {
      ok: false,
      reason:
        `${label}: amount '${rail.amount}' must be a positive atomic integer string ` +
        `(no decimal point, sign or unit)`,
    };
  }

  if (isEip155Network(rail.network)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(rail.asset)) {
      return { ok: false, reason: `${label}: asset must be a 0x… EVM token address` };
    }
    const lookup = requireAsset(rail.network, rail.asset);
    if (!lookup.ok) return { ok: false, reason: `${label}: ${lookup.reason}` };
    return { ok: true, asset: lookup.entry };
  }

  // lnbtc
  if (!isLnbtcNetwork(rail.network)) {
    return { ok: false, reason: `${label}: unsupported network namespace` };
  }
  if (rail.asset !== "BTC") {
    return { ok: false, reason: `${label}: an lnbtc rail must use asset "BTC"` };
  }
  const msat = Number(rail.amount);
  if (!Number.isSafeInteger(msat) || msat < 1000) {
    return {
      ok: false,
      reason:
        `${label}: amount '${rail.amount}' msat is below the receiver's 1-sat floor ` +
        `(the invoice backend rejects anything under 1000 msat)`,
    };
  }
  if (msat % 1000 !== 0) {
    return {
      ok: false,
      reason:
        `${label}: amount '${rail.amount}' msat is not a whole number of satoshis — ` +
        `the invoice backend cannot mint a sub-satoshi invoice`,
    };
  }
  return { ok: true, asset: null };
}

// ---------------------------------------------------------------------------
// Rail → PaymentRequirements
// ---------------------------------------------------------------------------

/**
 * Build the `accepts[]` entry for an eip155 rail.
 *
 * `extra.name`/`extra.version` come from the vendored table, never from config;
 * `assetTransferMethod` is stated explicitly (`eip3009` is the scheme default,
 * but saying it removes any doubt for a client selecting a transfer method).
 */
export function buildEip155Requirement(
  rail: RailConfig,
  ctx: RequirementContext
): { ok: true; requirement: PaymentRequirement } | { ok: false; reason: string } {
  const entry = lookupAsset(rail.network, rail.asset);
  if (!entry) {
    return { ok: false, reason: `asset ${rail.asset} is not in the table for ${rail.network}` };
  }
  if (!ctx.eip155PayTo) {
    return { ok: false, reason: "no wallet address resolved for the eip155 rail" };
  }
  return {
    ok: true,
    requirement: {
      scheme: "exact",
      network: rail.network,
      amount: rail.amount,
      asset: entry.asset,
      payTo: ctx.eip155PayTo,
      maxTimeoutSeconds: ctx.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: "eip3009",
        name: entry.name,
        version: entry.version,
      },
    },
  };
}

/**
 * The lnbtc rail's static shape. The `extra` members that depend on the actual
 * request and a freshly minted invoice (`invoice`, `requestHash`, and the
 * binding params) are added by the lnbtc module; this function refuses to
 * produce a requirement without them, so a half-built lnbtc offer can never be
 * emitted.
 */
export function buildLnbtcRequirement(
  rail: RailConfig,
  ctx: RequirementContext,
  dynamic: {
    invoice: string;
    requestHash: string;
    requestBindingParams: Record<string, unknown>;
  }
): { ok: true; requirement: PaymentRequirement } | { ok: false; reason: string } {
  if (!ctx.lnbtcPayTo) {
    return { ok: false, reason: "no receiver node pubkey resolved for the lnbtc rail" };
  }
  if (!/^(02|03)[0-9a-f]{64}$/.test(ctx.lnbtcPayTo)) {
    return { ok: false, reason: "lnbtc payTo is not a compressed secp256k1 pubkey" };
  }
  if (!dynamic.invoice || !dynamic.requestHash) {
    return { ok: false, reason: "lnbtc requirement needs an invoice and a request hash" };
  }
  return {
    ok: true,
    requirement: {
      scheme: "exact",
      network: rail.network,
      amount: rail.amount,
      asset: "BTC",
      payTo: ctx.lnbtcPayTo,
      maxTimeoutSeconds: ctx.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: "bolt11",
        paymentFlow: "upfront",
        invoice: dynamic.invoice,
        requestHash: dynamic.requestHash,
        requestBindingProfile: "http:1",
        requestBindingParams: dynamic.requestBindingParams,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

/** Atomic → human, per rail unit. */
function humanAmount(amount: string, decimals: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  const scale = 10 ** decimals;
  const value = n / scale;
  // Trim trailing zeros without exponent notation.
  return String(Number(value.toFixed(decimals)));
}

/**
 * `extensions.mdf.info.price_summary`: one clause per *offered* rail, each
 * carrying its raw atomic amount verbatim.
 *
 * The raw amount is deliberate. A human-only summary ("0.02 USDC or 20 sats")
 * is easy to read but the MDF validator's `checkPriceSummary` requires the
 * summary to state the amount of every rail, and the atomic value is the one
 * that cannot drift or be mis-scaled.
 */
export function priceSummary(requirements: PaymentRequirement[]): string {
  const clauses = requirements.map((r) => {
    if (isLnbtcNetwork(r.network)) {
      const sats = humanAmount(r.amount, 3);
      return `${r.amount} msat (${sats} sat) on ${r.network}`;
    }
    const entry = lookupAsset(r.network, r.asset);
    const decimals = entry?.decimals ?? 6;
    const symbol = entry?.symbol ?? "tokens";
    return `${r.amount} (${humanAmount(r.amount, decimals)} ${symbol}) on ${r.network}`;
  });
  if (clauses.length === 0) return "no rails available";
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(", ")} or ${clauses[clauses.length - 1]}`;
}

/** Short label for logs and /health; never includes a payee or an invoice. */
export function railLabel(requirement: PaymentRequirement): string {
  return `${requirement.scheme}/${requirement.network}`;
}
