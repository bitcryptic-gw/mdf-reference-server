/**
 * x402 v2 HTTP header codecs and limits.
 *
 * The transport puts the whole `PaymentRequired` object in a base64
 * `PAYMENT-REQUIRED` header, the client's `PaymentPayload` in
 * `PAYMENT-SIGNATURE`, and the settlement result in `PAYMENT-RESPONSE`. MDF
 * also requires the 402 body to be that same `PaymentRequired` object, so the
 * builder encodes the body's exact bytes — not a re-serialisation — which makes
 * body and header identical by construction rather than by convention.
 *
 * Sizes are checked *before* base64 decoding: a header is attacker-controlled
 * input, and decoding it first turns a cheap length check into an allocation
 * the server was told to make.
 */

/** Largest `PAYMENT-SIGNATURE` we will decode (bytes of the header value). */
export const MAX_PAYMENT_HEADER_CHARS = 8192;

export const HEADER = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

/**
 * Base64 of the exact bytes supplied. Used for both the 402 body mirror and the
 * settlement response.
 */
export function encodeHeaderObject(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Base64 of an already-serialised JSON string, byte for byte. */
export function encodeHeaderBytes(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "too_large" | "not_base64" | "not_json" | "not_object" };

/**
 * Decode a base64 JSON header value, refusing oversized input before decoding.
 * `maxChars` is measured on the raw header, so callers can enforce a stricter
 * limit than the transport default.
 */
export function decodeHeaderObject<T = Record<string, unknown>>(
  raw: string,
  maxChars: number = MAX_PAYMENT_HEADER_CHARS
): DecodeResult<T> {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "not_json" };
  if (raw.length > maxChars) return { ok: false, reason: "too_large" };

  const normalised = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  // Reject anything outside the base64 alphabet (ignoring padding) rather than
  // letting Buffer decode a string that is really something else.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) return { ok: false, reason: "not_base64" };

  let json: string;
  try {
    json = Buffer.from(normalised, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "not_base64" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  return { ok: true, value: parsed as T };
}
