import { createHash, createHmac, timingSafeEqual, randomBytes } from "crypto";
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

/**
 * Parsed L402 credential extracted from Authorization header.
 * Format: "L402 <macaroon>:<preimage>"
 *
 * The macaroon here is an HMAC-bound token (not a full libmacaroon implementation).
 * It encodes {payment_hash, path_scope, expiry} and is signed with the server's
 * lightning.token_secret. The preimage is the Lightning payment preimage that,
 * when SHA-256 hashed, must equal the payment_hash encoded in the macaroon.
 */
export interface L402Credential {
  /** Raw Authorization header value */
  raw: string;
  /** Base64url-encoded macaroon token */
  macaroon: string;
  /** Hex-encoded Lightning payment preimage */
  preimage: string;
}

/**
 * Decoded macaroon payload. This is the internal structure — never exposed
 * to callers directly. Verified by HMAC before use.
 */
interface MacaroonPayload {
  /** SHA-256 hash of the payment preimage (hex) */
  payment_hash: string;
  /** Path prefix this token is scoped to e.g. "/premium" */
  path_scope: string;
  /** Unix timestamp (seconds) after which the token is invalid */
  expiry: number;
  /** Random nonce to prevent payload collision */
  nonce: string;
}

export type VerificationStatus =
  | "approved"      // proof accepted — serve content
  | "rejected"      // proof invalid — return 402
  | "stub_approved" // stub mode — structural validation only, no real verification
  | "no_proof";     // no payment header present

export interface VerificationResult {
  status: VerificationStatus;
  proof: PaymentProof | null;
  l402Credential: L402Credential | null;
  reason: string;
  /** If true, this path should trigger auth token issuance rather than direct content */
  requiresToken: boolean;
  /** Rail that processed this result */
  rail: "x402" | "l402" | "none";
}

// ---------------------------------------------------------------------------
// Alby Hub API client
// ---------------------------------------------------------------------------

/**
 * Alby Hub invoice creation response (subset of fields we use).
 *
 * NOTE: The Alby Hub internal REST API is marked "Experimental" in the UI
 * and may change or be removed. This client is isolated here so that if
 * the API changes, or if we migrate to NWC (Nostr Wallet Connect), only
 * this module needs updating.
 *
 * API base: http://<host>:8021/api
 * Auth: Authorization: Bearer <token>
 */
interface AlbyInvoice {
  paymentHash: string;     // Alby Hub uses camelCase
  invoice: string;         // BOLT11 invoice string (not payment_request)
  settledAt: string | null;
}

interface AlbyInvoiceStatus {
  paymentHash: string;     // Alby Hub uses camelCase
  state: string;           // "pending" | "settled" | "expired"
  preimage: string | null; // hex preimage, present when settled
}

/**
 * Create a Lightning invoice via Alby Hub.
 * Amount is in satoshis. Description is shown in the payer's wallet.
 */
async function albyCreateInvoice(
  amountSats: number,
  description: string,
  expirySeconds: number,
  apiUrl: string,
  apiToken: string
): Promise<AlbyInvoice> {
  const res = await fetch(`${apiUrl}/invoices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      amount: amountSats,
      description,
      expiry: expirySeconds,
    }),
    // Hard timeout — don't let a slow Alby Hub stall request handling
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Alby Hub invoice creation failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<AlbyInvoice>;
}

/**
 * Look up a Lightning invoice by payment hash via Alby Hub.
 * Returns settlement status and preimage if settled.
 *
 * NOTE: Alby Hub's /api/invoices/<hash> endpoint returns HTML (not JSON).
 * We use /api/transactions instead and filter by paymentHash client-side.
 * Fetches up to 50 recent transactions — sufficient for demo/reference use.
 * A production implementation should use a more targeted lookup if Alby Hub
 * exposes one in a future API version, or migrate to NWC for stability.
 */
async function albyGetInvoice(
  paymentHash: string,
  apiUrl: string,
  apiToken: string
): Promise<AlbyInvoiceStatus> {
  const res = await fetch(`${apiUrl}/transactions?limit=50&offset=0`, {
    headers: {
      "Authorization": `Bearer ${apiToken}`,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Alby Hub transaction lookup failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { transactions: AlbyInvoiceStatus[] };
  const match = data.transactions.find(
    (t) => t.paymentHash.toLowerCase() === paymentHash.toLowerCase()
  );

  if (!match) {
    // Invoice not found in recent transactions — treat as unsettled
    return { paymentHash, state: "pending", preimage: null };
  }

  return match;
}

// ---------------------------------------------------------------------------
// Macaroon (HMAC-bound token) implementation
// ---------------------------------------------------------------------------

/**
 * Create a signed macaroon token encoding the payment hash, path scope, and expiry.
 *
 * Format: base64url(<json_payload>).<base64url(<hmac_signature>)>
 *
 * The HMAC uses SHA-256 with the server's configured token_secret.
 * This is not a libmacaroon-compatible format — it is a simpler construction
 * appropriate for a reference implementation. A production deployment may wish
 * to adopt the full macaroon specification for delegation and attenuation support.
 */
function createMacaroon(
  paymentHash: string,
  pathScope: string,
  ttlSeconds: number,
  tokenSecret: string
): string {
  const payload: MacaroonPayload = {
    payment_hash: paymentHash,
    path_scope: pathScope,
    expiry: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: randomBytes(8).toString("hex"),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", tokenSecret).update(payloadB64).digest("base64url");

  return `${payloadB64}.${sig}`;
}

/**
 * Verify and decode a macaroon token.
 * Returns the payload if valid, throws if tampered or expired.
 */
function verifyMacaroon(
  macaroon: string,
  tokenSecret: string
): MacaroonPayload {
  const dotIdx = macaroon.lastIndexOf(".");
  if (dotIdx === -1) throw new Error("malformed macaroon: missing signature separator");

  const payloadB64 = macaroon.slice(0, dotIdx);
  const sigB64 = macaroon.slice(dotIdx + 1);

  // Recompute expected signature
  const expectedSig = createHmac("sha256", tokenSecret).update(payloadB64).digest("base64url");

  // Timing-safe comparison
  const sigBuf = Buffer.from(sigB64);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("macaroon signature invalid");
  }

  let payload: MacaroonPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("macaroon payload not valid JSON");
  }

  if (Math.floor(Date.now() / 1000) > payload.expiry) {
    throw new Error("macaroon expired");
  }

  return payload;
}

// ---------------------------------------------------------------------------
// L402 credential parsing
// ---------------------------------------------------------------------------

/**
 * Parse the Authorization header for an L402 credential.
 * Expected format: "L402 <macaroon>:<preimage>"
 */
function parseL402Header(raw: string): L402Credential | null {
  const stripped = raw.trim();
  if (!stripped.toLowerCase().startsWith("l402 ")) return null;

  const rest = stripped.slice(5).trim();
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx === -1) return null;

  const macaroon = rest.slice(0, colonIdx).trim();
  const preimage = rest.slice(colonIdx + 1).trim();

  if (!macaroon || !preimage) return null;

  // Basic hex validation on preimage (must be 64 hex chars — 32 bytes)
  if (!/^[0-9a-fA-F]{64}$/.test(preimage)) return null;

  return { raw, macaroon, preimage };
}

// ---------------------------------------------------------------------------
// x402 header parsing
// ---------------------------------------------------------------------------

/**
 * Parse the X-Payment header value.
 *
 * x402 uses a structured header. The draft spec allows both JSON and
 * a key=value format. We attempt JSON first, fall back to key=value pairs.
 */
function parsePaymentHeader(raw: string): PaymentProof {
  const proof: PaymentProof = { raw, extra: {} };

  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      proof.chain    = typeof parsed.chain    === "string" ? parsed.chain    : undefined;
      proof.currency = typeof parsed.currency === "string" ? parsed.currency : undefined;
      proof.amount   = typeof parsed.amount   === "string" ? parsed.amount   : undefined;
      proof.txHash   = typeof parsed.txHash   === "string" ? parsed.txHash   : undefined;
      proof.from     = typeof parsed.from     === "string" ? parsed.from     : undefined;
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

  for (const segment of raw.split(/[;&]/)) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    const key   = segment.slice(0, eqIdx).trim().toLowerCase();
    const value = segment.slice(eqIdx + 1).trim();
    switch (key) {
      case "chain":    proof.chain    = value; break;
      case "currency": proof.currency = value; break;
      case "amount":   proof.amount   = value; break;
      case "txhash":   proof.txHash   = value; break;
      case "from":     proof.from     = value; break;
      default:         proof.extra[key] = value;
    }
  }

  return proof;
}

// ---------------------------------------------------------------------------
// Amount / chain / currency helpers
// ---------------------------------------------------------------------------

function amountSufficient(declared: string | undefined, required: string): boolean {
  if (!declared) return false;
  const d = parseFloat(declared);
  const r = parseFloat(required);
  if (isNaN(d) || isNaN(r)) return false;
  return d >= r;
}

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
// Price / token helpers
// ---------------------------------------------------------------------------

function requiredPriceEntry(
  urlPath: string,
  config: LoadedConfig["config"]
): { amount: string; currency: string | null | undefined; chain: string | null | undefined } {
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
      bestLength  = pattern.length;
    }
  }

  return bestPattern ? sections[bestPattern] : config.pricing.default;
}

function requiredPrice(urlPath: string, config: LoadedConfig["config"]): string {
  return requiredPriceEntry(urlPath, config).amount;
}

function pathRequiresToken(urlPath: string, config: LoadedConfig["config"]): boolean {
  if (!config.auth) return false;
  const threshold = parseFloat(config.auth.price_threshold);
  const price     = parseFloat(requiredPrice(urlPath, config));
  return price >= threshold;
}

/**
 * Derive the path scope prefix from a full path.
 * "/premium/deep-dive" → "/premium"
 * "/private/internals" → "/private"
 */
function pathScope(urlPath: string): string {
  const parts = urlPath.split("/").filter(Boolean);
  return parts.length > 0 ? `/${parts[0]}` : "/";
}

/**
 * Convert a USD amount string to satoshis using a rough fixed rate.
 *
 * TODO: Replace with a live rate feed (e.g. Coingecko or a self-hosted price
 * oracle) once the implementation is production-ready. The fixed rate is
 * acceptable for the reference implementation and demo purposes.
 *
 * At time of writing: 1 BTC ≈ 100,000 USD → 1 USD ≈ 1,000 sats
 */
function usdToSats(usdAmount: string): number {
  const usd = parseFloat(usdAmount);
  if (isNaN(usd)) return 0;
  // 1 sat = $0.001 USD at $100k/BTC
  // Math.max(1, ...) enforces a 1 sat floor — for the micropayment tier
  // (amount: "0.00000001" BTC) this arithmetic lands on exactly 1 sat,
  // which is correct. Replace the fixed rate with a live feed for production.
  return Math.max(1, Math.ceil(usd * 1000));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logX402(urlPath: string, proof: PaymentProof, result: VerificationStatus) {
  console.log(`[mdf:payment:x402] ${JSON.stringify({
    ts: new Date().toISOString(),
    path: urlPath,
    status: result,
    chain: proof.chain,
    currency: proof.currency,
    amount: proof.amount,
    txHash: proof.txHash,
    from: proof.from ? `${proof.from.slice(0, 6)}…${proof.from.slice(-4)}` : undefined,
  })}`);
}

function logL402(urlPath: string, paymentHash: string, result: VerificationStatus, detail?: string) {
  console.log(`[mdf:payment:l402] ${JSON.stringify({
    ts: new Date().toISOString(),
    path: urlPath,
    status: result,
    payment_hash: paymentHash,
    detail,
  })}`);
}

// ---------------------------------------------------------------------------
// L402 invoice creation (called when building the 402 response)
// ---------------------------------------------------------------------------

/**
 * Create a Lightning invoice and a macaroon bound to its payment hash.
 * Returns the WWW-Authenticate header value for the 402 response.
 *
 * Called from build402Response when the request path has a lightning price
 * and the config has lightning credentials available.
 */
export async function createL402Challenge(
  urlPath: string,
  loaded: LoadedConfig
): Promise<{ wwwAuthenticate: string; paymentHash: string } | null> {
  const { config } = loaded;

  if (!config.lightning) return null;

  const { api_url, api_token, invoice_expiry_seconds, token_secret } = config.lightning;
  const required = requiredPrice(urlPath, config);
  const amountSats = usdToSats(required);
  const expiry = invoice_expiry_seconds ?? 300;

  let invoice: AlbyInvoice;
  try {
    invoice = await albyCreateInvoice(
      amountSats,
      `MDF access: ${urlPath}`,
      expiry,
      api_url,
      api_token
    );
  } catch (err) {
    console.error(`[mdf:payment:l402] Failed to create invoice: ${(err as Error).message}`);
    return null;
  }

  const macaroon = createMacaroon(
    invoice.paymentHash,
    pathScope(urlPath),
    expiry,
    token_secret
  );

  const wwwAuthenticate =
    `L402 macaroon="${macaroon}", invoice="${invoice.invoice}"`;

  logL402(urlPath, invoice.paymentHash, "no_proof", "invoice issued");

  return { wwwAuthenticate, paymentHash: invoice.payment_hash };
}

// ---------------------------------------------------------------------------
// L402 proof verification
// ---------------------------------------------------------------------------

/**
 * Verify an L402 credential (macaroon + preimage) for a given path.
 *
 * Verification steps:
 *   1. Parse the Authorization header — must be "L402 <macaroon>:<preimage>"
 *   2. Verify HMAC signature on the macaroon (timing-safe)
 *   3. Check macaroon expiry
 *   4. Check path scope — the macaroon must be scoped to a prefix of urlPath
 *   5. Hash the preimage with SHA-256 — must equal the payment_hash in the macaroon
 *   6. Confirm invoice settlement with Alby Hub (the authoritative check)
 *
 * Steps 2–5 are local and cheap. Step 6 is the network call to Alby Hub.
 * We do local checks first to avoid unnecessary API calls on malformed tokens.
 */
export async function verifyL402(
  urlPath: string,
  authHeader: string,
  loaded: LoadedConfig
): Promise<VerificationResult> {
  const { config } = loaded;
  const requiresToken = pathRequiresToken(urlPath, config);

  const credential = parseL402Header(authHeader);
  if (!credential) {
    return {
      status: "rejected",
      proof: null,
      l402Credential: null,
      reason: "malformed L402 Authorization header",
      requiresToken,
      rail: "l402",
    };
  }

  if (!config.lightning) {
    // Lightning not configured — fall back to stub_approved so the demo
    // still functions without Alby Hub credentials
    logL402(urlPath, "(unknown)", "stub_approved", "lightning not configured");
    return {
      status: "stub_approved",
      proof: null,
      l402Credential: credential,
      reason: "stub mode: lightning not configured, L402 structural check only",
      requiresToken,
      rail: "l402",
    };
  }

  const { api_url, api_token, token_secret } = config.lightning;

  // Step 2+3: Verify and decode macaroon
  let payload: MacaroonPayload;
  try {
    payload = verifyMacaroon(credential.macaroon, token_secret);
  } catch (err) {
    logL402(urlPath, "(invalid)", "rejected", (err as Error).message);
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: `macaroon invalid: ${(err as Error).message}`,
      requiresToken,
      rail: "l402",
    };
  }

  // Step 4: Path scope check
  if (!urlPath.startsWith(payload.path_scope)) {
    logL402(urlPath, payload.payment_hash, "rejected", `scope mismatch: ${payload.path_scope}`);
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: `macaroon scoped to '${payload.path_scope}', not valid for '${urlPath}'`,
      requiresToken,
      rail: "l402",
    };
  }

  // Step 5: Preimage hash check
  const preimageHash = createHash("sha256")
    .update(Buffer.from(credential.preimage, "hex"))
    .digest("hex");

  const expectedHash = Buffer.from(payload.payment_hash, "hex");
  const actualHash   = Buffer.from(preimageHash, "hex");

  if (
    expectedHash.length !== actualHash.length ||
    !timingSafeEqual(expectedHash, actualHash)
  ) {
    logL402(urlPath, payload.payment_hash, "rejected", "preimage hash mismatch");
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: "preimage does not hash to declared payment_hash",
      requiresToken,
      rail: "l402",
    };
  }

  // Step 6: Confirm settlement with Alby Hub
  let invoiceStatus: AlbyInvoiceStatus;
  try {
    invoiceStatus = await albyGetInvoice(payload.payment_hash, api_url, api_token);
  } catch (err) {
    // Alby Hub unreachable — log and reject rather than fail open
    console.error(`[mdf:payment:l402] Alby Hub lookup failed: ${(err as Error).message}`);
    logL402(urlPath, payload.payment_hash, "rejected", "alby hub unreachable");
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: "could not verify invoice settlement: Alby Hub unreachable",
      requiresToken,
      rail: "l402",
    };
  }

  if (invoiceStatus.state !== "settled") {
    logL402(urlPath, payload.payment_hash, "rejected", "invoice not settled");
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: "Lightning invoice not yet settled",
      requiresToken,
      rail: "l402",
    };
  }

  // Verify the preimage Alby Hub recorded matches what the agent submitted
  // (belt-and-braces: the hash check above already confirms this, but an
  // explicit match against the settled record is worth having in the log)
  if (invoiceStatus.preimage && invoiceStatus.preimage.toLowerCase() !== credential.preimage.toLowerCase()) {
    logL402(urlPath, payload.payment_hash, "rejected", "preimage mismatch vs alby record");
    return {
      status: "rejected",
      proof: null,
      l402Credential: credential,
      reason: "submitted preimage does not match settled invoice record",
      requiresToken,
      rail: "l402",
    };
  }

  logL402(urlPath, payload.payment_hash, "approved");
  return {
    status: "approved",
    proof: null,
    l402Credential: credential,
    reason: "L402: Lightning invoice settled and preimage verified",
    requiresToken,
    rail: "l402",
  };
}

// ---------------------------------------------------------------------------
// Main verifier — x402 path (unchanged logic, updated return shape)
// ---------------------------------------------------------------------------

/**
 * Verify an x402 payment proof for a given request.
 *
 * STUB BEHAVIOUR: On-chain receipt verification not yet implemented.
 * Real x402 verification slots in by replacing the stub_approved return
 * with an on-chain receipt check against Base RPC. See spec repo issue #3.
 */
export function verifyPayment(
  urlPath: string,
  paymentHeader: string | null | undefined,
  loaded: LoadedConfig
): VerificationResult {
  const { config } = loaded;
  const requiresToken = pathRequiresToken(urlPath, config);
  const required      = requiredPrice(urlPath, config);

  // Free content
  if (parseFloat(required) === 0) {
    return {
      status: "approved",
      proof: null,
      l402Credential: null,
      reason: "free access",
      requiresToken: false,
      rail: "none",
    };
  }

  // No proof supplied
  if (!paymentHeader || paymentHeader.trim().length === 0) {
    return {
      status: "no_proof",
      proof: null,
      l402Credential: null,
      reason: `payment required: ${required} ${config.pricing.default.currency ?? ""}`.trim(),
      requiresToken,
      rail: "none",
    };
  }

  const proof = parsePaymentHeader(paymentHeader.trim());

  if (!chainAccepted(proof.chain, config)) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: `chain '${proof.chain ?? "unspecified"}' not accepted`,
      requiresToken,
      rail: "x402",
    };
  }

  if (!currencyAccepted(proof.currency, config)) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: `currency '${proof.currency ?? "unspecified"}' not accepted`,
      requiresToken,
      rail: "x402",
    };
  }

  if (!amountSufficient(proof.amount, required)) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: `amount ${proof.amount ?? "unspecified"} insufficient for required ${required}`,
      requiresToken,
      rail: "x402",
    };
  }

  // ── STUB: would perform on-chain txHash verification here ──
  logX402(urlPath, proof, "stub_approved");
  return {
    status: "stub_approved",
    proof,
    l402Credential: null,
    reason: "stub mode: structural validation passed, on-chain verification not yet implemented",
    requiresToken,
    rail: "x402",
  };
}

// ---------------------------------------------------------------------------
// 402 response builder
// ---------------------------------------------------------------------------

/**
 * Build the HTTP 402 response body and headers.
 *
 * For L402 paths: also generates a Lightning invoice and returns the
 * WWW-Authenticate header. This is async because invoice creation requires
 * a call to Alby Hub.
 *
 * For x402 paths: synchronous, same behaviour as before.
 */
export async function build402Response(
  urlPath: string,
  result: VerificationResult,
  loaded: LoadedConfig
): Promise<{ status: 402; headers: Record<string, string>; body: string }> {
  const { config } = loaded;
  const price = requiredPrice(urlPath, config);

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-MDF-Version": "1",
  };

  // Attempt L402 challenge if lightning is configured
  let l402Challenge: { wwwAuthenticate: string; paymentHash: string } | null = null;
  if (config.lightning) {
    l402Challenge = await createL402Challenge(urlPath, loaded);
    if (l402Challenge) {
      headers["WWW-Authenticate"] = l402Challenge.wwwAuthenticate;
    }
  }

  const priceEntry = requiredPriceEntry(urlPath, config);

  const body = JSON.stringify({
    error: "Payment Required",
    reason: result.reason,
    payment: {
      endpoint: config.payment?.endpoint
        ? resolveEndpoint(config.payment.endpoint, config.site.url)
        : null,
      amount: priceEntry.amount,
      currency: priceEntry.currency ?? config.pricing.default.currency,
      chain: priceEntry.chain ?? null,
      accepted_chains: config.payment?.accepted_chains ?? [],
      accepted_currencies: config.payment?.accepted_currencies ?? [],
      ...(l402Challenge ? { lightning_invoice: headers["WWW-Authenticate"] } : {}),
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

  return { status: 402, headers, body };
}

function resolveEndpoint(endpoint: string, siteUrl: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  return `${siteUrl.replace(/\/$/, "")}${endpoint}`;
}
