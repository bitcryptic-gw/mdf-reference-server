/**
 * Which IP a per-client budget (and later the payment-attempt log) should key on.
 *
 * The deployment shape matters here, and it is not the "docker bridge" shape a
 * naive implementation assumes: Caddy runs on a **different host** (caddy-linode)
 * and reaches the server containers over the tailnet, setting
 * `header_up X-Real-IP {remote_host}`. So the transport peer is always Caddy's
 * tailnet address, and trusting `X-Real-IP` unconditionally would collapse every
 * visitor into one shared bucket — which is exactly what a per-client limit must
 * not do.
 *
 * The rule implemented here:
 *
 *   - trust `X-Real-IP` **only** when the peer address is in the configured
 *     trusted-proxy list;
 *   - the header must be a *single IP literal* — a comma-separated chain, a
 *     value with a port, or anything unparseable is ignored;
 *   - otherwise key on the peer address;
 *   - an empty list trusts nothing (the safe default: a direct-to-container
 *     deployment keys on the real peer).
 *
 * `X-Forwarded-For` is deliberately never read: its left-most entry is written by
 * the client, so keying on it hands the attacker control of the bucket they are
 * being limited by.
 */

import { isIP } from "node:net";

export type ClientKeySource = "header" | "peer" | "unknown";

export interface ClientKeyResult {
  key: string;
  source: ClientKeySource;
}

/**
 * Normalise an address for comparison and bucketing: trim, drop IPv6 brackets
 * and a zone id, and map IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to plain IPv4 so
 * the same client is not counted twice depending on how the connection arrived.
 */
export function normaliseIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) return null;
    s = s.slice(1, end);
  } else if (/^\[?[0-9a-fA-F:.]+\]:\d+$/.test(s)) {
    // `1.2.3.4:5678` or `[::1]:5678` — a peer with a port is not an IP literal.
    return null;
  }

  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];

  return isIP(s) ? s.toLowerCase() : null;
}

/** True when `peer` is one of the configured trusted proxies. */
export function isTrustedProxy(peer: string, trustedProxies: readonly string[]): boolean {
  const p = normaliseIp(peer);
  if (!p) return false;
  for (const candidate of trustedProxies) {
    if (normaliseIp(candidate) === p) return true;
  }
  return false;
}

/**
 * Resolve the bucketing key for a request.
 *
 * `trustedProxies` comes from config (`server.trusted_proxies`) and is validated
 * at startup as IP literals, so a typo cannot silently disable the trust list.
 */
export function resolveClientKey(params: {
  peer: string | null | undefined;
  forwardedForHeader?: string | null;
  trustedProxies?: readonly string[];
}): ClientKeyResult {
  const peer = normaliseIp(params.peer);
  const trusted = params.trustedProxies ?? [];

  if (peer && trusted.length > 0 && isTrustedProxy(peer, trusted)) {
    const fromHeader = normaliseIp(params.forwardedForHeader ?? null);
    if (fromHeader) return { key: fromHeader, source: "header" };
  }

  if (peer) return { key: peer, source: "peer" };
  return { key: "unknown", source: "unknown" };
}
