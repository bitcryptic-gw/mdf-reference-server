/**
 * lnbtc request binding (`http:1`, RFC 8785 / JCS).
 *
 * The BOLT11 description hash is what ties an invoice to the request it pays
 * for: a preimage proves payment of *an* invoice, and the binding is what proves
 * the invoice was minted for **this** method, URL, body and header set. Without
 * it, a valid preimage for a cheap request would unlock an expensive one.
 *
 * The object hashed is exactly the one the scheme defines — no extra members,
 * no trailing newline, no BOM:
 *
 *   { domain, method, url, bodyHash, headers: [{ name, valueHash }, …] }
 *
 * `headers` must list every header that can change what is bought, *including
 * when absent* (absent hashes as SHA-256 of a single 0x00 byte, present as
 * SHA-256 of 0x01 ‖ value). For this server that is `accept`: one URL serves
 * markdown or HTML by negotiation, so the purchased representation is not
 * determined by the URL alone. Client-supplied header echoes are never trusted —
 * the list comes from configuration.
 */

import { createHash } from "node:crypto";

/** Domain tag fixed by the scheme for the HTTP profile. */
export const BINDING_DOMAIN = "x402:exact:lnbtc:bolt11:http:1";

/**
 * Headers bound for an HTTP resource on this server. `accept` decides markdown
 * vs HTML; nothing else can change what a request buys (a paid response never
 * 304s, so `if-none-match` cannot suppress the body).
 */
export const DEFAULT_BOUND_HEADERS = ["accept"] as const;

/**
 * RFC 8785 (JCS) canonicalisation, restricted to the data model this binding
 * uses: objects with string keys, arrays, strings and integers. Members sort by
 * UTF-16 code unit; strings use the ECMAScript escaping JSON.stringify already
 * applies; there is no insignificant whitespace.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("JCS cannot represent a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcs(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`);
  return `{${members.join(",")}}`;
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 of the body bytes after transfer decoding; empty body = empty hash. */
export function bodyHash(body: Buffer | string | null | undefined): string {
  if (body === null || body === undefined) return sha256Hex(Buffer.alloc(0));
  return sha256Hex(Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"));
}

/**
 * Per-header digest: present ⇒ SHA-256(0x01 ‖ ASCII value), absent ⇒
 * SHA-256(0x00). The distinction matters — an empty header and a missing one are
 * different requests.
 */
export function headerValueHash(value: string | null | undefined): string {
  if (value === null || value === undefined) return sha256Hex(Buffer.from([0x00]));
  return sha256Hex(Buffer.concat([Buffer.from([0x01]), Buffer.from(value, "ascii")]));
}

export interface BindingInput {
  method: string;
  /** Absolute URL, including the query string, without fragment or userinfo. */
  url: string;
  /** Request body bytes (empty for a GET). */
  body?: Buffer | string | null;
  /** Header values keyed by lower-case name; absent keys hash as absent. */
  headers?: Record<string, string | null | undefined>;
  /** Bound header names, ascending ASCII, from configuration. */
  boundHeaders?: readonly string[];
}

export interface BindingResult {
  requestHash: string;
  requestBindingParams: { headers: string[] };
  /** The canonical description string, for debugging and test vectors. */
  canonical: string;
}

/**
 * Compute the `http:1` binding for a request.
 *
 * `payment-signature` is never bound (the scheme forbids it): binding the proof
 * to itself would make a paid retry impossible.
 */
export function computeRequestHash(input: BindingInput): BindingResult {
  const names = [...(input.boundHeaders ?? DEFAULT_BOUND_HEADERS)]
    .map((n) => n.toLowerCase())
    .filter((n) => n !== "payment-signature")
    .sort();

  const headers = names.map((name) => ({
    name,
    valueHash: headerValueHash(input.headers?.[name] ?? null),
  }));

  const binding = {
    domain: BINDING_DOMAIN,
    method: input.method,
    url: input.url,
    bodyHash: bodyHash(input.body),
    headers,
  };

  const canonical = jcs(binding);
  return {
    requestHash: sha256Hex(canonical),
    requestBindingParams: { headers: names },
    canonical,
  };
}
