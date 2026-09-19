import { createHash, createHmac, timingSafeEqual, randomBytes } from "crypto";
import type { LoadedConfig } from "../config/loader.ts";
import type { FacilitatorConfig, FacilitatorChainConfig } from "../config/schema.ts";
import { htmlSourceBytesForPath } from "../content/handler.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed standard x402 (V1) payment payload, extracted from the X-PAYMENT
 * header. This is the decoded envelope plus the EIP-3009 authorization the
 * facilitator will act on.
 */
export interface PaymentProof {
  /** Raw X-PAYMENT header value (base64) */
  raw: string;
  /** x402 protocol version (1) */
  x402Version: number;
  /** Payment scheme, e.g. "exact" */
  scheme: string;
  /** x402 network name, e.g. "base" or "base-sepolia" */
  network: string;
  /** Signer / payer address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount in atomic token units (decimal string) */
  value: string;
  /** Authorization validity start (unix seconds) */
  validAfter: number;
  /** Authorization validity end (unix seconds) */
  validBefore: number;
  /** 32-byte authorization nonce (0x hex) */
  nonce: string;
  /** EOA / EIP-1271 signature bytes (0x hex) */
  signature: string;
  /** Full decoded PaymentPayload envelope, forwarded verbatim to the facilitator. */
  envelope: Record<string, unknown>;
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
  | "no_proof"      // no payment header present
  | "error";        // upstream dependency failure — not a payment denial

export interface VerificationResult {
  status: VerificationStatus;
  proof: PaymentProof | null;
  l402Credential: L402Credential | null;
  reason: string;
  /** If true, this path should trigger auth token issuance rather than direct content */
  requiresToken: boolean;
  /** Rail that processed this result */
  rail: "x402" | "l402" | "none";
  /** Settlement metadata, present when an x402 payment settled successfully */
  settlement?: { payer: string; transaction: string };
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
 * Parse the standard x402 `X-PAYMENT` header: base64-encoded JSON of a V1
 * `PaymentPayload`. Returns null if malformed or missing required fields.
 *
 * Shape (x402 v1, exact scheme):
 *   {
 *     "x402Version": 1,
 *     "scheme": "exact",
 *     "network": "base-sepolia",
 *     "payload": {
 *       "signature": "0x…",
 *       "authorization": {
 *         "from": "0x…", "to": "0x…", "value": "100000",
 *         "validAfter": "0", "validBefore": "9999999999",
 *         "nonce": "0x…"
 *       }
 *     }
 *   }
 */
function parseX402PaymentHeader(raw: string): PaymentProof | null {
  let decoded: string;
  try {
    const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
    decoded = Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.x402Version !== 1) return null;
  if (typeof parsed.scheme !== "string" || typeof parsed.network !== "string") return null;

  const payload = parsed.payload as Record<string, unknown> | undefined;
  const auth = payload?.authorization as Record<string, unknown> | undefined;
  if (!payload || !auth) return null;

  const signature = typeof payload.signature === "string" ? payload.signature : null;
  const from      = typeof auth.from    === "string" ? auth.from    : null;
  const to        = typeof auth.to      === "string" ? auth.to      : null;
  const value     = typeof auth.value   === "string" ? auth.value   : null;
  const nonce     = typeof auth.nonce   === "string" ? auth.nonce   : null;

  if (!signature || !from || !to || !value || !nonce) return null;
  if (auth.validAfter === undefined || auth.validBefore === undefined) return null;

  const validAfter  = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) return null;

  return {
    raw,
    x402Version: 1,
    scheme: parsed.scheme,
    network: parsed.network,
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    signature,
    envelope: parsed,
  };
}

// ---------------------------------------------------------------------------
// Amount helpers
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable decimal amount (e.g. "1.0000") to atomic token
 * units for a token with `decimals` decimals (e.g. "1000000" for 6 decimals).
 *
 * Rounds up when the amount carries more precision than the token supports, so
 * a price is never under-charged. String/BigInt arithmetic only — no floats.
 */
function toAtomicUnits(amount: string, decimals: number): string {
  const [intPart = "0", fracPartRaw = ""] = amount.split(".");
  const frac = fracPartRaw.replace(/[^0-9]/g, "");
  const intDigits = intPart.replace(/[^0-9]/g, "") || "0";

  if (frac.length <= decimals) {
    return BigInt(intDigits + frac.padEnd(decimals, "0")).toString();
  }

  const keep = frac.slice(0, decimals);
  const rest = frac.slice(decimals);
  let units = BigInt(intDigits + keep);
  if (/[1-9]/.test(rest)) units += 1n; // ceil — never under-charge
  return units.toString();
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
    network: proof.network,
    value: proof.value,
    nonce: proof.nonce ? `${proof.nonce.slice(0, 10)}…` : undefined,
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
// x402 facilitator client
// ---------------------------------------------------------------------------
//
// All x402 verification and settlement is delegated to a standard facilitator's
// /verify and /settle endpoints. One base URL, one HTTP client — no client-side
// failover logic (Caddy fronts the facilitator pool).

export interface FacilitatorChainInfo {
  /** x402 network name for this MDF chain, e.g. "base-sepolia". */
  network: string;
  /** Numeric EVM chain id, e.g. "84532". */
  chainId: string;
  /** ERC-20 asset (token contract) address. */
  asset: string;
  /** Token decimals. */
  decimals: number;
  /** Scheme-specific extra data, passed through opaquely. */
  extra?: Record<string, unknown>;
  /** Optional JSON-RPC URL for independent settlement confirmation. */
  rpcUrl?: string;
}

function facilitatorUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function facilitatorPost(
  config: FacilitatorConfig,
  path: "/verify" | "/settle",
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(facilitatorUrl(config.url, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

interface X402VerifyRequest {
  x402Version: 1;
  paymentPayload: unknown;
  paymentRequirements: Record<string, unknown>;
}

interface VerifyOutcome {
  ok: boolean;
  payer?: string;
  reason?: string;
}

async function facilitatorVerify(
  request: X402VerifyRequest,
  config: FacilitatorConfig
): Promise<VerifyOutcome> {
  const { status, json, text } = await facilitatorPost(config, "/verify", request);
  if (status !== 200) {
    return { ok: false, reason: `facilitator /verify HTTP ${status}: ${text.slice(0, 200)}` };
  }
  if (!json || json.isValid !== true) {
    const invalidReason = typeof json?.invalidReason === "string" ? json.invalidReason : undefined;
    const details =
      typeof json?.invalidReasonDetails === "string" ? json.invalidReasonDetails : undefined;
    return {
      ok: false,
      reason: `facilitator rejected payment: ${invalidReason ?? "unknown"}${details ? ` (${details})` : ""}`,
    };
  }
  return { ok: true, payer: typeof json.payer === "string" ? json.payer : undefined };
}

interface SettleOutcome {
  settled: boolean;
  payer?: string;
  transaction?: string;
  reason?: string;
  /** True when the facilitator error could not be resolved on-chain. */
  ambiguous?: boolean;
}

/**
 * Call the facilitator's /settle, and on any non-success result confirm on-chain
 * before concluding the payment failed.
 *
 * The facilitator can return HTTP 500 for a settlement that actually executed
 * (confirmed Phase 1 behaviour). Treating that as "payment not received" would
 * either double-charge on client retry or deny access after a real payment.
 */
async function facilitatorSettle(
  request: X402VerifyRequest,
  config: FacilitatorConfig,
  chain: FacilitatorChainInfo,
  authorization: { from: string; nonce: string }
): Promise<SettleOutcome> {
  let json: Record<string, unknown> | null = null;
  let status = 0;
  let text = "";
  try {
    const res = await facilitatorPost(config, "/settle", request);
    status = res.status;
    json = res.json;
    text = res.text;
  } catch (err) {
    text = (err as Error).message;
  }

  if (status === 200 && json?.success === true) {
    return {
      settled: true,
      payer: typeof json.payer === "string" ? json.payer : undefined,
      transaction: typeof json.transaction === "string" ? json.transaction : undefined,
    };
  }

  const facilitReason =
    typeof json?.errorMessage === "string"
      ? json.errorMessage
      : typeof json?.errorReason === "string"
        ? json.errorReason
        : text || "unknown";

  console.warn(
    `[mdf:payment:x402] /settle did not return success (HTTP ${status}): ${facilitReason} — checking on-chain state`
  );

  const txHash =
    typeof json?.transaction === "string" && json.transaction.length > 0
      ? json.transaction
      : undefined;

  const onchain = await confirmSettlementOnChain(chain, {
    txHash,
    from: authorization.from,
    nonce: authorization.nonce,
  });

  if (onchain === "settled") {
    return { settled: true, payer: authorization.from, transaction: txHash };
  }
  if (onchain === "not_settled") {
    return { settled: false, reason: `facilitator /settle failed: ${facilitReason}` };
  }
  return {
    settled: false,
    ambiguous: true,
    reason: `facilitator /settle failed and on-chain status could not be confirmed: ${facilitReason}`,
  };
}

// ---------------------------------------------------------------------------
// On-chain settlement confirmation
// ---------------------------------------------------------------------------

// authorizationState(address,bytes32) — EIP-3009, returns whether a nonce was used.
const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";

function leftPad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0").slice(-64);
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

/**
 * Confirm whether a specific EIP-3009 authorization was consumed on-chain.
 *
 * Order of evidence:
 *   1. If a tx hash was returned, fetch its receipt: status 0x1 → settled,
 *      status 0x0 → reverted (not settled).
 *   2. Otherwise call the token's `authorizationState(from, nonce)`. Once a
 *      transferWithAuthorization executes this flips — and stays — true, giving
 *      a definitive per-payment signal independent of the facilitator.
 *
 * Returns "unknown" when no RPC is configured or unreachable, so the caller
 * never mistakes an infrastructure failure for a payment denial.
 */
async function confirmSettlementOnChain(
  chain: FacilitatorChainInfo,
  params: { txHash?: string; from: string; nonce: string }
): Promise<"settled" | "not_settled" | "unknown"> {
  if (!chain.rpcUrl) return "unknown";
  const timeoutMs = 8000;

  try {
    if (params.txHash) {
      const receipt = (await rpcCall(
        chain.rpcUrl,
        "eth_getTransactionReceipt",
        [params.txHash],
        timeoutMs
      )) as { status?: string } | null;
      if (receipt) {
        return receipt.status === "0x1" ? "settled" : "not_settled";
      }
      // Receipt not found — tx may still be pending; fall through to nonce check.
    }

    const data =
      AUTHORIZATION_STATE_SELECTOR +
      leftPad32(params.from.replace(/^0x/, "")) +
      leftPad32(params.nonce.replace(/^0x/, ""));

    const result = (await rpcCall(
      chain.rpcUrl,
      "eth_call",
      [{ to: chain.asset, data }, "latest"],
      timeoutMs
    )) as string | undefined;

    if (typeof result === "string" && result.length >= 3) {
      return result.slice(-1) === "1" ? "settled" : "not_settled";
    }
    return "not_settled";
  } catch (err) {
    console.warn(
      `[mdf:payment:x402] on-chain settlement check failed: ${(err as Error).message}`
    );
    return "unknown";
  }
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

  const { api_url, invoice_expiry_seconds } = config.lightning;
  // loader.ts resolves (and requires) both whenever [lightning] is configured;
  // the schema fields are optional so the resolution lives in exactly one place.
  const api_token = config.lightning.api_token!;
  const token_secret = config.lightning.token_secret!;
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

  const { api_url } = config.lightning;
  const api_token = config.lightning.api_token!;
  const token_secret = config.lightning.token_secret!;

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
// x402 chain registry and verifier
// ---------------------------------------------------------------------------

const CHAIN_ID_MAP: Record<string, string> = {
  base: "8453",
  base_sepolia: "84532",
  ethereum: "1",
};

/**
 * x402 V1 network names. x402-rs resolves these to CAIP-2 chain ids; only
 * networks listed here can be offered on the x402 rail.
 */
const X402_NETWORK_MAP: Record<string, string> = {
  base: "base",
  base_sepolia: "base-sepolia",
};

function isLightningChain(chain: string | null | undefined): boolean {
  return chain?.toLowerCase() === "lightning";
}

/**
 * Resolve the facilitator-side metadata for an MDF chain, or null when the
 * chain is not an x402 chain / has no configured asset.
 */
export function x402ChainInfo(
  chain: string | null | undefined,
  facilitatorConfig: FacilitatorConfig | null
): FacilitatorChainInfo | null {
  if (!chain || !facilitatorConfig) return null;
  const key = chain.toLowerCase();
  const network = X402_NETWORK_MAP[key];
  const chainId = CHAIN_ID_MAP[key];
  const chainCfg = facilitatorConfig.chains[key];
  if (!network || !chainId || !chainCfg) return null;
  return {
    network,
    chainId,
    asset: chainCfg.asset,
    decimals: chainCfg.decimals,
    extra: chainCfg.extra,
    rpcUrl: chainCfg.rpc_url,
  };
}

/**
 * Build the standard x402 V1 `PaymentRequirements` for an offer. Field names
 * are camelCase per the x402 wire format (MDF's own 402 body uses snake_case).
 */
function buildPaymentRequirements(
  offer: { amount: string },
  resource: string,
  loaded: LoadedConfig,
  chainInfo: FacilitatorChainInfo,
  config: FacilitatorConfig
): Record<string, unknown> {
  const requirements: Record<string, unknown> = {
    scheme: config.scheme,
    network: chainInfo.network,
    maxAmountRequired: toAtomicUnits(offer.amount, chainInfo.decimals),
    resource,
    description: `MDF access: ${resource}`,
    mimeType: "text/markdown",
    payTo: loaded.walletAddress ?? "",
    maxTimeoutSeconds: config.max_timeout_seconds,
    asset: chainInfo.asset,
  };
  if (chainInfo.extra) requirements.extra = chainInfo.extra;
  return requirements;
}

/**
 * Map a settlement network to the payment rail that would handle it.
 *
 * This mirrors the branch that selects the verifier: `lightning` is served by
 * the L402 flow (invoice + macaroon), while chains in CHAIN_ID_MAP (base,
 * base_sepolia, ethereum) are served by the x402 flow. Any chain with no known
 * rail returns null so the caller can omit the field rather than assert a
 * mapping that may not hold.
 */
function railForChain(chain: string | null | undefined): "x402" | "l402" | null {
  const c = chain?.toLowerCase();
  if (c === "lightning") return "l402";
  if (c && CHAIN_ID_MAP[c]) return "x402";
  return null;
}

/**
 * Verify and settle an x402 payment for a request.
 *
 * The client submits a standard base64 `PaymentPayload` in the `X-PAYMENT`
 * header. The server builds `PaymentRequirements` from the offer it issued,
 * calls the facilitator's `/verify` then `/settle`, and — on any /settle
 * error — confirms on-chain before concluding the payment failed.
 */
export async function verifyPayment(
  urlPath: string,
  paymentHeader: string | null | undefined,
  loaded: LoadedConfig
): Promise<VerificationResult> {
  const { config, facilitatorConfig } = loaded;
  const requiresToken = pathRequiresToken(urlPath, config);
  const priceEntry = requiredPriceEntry(urlPath, config);
  const required = priceEntry.amount;

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
      reason: `payment required: ${required} ${priceEntry.currency ?? config.pricing.default.currency ?? ""}`.trim(),
      requiresToken,
      rail: "none",
    };
  }

  // Lightning prices are served by the L402 flow, not x402.
  if (isLightningChain(priceEntry.chain)) {
    return {
      status: "stub_approved",
      proof: null,
      l402Credential: null,
      reason: "lightning chain — handled by L402 flow",
      requiresToken,
      rail: "l402",
    };
  }

  const proof = parseX402PaymentHeader(paymentHeader.trim());
  if (!proof) {
    return {
      status: "rejected",
      proof: null,
      l402Credential: null,
      reason: "malformed X-PAYMENT header (expected base64 x402 PaymentPayload)",
      requiresToken,
      rail: "x402",
    };
  }

  if (!facilitatorConfig) {
    return {
      status: "error",
      proof,
      l402Credential: null,
      reason: "x402 pricing configured but no [facilitator] block is available",
      requiresToken,
      rail: "x402",
    };
  }

  const chainInfo = x402ChainInfo(priceEntry.chain, facilitatorConfig);
  if (!chainInfo) {
    return {
      status: "error",
      proof,
      l402Credential: null,
      reason: `no facilitator chain config for '${priceEntry.chain ?? "unspecified"}'`,
      requiresToken,
      rail: "x402",
    };
  }

  if (proof.scheme !== facilitatorConfig.scheme) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: `scheme '${proof.scheme}' not accepted (expected '${facilitatorConfig.scheme}')`,
      requiresToken,
      rail: "x402",
    };
  }

  if (proof.network.toLowerCase() !== chainInfo.network.toLowerCase()) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: `network '${proof.network}' does not match offer '${chainInfo.network}'`,
      requiresToken,
      rail: "x402",
    };
  }

  if (proof.to.toLowerCase() !== (loaded.walletAddress ?? "").toLowerCase()) {
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: "payment recipient does not match offer pay_to",
      requiresToken,
      rail: "x402",
    };
  }

  const resource = `${config.site.url.replace(/\/$/, "")}${urlPath}`;
  const requirements = buildPaymentRequirements(
    priceEntry,
    resource,
    loaded,
    chainInfo,
    facilitatorConfig
  );
  const request: X402VerifyRequest = {
    x402Version: 1,
    paymentPayload: proof.envelope ?? {},
    paymentRequirements: requirements,
  };

  let verify: VerifyOutcome;
  try {
    verify = await facilitatorVerify(request, facilitatorConfig);
  } catch (err) {
    logX402(urlPath, proof, "error");
    return {
      status: "error",
      proof,
      l402Credential: null,
      reason: `facilitator /verify unreachable: ${(err as Error).message}`,
      requiresToken,
      rail: "x402",
    };
  }

  if (!verify.ok) {
    // A retry of an already-settled authorization fails /verify (the EIP-3009
    // nonce is consumed), so confirm on-chain before treating this as a
    // rejection — otherwise a real, settled payment would be denied.
    const onchain = await confirmSettlementOnChain(chainInfo, {
      from: proof.from,
      nonce: proof.nonce,
    });
    if (onchain === "settled") {
      logX402(urlPath, proof, "approved");
      return {
        status: "approved",
        proof,
        l402Credential: null,
        reason: "x402: previously settled authorization confirmed on-chain",
        requiresToken,
        rail: "x402",
        settlement: { payer: proof.from, transaction: "" },
      };
    }
    logX402(urlPath, proof, "rejected");
    return {
      status: "rejected",
      proof,
      l402Credential: null,
      reason: verify.reason ?? "facilitator rejected payment",
      requiresToken,
      rail: "x402",
    };
  }

  let settle: SettleOutcome;
  try {
    settle = await facilitatorSettle(request, facilitatorConfig, chainInfo, {
      from: proof.from,
      nonce: proof.nonce,
    });
  } catch (err) {
    logX402(urlPath, proof, "error");
    return {
      status: "error",
      proof,
      l402Credential: null,
      reason: `facilitator /settle unreachable: ${(err as Error).message}`,
      requiresToken,
      rail: "x402",
    };
  }

  if (!settle.settled) {
    logX402(urlPath, proof, settle.ambiguous ? "error" : "rejected");
    return {
      status: settle.ambiguous ? "error" : "rejected",
      proof,
      l402Credential: null,
      reason: settle.reason ?? "settlement failed",
      requiresToken,
      rail: "x402",
    };
  }

  logX402(urlPath, proof, "approved");
  return {
    status: "approved",
    proof,
    l402Credential: null,
    reason: "x402: payment verified and settled via facilitator",
    requiresToken,
    rail: "x402",
    settlement: {
      payer: settle.payer ?? proof.from,
      transaction: settle.transaction ?? "",
    },
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
 * For x402 paths: emits the MDF 0.2.0 superset fields (pay_to, asset, scheme,
 * max_timeout_seconds, extra) alongside the original MDF fields.
 */
export async function build402Response(
  urlPath: string,
  result: VerificationResult,
  loaded: LoadedConfig,
  resourceUrl?: string
): Promise<{ status: 402; headers: Record<string, string>; body: string }> {
  const { config } = loaded;

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

  // Absolute URL of the priced resource, reconstructed from the request. The
  // caller passes the full URL (query string included) where available; the
  // fallback covers path-only callers.
  const resource =
    resourceUrl ?? `${config.site.url.replace(/\/$/, "")}${urlPath}`;

  // The rail for this offer, derived from the same chain->rail mapping that
  // selects the verifier at payment time.
  const offerRail = railForChain(priceEntry.chain);

  // x402 superset fields (MDF 0.2.0) — required when this offer is on the
  // x402 rail, so the 402 body is directly usable as x402 PaymentRequirements
  // without a translation layer. expires_at shares the offer's validity
  // window with max_timeout_seconds rather than tracking a second lifetime.
  const chainInfo =
    offerRail === "x402" ? x402ChainInfo(priceEntry.chain, loaded.facilitatorConfig) : null;

  let x402Fields: Record<string, unknown> = {};
  let offerExpiresAt: string | undefined;
  if (offerRail === "x402" && config.facilitator) {
    x402Fields = {
      ...(loaded.walletAddress ? { pay_to: loaded.walletAddress } : {}),
      ...(chainInfo ? { asset: chainInfo.asset } : {}),
      scheme: config.facilitator.scheme,
      max_timeout_seconds: config.facilitator.max_timeout_seconds,
      ...(chainInfo?.extra ? { extra: chainInfo.extra } : {}),
    };
    offerExpiresAt = new Date(
      Date.now() + config.facilitator.max_timeout_seconds * 1000
    ).toISOString();
  }

  // source_bytes — the byte length of this resource's rendered-HTML
  // representation (the alternative an agent would otherwise fetch), computed
  // the same way serveContent renders it. A 402 can be reached for a URL with
  // no content file, so omit the field rather than erroring.
  const sourceBytes = htmlSourceBytesForPath(urlPath, loaded);

  const body = JSON.stringify({
    error: "Payment Required",
    reason: result.reason,
    resource,
    ...(sourceBytes !== undefined ? { source_bytes: sourceBytes } : {}),
    payment: {
      endpoint: config.payment?.endpoint
        ? resolveEndpoint(config.payment.endpoint, config.site.url)
        : null,
      amount: priceEntry.amount,
      currency: priceEntry.currency ?? config.pricing.default.currency,
      chain: priceEntry.chain ?? null,
      ...(offerRail ? { rail: offerRail } : {}),
      accepted_chains: config.payment?.accepted_chains ?? [],
      accepted_currencies: config.payment?.accepted_currencies ?? [],
      ...x402Fields,
      ...(offerExpiresAt ? { expires_at: offerExpiresAt } : {}),
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
