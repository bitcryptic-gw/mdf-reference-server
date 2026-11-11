/**
 * The x402 v2 402 response, as MDF 0.3.x emits it.
 *
 * Shape (spec 0.3.1, decision 1/8):
 *
 *   { "x402Version": 2,
 *     "error": "<coarse class>",
 *     "resource": { url, description, mimeType, serviceName? },
 *     "accepts": [ <one PaymentRequirements per offered rail> ],
 *     "extensions": { "mdf": { "info": {…}, "schema": {…} } } }
 *
 * MDF's own fields live only in `extensions.mdf.info` — version,
 * source_bytes, expires_at, price_summary, and auth_endpoint for a token tier.
 * Nothing there restates an amount, payTo or network: those belong to
 * `accepts[]`, and duplicating them creates two sources of truth that can
 * disagree.
 *
 * The body *is* the `PaymentRequired` object and the `PAYMENT-REQUIRED` header
 * is the base64 of the body's exact bytes, so "body and header MUST agree field
 * for field" cannot drift.
 *
 * Error hygiene: `error` and any 503 reason come from a closed vocabulary. A
 * facilitator's `invalidReason`, `invalidMessage` or a token contract revert
 * string never reaches the wire (the old server echoed the full
 * `FiatTokenV2` revert hex).
 */

import { HEADER, encodeHeaderBytes } from "./headers.ts";
import type { PaymentRequirement } from "./rails.ts";
import { priceSummary } from "./rails.ts";

/** MDF specification version this build conforms to. */
export const MDF_SPEC_VERSION = "0.3.1";

/** Protocol family, unchanged across 0.2/0.3 (decision 13). */
export const MDF_PROTOCOL_VERSION = "1";

/**
 * Coarse, closed error vocabulary. These are the only values that may appear in
 * a 402 `error` field or a payment-failure response body.
 */
export type CoarseError =
  | "payment_required"
  | "invalid_payment"
  | "payment_expired"
  | "wrong_recipient"
  | "wrong_amount"
  | "replay_rejected"
  | "unsupported_rail"
  | "payment_unavailable";

/** JSON Schema for `extensions.mdf.info`, emitted in the 402 as `…mdf.schema`. */
export const MDF_INFO_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["version", "price_summary"],
  additionalProperties: false,
  properties: {
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    expires_at: { type: "string", format: "date-time" },
    price_summary: { type: "string", minLength: 1, maxLength: 512 },
    source_bytes: { type: "integer", minimum: 0 },
    auth_endpoint: { type: "string", format: "uri" },
  },
  dependentRequired: {},
};

export interface MdfInfo {
  version: string;
  price_summary: string;
  expires_at?: string;
  source_bytes?: number;
  auth_endpoint?: string;
}

export interface PaymentRequiredDoc {
  x402Version: 2;
  error?: CoarseError;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
    serviceName?: string;
  };
  accepts: PaymentRequirement[];
  extensions: { mdf: { info: MdfInfo; schema: Record<string, unknown> } };
}

export interface BuildOfferParams {
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  accepts: PaymentRequirement[];
  /** Omitted from the object entirely when absent (e.g. a plain unpaid probe). */
  error?: CoarseError;
  expiresAt?: string;
  sourceBytes?: number;
  authEndpoint?: string;
}

/**
 * Build the `PaymentRequired` object. `price_summary` is derived here from the
 * rails actually offered, so it cannot disagree with `accepts[]`.
 */
export function buildPaymentRequired(params: BuildOfferParams): PaymentRequiredDoc {
  const info: MdfInfo = {
    version: MDF_SPEC_VERSION,
    price_summary: priceSummary(params.accepts),
  };
  if (params.sourceBytes !== undefined) info.source_bytes = params.sourceBytes;
  if (params.expiresAt) info.expires_at = params.expiresAt;
  if (params.authEndpoint) info.auth_endpoint = params.authEndpoint;

  const resource: PaymentRequiredDoc["resource"] = { url: params.resourceUrl };
  if (params.description) resource.description = params.description;
  if (params.mimeType) resource.mimeType = params.mimeType;
  if (params.serviceName) resource.serviceName = params.serviceName;

  const doc: PaymentRequiredDoc = {
    x402Version: 2,
    resource,
    accepts: params.accepts,
    extensions: { mdf: { info, schema: MDF_INFO_SCHEMA } },
  };
  if (params.error) doc.error = params.error;
  return doc;
}

export interface HttpPaymentResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Render a 402: the body is the canonical JSON of the object, and the header is
 * the base64 of exactly those bytes. `no-store` is unconditional — a 402 carries
 * a per-request offer (and, on the lnbtc rail, a fresh invoice), so no cache may
 * ever reuse it.
 */
export function render402(doc: PaymentRequiredDoc): HttpPaymentResponse {
  const body = JSON.stringify(doc);
  return {
    status: 402,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-MDF-Version": MDF_PROTOCOL_VERSION,
      [HEADER.required]: encodeHeaderBytes(body),
    },
    body,
  };
}

/**
 * The spec's "no rail can be offered" response: an error with `Retry-After`,
 * never a 402 with an empty `accepts[]` (a client would have nothing to pay).
 */
export function renderUnavailable(params: {
  resourceUrl: string;
  error: CoarseError;
  retryAfterSeconds?: number;
}): HttpPaymentResponse {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-MDF-Version": MDF_PROTOCOL_VERSION,
  };
  if (params.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(params.retryAfterSeconds)));
  }
  return {
    status: 503,
    headers,
    body: JSON.stringify({
      error: params.error,
      reason: "no payment rail is currently available for this resource",
      resource: params.resourceUrl,
    }),
  };
}

/**
 * Map an internal or facilitator-side failure to the public vocabulary.
 *
 * Deliberately lossy: the client learns the class, not the reason. Replay is
 * split out because it is the one class a client can act on (do not retry with
 * the same proof); everything else collapses to `invalid_payment`.
 */
export function coarseErrorClass(reason: string | undefined | null): CoarseError {
  // Normalise separators so one set of patterns covers `invalid_exact_evm_pay_to_mismatch`,
  // `duplicate_settlement` and prose alike.
  const r = (reason ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();

  if (r === "" || r.includes("no payment") || r.includes("payment required")) {
    return "payment_required";
  }
  if (
    r.includes("duplicate settlement") ||
    r.includes("already used") ||
    r.includes("nonce already") ||
    r.includes("replay")
  ) {
    return "replay_rejected";
  }
  if (r.includes("expired") || r.includes("validbefore")) {
    return "payment_expired";
  }
  if (r.includes("recipient") || r.includes("pay to") || r.includes("payee")) {
    return "wrong_recipient";
  }
  if (r.includes("amount") || r.includes("insufficient") || r.includes("underpay")) {
    return "wrong_amount";
  }
  if (r.includes("unsupported") || r.includes("scheme") || r.includes("network")) {
    return "unsupported_rail";
  }
  return "invalid_payment";
}
