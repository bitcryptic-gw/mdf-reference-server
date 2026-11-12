/**
 * The payment facade: offers, verification and settlement, in one place.
 *
 * Rail resolution lives in `rails.ts`, offer construction (degradation, rate
 * limits, invoice minting) in `offers.ts`, the facilitator in `facilitator.ts`
 * and lnbtc verification in `lnbtc/verify.ts`. This file is the seam the router
 * talks to, and the only place that knows the order of operations for a paid
 * request:
 *
 *     offer → PAYMENT-SIGNATURE → match a rail → verify → settle → serve
 *
 * with two rails whose settlement stories differ completely: eip155 delegates to
 * a facilitator (verify then settle, with the #52 contract), lnbtc settles
 * locally (validate the invoice and preimage, then claim the replay key).
 */

import type { LoadedConfig } from "../config/loader.ts";
import { htmlSourceBytesForPath } from "../content/handler.ts";
import {
  isFreeEntry,
  isTokenEntry,
  resolvePriceEntry,
  tokenScopeForPath,
  pricingView,
  type PaymentRequirement,
  type RailConfig,
  type RequirementContext,
} from "./rails.ts";
import { buildOffers, type Offer } from "./offers.ts";
import { computeRequestHash } from "./lnbtc/binding.ts";
import { buildPaymentRequired, coarseErrorClass, type CoarseError, type PaymentRequiredDoc } from "./402.ts";
import { decodeHeaderObject, HEADER, MAX_PAYMENT_HEADER_CHARS } from "./headers.ts";
import type { VerifiedAuthorization } from "./facilitator.ts";
import { confirmSuccessfulTransfer } from "./facilitator.ts";
import {
  checkInvoice,
  decodeBolt11,
  preimageMatches,
} from "./lnbtc/bolt11.ts";
import { replayTtlSeconds } from "./lnbtc/replay-store.ts";

export type VerifyStatus = "approved" | "no_payment" | "rejected" | "error";

export interface VerifyResult {
  status: VerifyStatus;
  /** Coarse class for the 402 body and the attempt log. */
  reason?: CoarseError;
  rail?: string;
  settlement?: { transaction: string; network: string; payer?: string };
  /** Set when the request was approved but a token should be issued. */
  issueToken?: boolean;
}

/**
 * Identity of a payment, for idempotent token issuance.
 *
 * eip155: `network:from:nonce` — the nonce lives inside the signed authorization,
 * so it cannot be claimed by anyone else. lnbtc: `network:payment_hash` — there
 * is no payer key, and the hash is what a preimage proves.
 */
export function paymentIdentity(payload: Record<string, unknown>): {
  key: string;
  rail: string;
} | null {
  const accepted = payload.accepted as PaymentRequirement | undefined;
  if (!accepted || typeof accepted.network !== "string") return null;
  const rail = `${accepted.scheme}/${accepted.network}`;

  if (accepted.network.startsWith("lnbtc:")) {
    const invoice = (accepted.extra as Record<string, unknown> | undefined)?.invoice;
    if (typeof invoice !== "string") return null;
    try {
      const decoded = decodeBolt11(invoice);
      return { key: `${accepted.network}:${decoded.paymentHash}`, rail };
    } catch {
      return null;
    }
  }

  const auth = (payload.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined)
    ?.authorization;
  if (!auth || typeof auth.from !== "string" || typeof auth.nonce !== "string") return null;
  return {
    key: `${accepted.network}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`,
    rail,
  };
}

export interface RequestContext {
  urlPath: string;
  resourceUrl: string;
  method: string;
  /** Header values by lower-case name (only `accept` is bound). */
  headers: Record<string, string | null | undefined>;
  /** Client key already resolved through the trusted-proxy rule. */
  clientKey: string;
}

function ctx(loaded: LoadedConfig): RequirementContext {
  return {
    eip155PayTo: loaded.walletAddress,
    lnbtcPayTo: loaded.lnbtc?.payeePubkey ?? null,
    maxTimeoutSeconds: loaded.config.payment.max_timeout_seconds,
  };
}

/** Entry for a path, plus whether it is free / token-gated. */
export function entryFor(loaded: LoadedConfig, urlPath: string) {
  const { entry } = resolvePriceEntry(urlPath, pricingView(loaded.config));
  return {
    entry,
    free: isFreeEntry(entry),
    tokenAccess: isTokenEntry(entry),
    tokenScope: tokenScopeForPath(urlPath),
  };
}

/**
 * Build the offer for a 402. Returns the offers plus the `PaymentRequired`
 * document, so the caller renders body and header from one object.
 */
export async function buildOfferFor(
  loaded: LoadedConfig,
  request: RequestContext,
  options: { error?: CoarseError; startedAtMs: number; mimeType?: string } = { startedAtMs: Date.now() }
): Promise<{ offer: Offer; doc: PaymentRequiredDoc }> {
  const { entry, tokenAccess } = entryFor(loaded, request.urlPath);

  const offer = await buildOffers({
    entry,
    ctx: ctx(loaded),
    binding: {
      method: request.method,
      url: request.resourceUrl,
      headers: request.headers,
      boundHeaders: ["accept"],
    },
    lnbtc:
      loaded.lnbtc && entry.rails.some((rail) => rail.network.startsWith("lnbtc:"))
        ? {
            gate: loaded.lnbtc.gate,
            limiter: loaded.lnbtc.limiter,
            clientKey: request.clientKey,
            observePayee: (pubkey) => {
              // First invoice wins: it came from our own wallet, so it is the
              // receiver's real compressed key whatever get_info reported.
              if (loaded.lnbtc) loaded.lnbtc.payeePubkey = pubkey;
            },
            mint: (params) =>
              loaded.lnbtc!.client.makeInvoice({
                amountMsat: params.amountMsat,
                descriptionHash: params.descriptionHash,
                expirySeconds: params.expirySeconds,
              }),
          }
        : undefined,
  });

  const doc = buildPaymentRequired({
    resourceUrl: request.resourceUrl,
    serviceName: loaded.config.site.name,
    mimeType: options.mimeType ?? "text/markdown",
    accepts: offer.accepts,
    error: options.error ?? "payment_required",
    expiresAt: new Date(
      Date.now() + loaded.config.payment.max_timeout_seconds * 1000
    ).toISOString(),
    sourceBytes: sourceBytesFor(loaded, request.urlPath),
    ...(tokenAccess && loaded.config.auth
      ? { authEndpoint: absoluteEndpoint(loaded, loaded.config.auth.endpoint) }
      : {}),
  });

  return { offer, doc };
}

function absoluteEndpoint(loaded: LoadedConfig, endpoint: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  return `${loaded.config.site.url.replace(/\/$/, "")}${endpoint}`;
}

/** source_bytes is informational; absence must never fail a 402. */
function sourceBytesFor(loaded: LoadedConfig, urlPath: string): number | undefined {
  try {
    return htmlSourceBytesForPath(urlPath, loaded);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifiedPayment {
  key: string;
  rail: string;
  payer?: string;
}

export interface VerifyInput {
  loaded: LoadedConfig;
  request: RequestContext;
  /** The `PAYMENT-SIGNATURE` header value, if any. */
  paymentSignature: string | null;
  /** Whether an `X-PAYMENT` header was also present (logging only). */
  sawLegacyHeader?: boolean;
  /**
   * Runs once the payment is verified and **before it is settled or its replay
   * key is claimed**. Returns false when the caller could not durably record the
   * payment; the request then fails closed without spending the payer's money.
   */
  onVerifiedPayment?: (payment: VerifiedPayment) => Promise<boolean>;
}

/**
 * Verify and settle a payment for this request.
 *
 * `X-PAYMENT` is intentionally not read: the v2 hard cut means the old header
 * buys nothing. Its presence is reported by the caller for the attempt log.
 */
export async function verifyPayment(input: VerifyInput): Promise<VerifyResult> {
  const { loaded, request, paymentSignature } = input;
  const { entry, free, tokenAccess } = entryFor(loaded, request.urlPath);

  if (free) return { status: "approved" };

  if (!paymentSignature) {
    return { status: "no_payment", reason: "payment_required", ...(tokenAccess ? { issueToken: true } : {}) };
  }

  const decoded = decodeHeaderObject<Record<string, unknown>>(
    paymentSignature,
    MAX_PAYMENT_HEADER_CHARS
  );
  if (!decoded.ok) {
    // Oversized, not base64 or not JSON: all one class to the client.
    return { status: "rejected", reason: "invalid_payment" };
  }
  const payload = decoded.value;
  if (payload.x402Version !== 2) {
    // A v1 payload is not silently upgraded; the client must speak v2.
    return { status: "rejected", reason: "invalid_payment" };
  }

  const accepted = payload.accepted as PaymentRequirement | undefined;
  if (!accepted || typeof accepted.network !== "string") {
    return { status: "rejected", reason: "invalid_payment" };
  }

  const rail = entry.rails.find((candidate) => matchesRail(candidate, accepted));
  if (!rail) {
    // The client paid for something we are not offering. Coarse class only, but
    // split far enough to be actionable: a different network or asset is
    // "unsupported", a different amount is "wrong_amount", and anything else
    // (payee, scheme) is "wrong_recipient".
    return { status: "rejected", reason: classifyRailMismatch(entry.rails, accepted) };
  }

  const railLabel = `${rail.scheme}/${rail.network}`;

  if (rail.network.startsWith("lnbtc:")) {
    return verifyLnbtc({
      loaded,
      request,
      payload,
      accepted,
      rail,
      tokenAccess,
      onVerifiedPayment: input.onVerifiedPayment,
    });
  }
  return verifyEip155({
    loaded,
    request,
    payload,
    accepted,
    rail,
    tokenAccess,
    onVerifiedPayment: input.onVerifiedPayment,
  });
}

/** The four fields that identify a rail, compared case-insensitively for hex. */
export function matchesRail(rail: RailConfig, accepted: PaymentRequirement): boolean {
  if (rail.scheme !== accepted.scheme) return false;
  if (rail.network !== accepted.network) return false;
  if (rail.amount !== accepted.amount) return false;
  return rail.asset.toLowerCase() === String(accepted.asset).toLowerCase();
}

/**
 * Why an `accepted` requirement matches no configured rail, in the coarse
 * vocabulary. Every branch names a class the client can act on, and none echoes
 * a facilitator message.
 */
export function classifyRailMismatch(
  rails: readonly RailConfig[],
  accepted: PaymentRequirement
): CoarseError {
  const sameNetwork = rails.filter((rail) => rail.network === accepted.network);
  if (sameNetwork.length === 0) return "unsupported_rail";
  if (!sameNetwork.some((rail) => String(accepted.asset).toLowerCase() === rail.asset.toLowerCase())) {
    return "unsupported_rail";
  }
  if (!sameNetwork.some((rail) => rail.amount === accepted.amount)) return "wrong_amount";
  return "wrong_recipient";
}

async function verifyEip155(args: {
  loaded: LoadedConfig;
  request: RequestContext;
  payload: Record<string, unknown>;
  accepted: PaymentRequirement;
  rail: RailConfig;
  tokenAccess: boolean;
  onVerifiedPayment?: VerifyInput["onVerifiedPayment"];
}): Promise<VerifyResult> {
  const { loaded, request, payload, accepted, rail, tokenAccess, onVerifiedPayment } = args;
  const pool = loaded.pool;
  if (!pool) return { status: "error", reason: "payment_unavailable" };

  if (accepted.payTo !== loaded.walletAddress) {
    return { status: "rejected", reason: "wrong_recipient" };
  }
  if (accepted.maxTimeoutSeconds !== loaded.config.payment.max_timeout_seconds) {
    return { status: "rejected", reason: "invalid_payment" };
  }

  const verifyRequest = {
    x402Version: 2 as const,
    paymentPayload: payload,
    paymentRequirements: accepted,
  };

  const { outcome, leg } = await pool.verify(verifyRequest);
  if (!outcome.ok) {
    return outcome.kind === "invalid"
      ? { status: "rejected", reason: coarseErrorClass(outcome.reason) }
      : { status: "error", reason: "payment_unavailable" };
  }

  // Record the payment before money moves: a store that dies between /settle and
  // the token write would otherwise leave the payer charged and unanswered.
  if (onVerifiedPayment) {
    const recorded = await onVerifiedPayment({
      key: `${accepted.network}:${outcome.authorization.from.toLowerCase()}:${outcome.authorization.nonce.toLowerCase()}`,
      rail: `${rail.scheme}/${rail.network}`,
      ...(outcome.payer ? { payer: outcome.payer } : {}),
    });
    if (!recorded) return { status: "error", reason: "payment_unavailable" };
  }

  const settled = await pool.settle(leg, verifyRequest, {
    network: rail.network,
    asset: accepted.asset,
    rpcUrl: loaded.config.facilitator?.rpc[rail.network],
  }, outcome.authorization);

  if (!settled.settled) return { status: "error", reason: "payment_unavailable" };

  return {
    status: "approved",
    rail: `${rail.scheme}/${rail.network}`,
    settlement: {
      transaction: settled.transaction,
      network: settled.network,
      ...(settled.payer ?? outcome.payer ? { payer: settled.payer ?? outcome.payer } : {}),
    },
    ...(tokenAccess ? { issueToken: true } : {}),
  };
}

async function verifyLnbtc(args: {
  loaded: LoadedConfig;
  request: RequestContext;
  payload: Record<string, unknown>;
  accepted: PaymentRequirement;
  rail: RailConfig;
  tokenAccess: boolean;
  onVerifiedPayment?: VerifyInput["onVerifiedPayment"];
}): Promise<VerifyResult> {
  const { loaded, request, payload, accepted, rail, tokenAccess, onVerifiedPayment } = args;
  const rt = loaded.lnbtc;
  if (!rt) return { status: "rejected", reason: "unsupported_rail" };
  if (!rt.gate.canOffer()) return { status: "error", reason: "payment_unavailable" };
  if (!rt.payeePubkey) return { status: "error", reason: "payment_unavailable" };

  // 1. The accepted invoice must be the one we could have issued for this request.
  const extra = (accepted.extra ?? {}) as Record<string, unknown>;
  const invoice = typeof extra.invoice === "string" ? extra.invoice : "";
  if (!invoice) return { status: "rejected", reason: "invalid_payment" };

  const binding = computeRequestHash({
    method: request.method,
    url: request.resourceUrl,
    headers: request.headers,
    boundHeaders: ["accept"],
  });

  let decoded;
  try {
    decoded = (rt.decodeInvoiceFrom ?? decodeBolt11)(invoice);
  } catch {
    return { status: "rejected", reason: "invalid_payment" };
  }

  const invoiceCheck = checkInvoice(
    decoded,
    {
      network: rt.network,
      amountMsat: Number(rail.amount),
      requestHash: binding.requestHash,
      payeePubkey: rt.payeePubkey,
      maxTimeoutSeconds: loaded.config.payment.max_timeout_seconds,
    },
    Math.floor(Date.now() / 1000)
  );
  if (!invoiceCheck.ok) {
    // Replay and expiry are worth distinguishing for the client's benefit.
    const reason: CoarseError = /expired/i.test(invoiceCheck.reason)
      ? "payment_expired"
      : "invalid_payment";
    return { status: "rejected", reason };
  }

  // 2. The preimage proves payment of that invoice.
  const preimage = (payload.payload as { preimage?: unknown } | undefined)?.preimage;
  if (typeof preimage !== "string") return { status: "rejected", reason: "invalid_payment" };
  const preimageCheck = preimageMatches(preimage, decoded.paymentHash);
  if (!preimageCheck.ok) return { status: "rejected", reason: "invalid_payment" };

  // Record the payment before the replay key is claimed: the claim is what makes
  // the preimage single-use, so a failure to record must happen first.
  if (onVerifiedPayment) {
    const recorded = await onVerifiedPayment({
      key: `${rt.network}:${decoded.paymentHash}`,
      rail: `${rail.scheme}/${rail.network}`,
    });
    if (!recorded) return { status: "error", reason: "payment_unavailable" };
  }

  // 3. Single use, durably, across instances.
  const claim = await rt.replay.claim(
    rt.network,
    decoded.paymentHash,
    replayTtlSeconds(loaded.config.payment.max_timeout_seconds)
  );
  if (claim === "duplicate") return { status: "rejected", reason: "replay_rejected" };
  if (claim === "unavailable") return { status: "error", reason: "payment_unavailable" };

  return {
    status: "approved",
    rail: `${rail.scheme}/${rail.network}`,
    settlement: { transaction: decoded.paymentHash, network: rt.network },
    ...(tokenAccess ? { issueToken: true } : {}),
  };
}

/**
 * Header for a paid response. eip155 carries the payer; lnbtc must omit it
 * (Lightning reveals no stable payer address).
 */
export function settlementHeader(result: VerifyResult): string | null {
  if (!result.settlement) return null;
  const body = {
    success: true,
    transaction: result.settlement.transaction,
    network: result.settlement.network,
    ...(result.settlement.payer ? { payer: result.settlement.payer } : {}),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

export { HEADER };
export { confirmSuccessfulTransfer };
export type { VerifiedAuthorization };
