/**
 * What a 402 actually offers.
 *
 * One function decides it, so the rules that are easy to get subtly wrong live
 * in one place and are testable without a server:
 *
 *   - every configured rail for the path appears in `accepts[]`, in config order;
 *   - a **degraded** rail is omitted and the others are unaffected (item 3). For
 *     lnbtc that means: gate closed, mint budget exhausted, or a mint failure;
 *   - eip155 rails do not consult the wallet at all, and lnbtc does not consult
 *     the facilitator — the two dependencies fail independently;
 *   - if nothing can be offered, that is `unavailable` and the caller answers
 *     503 with `Retry-After` rather than a 402 with an empty `accepts[]`;
 *   - the lnbtc invoice commits to the request binding for *this* request, and a
 *     mint that fails is downgraded to "rail omitted", never to a requirement
 *     with a stale or fabricated invoice.
 */

import type { PaymentRequirement, PriceEntryConfig, RequirementContext } from "./rails.ts";
import { buildEip155Requirement, buildLnbtcRequirement, isLnbtcNetwork } from "./rails.ts";
import { computeRequestHash, type BindingInput } from "./lnbtc/binding.ts";
import { decodeBolt11 } from "./lnbtc/bolt11.ts";
import type { MintLimiter } from "./rate-limit.ts";
import type { LnbtcGate } from "./lnbtc/availability.ts";

export type OmitReason =
  | "lnbtc_disabled"
  | "lnbtc_degraded"
  | "mint_rate_limited"
  | "mint_failed"
  | "invalid_rail";

export interface Offer {
  accepts: PaymentRequirement[];
  omitted: Array<{ network: string; reason: OmitReason }>;
  /** True when no rail could be offered at all. */
  allUnavailable: boolean;
  /** Seconds to wait, when the only reason was a rate limit. */
  retryAfterSeconds?: number;
  /** Binding actually used for the lnbtc rail, when one was minted. */
  binding?: { requestHash: string; headers: string[] };
}

export interface MintInvoice {
  invoice: string;
  paymentHash: string;
}

export interface BuildOffersOptions {
  entry: PriceEntryConfig;
  ctx: RequirementContext;
  /** Request binding input for the lnbtc rail (method/url/body/headers). */
  binding: BindingInput;
  /** Undefined when NWC is not configured. */
  lnbtc?: {
    gate: LnbtcGate;
    limiter: MintLimiter;
    clientKey: string;
    /**
     * Called with the signing key of an invoice the wallet just minted, which is
     * the authoritative receiver pubkey (see `normaliseNodePubkey` — the
     * `get_info` form is x-only and its y-parity is a guess).
     */
    observePayee?: (pubkey: string) => void;
    mint: (params: {
      amountMsat: number;
      descriptionHash: string;
      expirySeconds: number;
    }) => Promise<MintInvoice>;
  };
  /** Injectable clock for the limiter. */
  nowMs?: number;
}

/**
 * Build the offer for a path. Never throws: a rail that cannot be built is
 * omitted, and the caller decides what to do with an empty offer.
 */
export async function buildOffers(options: BuildOffersOptions): Promise<Offer> {
  const accepts: PaymentRequirement[] = [];
  const omitted: Offer["omitted"] = [];
  let retryAfterSeconds: number | undefined;
  let binding: Offer["binding"];

  for (const rail of options.entry.rails) {
    if (!isLnbtcNetwork(rail.network)) {
      const built = buildEip155Requirement(rail, options.ctx);
      if (!built.ok) {
        omitted.push({ network: rail.network, reason: "invalid_rail" });
        continue;
      }
      accepts.push(built.requirement);
      continue;
    }

    // ---- lnbtc ----
    const lnbtc = options.lnbtc;
    if (!lnbtc) {
      omitted.push({ network: rail.network, reason: "lnbtc_disabled" });
      continue;
    }
    if (!lnbtc.gate.canOffer()) {
      omitted.push({ network: rail.network, reason: "lnbtc_degraded" });
      continue;
    }

    const amountMsat = Number(rail.amount);
    const hash = computeRequestHash(options.binding);

    const budget = lnbtc.limiter.tryTake(lnbtc.clientKey, options.nowMs ?? Date.now());
    if (!budget.ok) {
      omitted.push({ network: rail.network, reason: "mint_rate_limited" });
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, budget.retryAfterSeconds ?? 1);
      continue;
    }

    let minted: MintInvoice;
    try {
      minted = await lnbtc.mint({
        amountMsat,
        descriptionHash: hash.requestHash,
        expirySeconds: options.ctx.maxTimeoutSeconds,
      });
    } catch {
      // A wallet or relay failure is exactly as transient as an outage: omit the
      // rail, keep the others, and let the breaker record it.
      omitted.push({ network: rail.network, reason: "mint_failed" });
      continue;
    }

    // The minted invoice's recovered signing key is the one fact about the
    // receiver that cannot be stale or mis-lifted, so it wins for this offer and
    // is fed back to the runtime for the verify path.
    let payee = options.ctx.lnbtcPayTo;
    try {
      const decoded = decodeBolt11(minted.invoice);
      if (decoded.signingKey) {
        payee = decoded.signingKey;
        if (payee !== options.ctx.lnbtcPayTo) lnbtc.observePayee?.(payee);
      }
    } catch {
      // An invoice we cannot decode is still a valid invoice to hand out; the
      // configured payee stands and verification will decide.
    }

    const built = buildLnbtcRequirement(rail, { ...options.ctx, lnbtcPayTo: payee }, {
      invoice: minted.invoice,
      requestHash: hash.requestHash,
      requestBindingParams: hash.requestBindingParams,
    });
    if (!built.ok) {
      omitted.push({ network: rail.network, reason: "invalid_rail" });
      continue;
    }
    accepts.push(built.requirement);
    binding = { requestHash: hash.requestHash, headers: hash.requestBindingParams.headers };
  }

  return {
    accepts,
    omitted,
    allUnavailable: accepts.length === 0,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(binding ? { binding } : {}),
  };
}
