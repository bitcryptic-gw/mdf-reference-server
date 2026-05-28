import { timingSafeEqual, createHash } from "crypto";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed x402 payment proof extracted from request headers.
 * Structure follows the x402 draft spec — fields are advisory at stub stage.
 */
export interface PaymentProof {
  /** Raw X-Payment header value */
  raw: string;
  /** Chain identifier e.g. "base", "ethereum" */
  chain?: string;
  /** Currency symbol e.g. "USDC" */
  currency?: string;
  /** Payment amount as decimal string */
  amount?: string;
  /** Transaction hash or payment identifier */
  txHash?: string;
  /** Paying wallet address */
  from?: string;
  /** Any additional fields present in the proof */
  extra: Record<string, string>;
}

export type VerificationStatus =
  | "approved"      // proof accepted — serve content
  | "rejected"      // proof invalid — return 402
  | "stub_approved" // stub mode — would require real verification in production
  | "no_proof";     // no payment header present

export interface VerificationResult {
  status: VerificationStatus;
  proof: PaymentProof | null;
  reason: string;
  /** If true, this path should trigger auth token issuance rather than direct content */
  requiresToken: boolean;
}

// ---------------------------------------------------------------------------
// x402 header parsing
// ---------------------------------------------------------------------------

/**
 * Parse the X-Payment header value.
 *
 * x402 uses a structured header. The draft spec allows both JSON and
 * a key=value format. We attempt JSON first, fall back to key=value pairs.
 *
 * Example JSON form:
 *   {"chain":"base","currency":"USDC","amount":"1.0000","txHash":"0x...","from":"0x..."}
 *
 * Example KV form:
 *   chain=base;currency=USDC;amount=1.0000;txHash=0x...
 */
function parsePaymentHeader(raw: string): PaymentProof {
  const proof: PaymentProof = { raw, extra: {} };

  // Attempt JSON parse
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      proof.chain = typeof parsed.chain === "string" ? parsed.chain : undefined;
      proof.currency = typeof parsed.currency === "string" ? parsed.currency : undefined;
      proof.amount = typeof parsed.amount === "string" ? parsed.amount : undefined;
      proof.txHash = typeof parsed.txHash === "string" ? parsed.txHash : undefined;
      proof.from = typeof parsed.from === "string" ? parsed.from : undefined;

      // Capture remaining fields as extra
      for (const [k, v] of Object.entries(parsed)) {
        if (!["chain", "currency", "amount", "txHash", "from"].includes(k)) {
          proof.extra[k] = String(v);
        }
      }
      return proof;
    } catch {
      // Fall through to KV parsing
    }
  }

  // KV parsing: key=value pairs separated by ; or &
  for (const segment of raw.split(/[;&]/)) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    const key = segment.slice(0, eqIdx).trim().toLowerCase();
    const value = segment.slice(eqIdx + 1).trim();

    switch (key) {
      case "chain":    proof.chain = value; break;
      case "currency": proof.currency = value; break;
      case "amount":   proof.amount = value; break;
      case "txhash":   proof.txHash = value; break;
      case "from":     proof.from = value; break;
      default:         proof.extra[key] = value;
    }
  }

  return proof;
}

// ---------------------------------------------------------------------------
// Amount validation
// ---------------------------------------------------------------------------

/**
 * Check whether the declared payment amount meets the required price for this path.
 * Returns true if amount >= required, false otherwise.
 * Both values are treated as decimal strings.
 */
function amountSufficient(declared: string | undefined, required: string): boolean {
  if (!declared) return false;
  const d = parseFloat(declared);
  const r = parseFloat(required);
  if (isNaN(d) || isNaN(r)) return false;
  return d >= r;
}

// ---------------------------------------------------------------------------
// Chain/currency acceptance
// ---------------------------------------------------------------------------

function chainAccepted(chain: string | undefined, config: LoadedConfig["config"]): boolean {
  if (!chain || !config.payment?.accepted_chains) return false;
  return config.payment.accepted_chains
    .map((c) => c.toLowerCase())
    .includes(chain.toLowerCase());
}

function currencyAccepted(currency: string | undefined, config: LoadedConfig["config"]): boolean {
  if (!currency || !config.payment?.accepted_currencies) return false;
  return config.payment.accepted_currencies
    .map((c) => c.toUpperCase())
    .includes(currency.toUpperCase());
}

// ---------------------------------------------------------------------------
// Required price for path
// ---------------------------------------------------------------------------

function requiredPrice(urlPath: string, config: LoadedConfig["config"]): string {
  const sections = config.pricing.sections ?? {};

  function globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§DOUBLE§")
      .replace(/\*/g, "[^/]+")
      .replace(/§DOUBLE§/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  let bestPattern: string | null = null;
  let bestLength = -1;
  for (const pattern of Object.keys(sections)) {
    if (globToRegex(pattern).test(urlPath) && pattern.length > bestLength) {
      bestPattern = pattern;
      bestLength = pattern.length;
    }
  }

  return bestPattern ? sections[bestPattern].amount : config.pricing.default.amount;
}

// ---------------------------------------------------------------------------
// Token requirement check
// ---------------------------------------------------------------------------

function pathRequiresToken(urlPath: string, config: LoadedConfig["config"]): boolean {
  if (!config.auth) return false;
  const threshold = parseFloat(config.auth.price_threshold);
  const price = parseFloat(requiredPrice(urlPath, config));
  return price >= threshold;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logProof(urlPath: string, proof: PaymentProof, result: VerificationStatus) {
  const entry = {
    ts: new Date().toISOString(),
    path: urlPath,
    status: result,
    chain: proof.chain,
    currency: proof.currency,
    amount: proof.amount,
    txHash: proof.txHash,
    from: proof.from ? `${proof.from.slice(0, 6)}…${proof.from.slice(-4)}` : undefined,
  };
  // Single-line JSON — easy to grep and pipe to a log aggregator later
  console.log(`[mdf:payment] ${JSON.stringify(entry)}`);
}

// ---------------------------------------------------------------------------
// Main verifier
// ---------------------------------------------------------------------------

/**
 * Verify a payment proof for a given request.
 *
 * STUB BEHAVIOUR:
 * In stub mode (no real on-chain verification), the verifier:
 *   1. Confirms the X-Payment header is present and parseable
 *   2. Validates chain and currency are in the accepted list
 *   3. Validates the declared amount meets the path's required price
 *   4. Logs the proof for audit
 *   5. Returns stub_approved — clearly flagged as not production-safe
 *
 * Real x402 verification (future) slots in here by replacing the
 * stub_approved return with an on-chain receipt check. The interface
 * and all surrounding logic remain unchanged.
 *
 * @param urlPath       - The request path being paid for
 * @param paymentHeader - Raw X-Payment header value, or null if absent
 * @param loaded        - Loaded server config
 */
export function verifyPayment(
  urlPath: string,
  paymentHeader: string | null | undefined,
  loaded: LoadedConfig
): VerificationResult {
  const { config } = loaded;
  const requiresToken = pathRequiresToken(urlPath, config);
  const required = requiredPrice(urlPath, config);

  // Free content — no payment needed
  if (parseFloat(required) === 0) {
    return {
      status: "approved",
      proof: null,
      reason: "free access",
      requiresToken: false,
    };
  }

  // No proof supplied
  if (!paymentHeader || paymentHeader.trim().length === 0) {
    return {
      status: "no_proof",
      proof: null,
      reason: `payment required: ${required} ${config.pricing.default.currency ?? ""}`.trim(),
      requiresToken,
    };
  }

  // Parse
  const proof = parsePaymentHeader(paymentHeader.trim());

  // Chain check
  if (!chainAccepted(proof.chain, config)) {
    logProof(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      reason: `chain '${proof.chain ?? "unspecified"}' not accepted`,
      requiresToken,
    };
  }

  // Currency check
  if (!currencyAccepted(proof.currency, config)) {
    logProof(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      reason: `currency '${proof.currency ?? "unspecified"}' not accepted`,
      requiresToken,
    };
  }

  // Amount check
  if (!amountSufficient(proof.amount, required)) {
    logProof(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      reason: `amount ${proof.amount ?? "unspecified"} insufficient for required ${required}`,
      requiresToken,
    };
  }

  // ── STUB: would perform on-chain txHash verification here ──
  // Real implementation: await verifyOnChain(proof.txHash, proof.chain, proof.amount, config)
  // For now: log and approve with explicit stub flag
  logProof(urlPath, proof, "stub_approved");

  return {
    status: "stub_approved",
    proof,
    reason: "stub mode: structural validation passed, on-chain verification not yet implemented",
    requiresToken,
  };
}

// ---------------------------------------------------------------------------
// 402 response builder
// ---------------------------------------------------------------------------

/**
 * Build the HTTP 402 response body and headers for a failed or missing payment.
 * Follows x402 draft conventions for the response shape.
 */
export function build402Response(
  urlPath: string,
  result: VerificationResult,
  loaded: LoadedConfig
): { status: 402; headers: Record<string, string>; body: string } {
  const { config } = loaded;
  const price = requiredPrice(urlPath, config);

  const body = JSON.stringify({
    error: "Payment Required",
    reason: result.reason,
    payment: {
      endpoint: config.payment?.endpoint
        ? resolveEndpoint(config.payment.endpoint, config.site.url)
        : null,
      amount: price,
      currency: config.pricing.default.currency,
      accepted_chains: config.payment?.accepted_chains ?? [],
      accepted_currencies: config.payment?.accepted_currencies ?? [],
    },
    ...(result.requiresToken && config.auth
      ? {
          auth: {
            endpoint: resolveEndpoint(config.auth.endpoint, config.site.url),
            token_ttl_seconds: config.auth.token_ttl_seconds,
          },
        }
      : {}),
  }, null, 2);

  return {
    status: 402,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-MDF-Version": "1",
    },
    body,
  };
}

function resolveEndpoint(endpoint: string, siteUrl: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  return `${siteUrl.replace(/\/$/, "")}${endpoint}`;
}
