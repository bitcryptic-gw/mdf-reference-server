/**
 * NWC connection URI: parsing, least-privilege enforcement, and redaction.
 *
 * The URI is a bearer credential. It carries the wallet service's pubkey, one or
 * more relay URLs, and the `secret` that authorises **whatever the connection
 * permits** — so the connection must be created with the narrowest permission
 * set Alby Hub allows, and the server must refuse to run against a wider one.
 *
 * Policy for this server: a dedicated app connection per instance, permitted
 * **`make_invoice` only**. `get_info` is tolerated because it is how the server
 * *verifies* the permission set at startup; if it is not granted (which is the
 * expected outcome of a genuinely minimal connection), the automated check
 * cannot run and the operator performs it manually — see the deployment notes.
 * Everything else, and in particular any spending method or budget, is a
 * startup error.
 *
 * `lookup_invoice` is deliberately **not** requested: the lnbtc rail verifies
 * the preimage locally (SHA-256 against the signed payment hash), so settlement
 * needs no wallet call at all.
 */

export type NwcUriError =
  | "not_a_nwc_uri"
  | "malformed_wallet_pubkey"
  | "malformed_secret"
  | "no_relay"
  | "malformed_relay";

export interface NwcUri {
  walletPubkey: string;
  relays: string[];
  secret: string;
}

export type ParseResult =
  | { ok: true; value: NwcUri }
  | { ok: false; reason: NwcUriError };

/** Wallet-service pubkeys are 32-byte x-only keys. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parse `nostr+walletconnect://<walletPubkey>?relay=<url>&secret=<hex>`.
 *
 * Multiple `relay` parameters are allowed (NIP-47 permits a list). `ws://` is
 * accepted as well as `wss://` because a self-hosted relay on the tailnet has no
 * certificate; the trade-off is that the payload is only protected by NIP-44, not
 * by TLS — acceptable over WireGuard, and stated rather than assumed.
 */
export function parseNwcUri(uri: string): ParseResult {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return { ok: false, reason: "not_a_nwc_uri" };
  }
  if (url.protocol !== "nostr+walletconnect:") return { ok: false, reason: "not_a_nwc_uri" };

  // `new URL` puts the wallet pubkey in the host position for this scheme.
  const walletPubkey = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (!HEX64.test(walletPubkey)) return { ok: false, reason: "malformed_wallet_pubkey" };

  const secret = (url.searchParams.get("secret") ?? "").toLowerCase();
  if (!HEX64.test(secret)) return { ok: false, reason: "malformed_secret" };

  const relays = url.searchParams.getAll("relay");
  if (relays.length === 0) return { ok: false, reason: "no_relay" };
  for (const relay of relays) {
    let parsed: URL;
    try {
      parsed = new URL(relay);
    } catch {
      return { ok: false, reason: "malformed_relay" };
    }
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      return { ok: false, reason: "malformed_relay" };
    }
  }

  return { ok: true, value: { walletPubkey, relays, secret } };
}

/**
 * Redact a URI for logs and error messages: keep the wallet pubkey (public) and
 * the relays, replace the secret entirely. Every log line and every thrown
 * message about NWC must pass through this.
 */
export function redactNwcUri(uri: string): string {
  const parsed = parseNwcUri(uri);
  if (!parsed.ok) return "nostr+walletconnect://<unparseable>";
  const relays = parsed.value.relays.map((r) => `relay=${r}`).join("&");
  return `nostr+walletconnect://${parsed.value.walletPubkey}?${relays}&secret=<redacted>`;
}

/** Methods this server may hold. Anything else is a wider credential than needed. */
export const ALLOWED_NWC_METHODS = new Set(["make_invoice", "get_info"]);

/** Methods that would let the credential move money. Never acceptable. */
export const SPEND_NWC_METHODS = new Set([
  "pay_invoice",
  "pay_keysend",
  "multi_pay_invoice",
  "multi_pay_keysend",
]);

export type PermissionVerdict =
  | { ok: true; verified: true; methods: string[] }
  | { ok: true; verified: false; reason: string }
  | { ok: false; reason: string };

/**
 * Judge the method list reported by the wallet service.
 *
 * `methods === null` means the service did not tell us (typically because
 * `get_info` itself is not permitted) — the caller must then fall back to the
 * documented manual check rather than assume the connection is safe.
 */
export function judgeNwcPermissions(methods: readonly string[] | null): PermissionVerdict {
  if (methods === null) {
    return {
      ok: true,
      verified: false,
      reason:
        "the wallet service did not report its permissions (get_info is not granted); " +
        "verify in Alby Hub that this connection is make_invoice only",
    };
  }

  const spend = methods.filter((m) => SPEND_NWC_METHODS.has(m));
  if (spend.length > 0) {
    return {
      ok: false,
      reason:
        `the NWC connection holds spending permission(s): ${spend.join(", ")} — ` +
        `refusing to start. Create a dedicated connection with make_invoice only.`,
    };
  }

  const unexpected = methods.filter((m) => !ALLOWED_NWC_METHODS.has(m));
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason:
        `the NWC connection permits method(s) this server never calls: ${unexpected.join(", ")} — ` +
        `refusing to start; the credential should be make_invoice only`,
    };
  }

  if (!methods.includes("make_invoice")) {
    return {
      ok: false,
      reason: "the NWC connection does not permit make_invoice, so no invoice can be minted",
    };
  }

  return { ok: true, verified: true, methods: [...methods] };
}
