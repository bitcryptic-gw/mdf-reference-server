/**
 * x402 v2 facilitator client (exact/eip155).
 *
 * Three calls, all optional at runtime: `/supported` (a startup sanity probe),
 * `/verify`, `/settle`. v2 carries the same body the client sent — the whole
 * `PaymentPayload` — plus the exact requirements the server offered.
 *
 * The 0.2.8 #52 contract is preserved verbatim, and is the reason this file is
 * written conservatively rather than cleverly:
 *
 *  - a `/verify` that returns a structured `{isValid:false}` is a payment
 *    denial → the caller answers 402, whatever the HTTP status (x402-rs uses
 *    both 400 and 500 for denials);
 *  - a `/verify` with **no** structured verdict is a facilitator failure → the
 *    caller answers 503, never a payment denial. An unreachable facilitator must
 *    not tell a payer their payment was rejected;
 *  - approval requires a successful `/settle` **in this request**. There is no
 *    fallback that approves on the strength of a prior on-chain settlement;
 *  - the one recovery is a `/settle` error, confirmed on-chain for the exact
 *    `(from, nonce)` that `/verify` accepted here, and failing closed to 503.
 *
 * v2 adds one state 0.2.x never had: `settlement_pending` (non-terminal, with a
 * broadcast tx). The upstream resource server retries exactly once, so we do the
 * same, then treat the outcome as settled or as a failure.
 */

import type { PaymentRequirement } from "./rails.ts";

export interface FacilitatorConfig {
  /** Base URL of a v2 facilitator exposing /verify, /settle and /supported. */
  url: string;
  timeoutMs: number;
  /** Optional JSON-RPC per CAIP-2 network, for the settle-error recovery. */
  rpc: Record<string, string>;
}

export interface Eip155ChainInfo {
  network: string;
  asset: string;
  /** JSON-RPC used by the on-chain recovery; absent disables it. */
  rpcUrl?: string;
}

export interface VerifiedAuthorization {
  from: string;
  nonce: string;
}

export type VerifyOutcome =
  | { ok: true; payer?: string; authorization: VerifiedAuthorization }
  | { ok: false; kind: "invalid"; reason: string }
  | { ok: false; kind: "error"; reason: string };

export type SettleOutcome =
  | { settled: true; payer?: string; transaction: string; network: string }
  | { settled: false; kind: "error"; reason: string };

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function post(
  config: FacilitatorConfig,
  path: "/verify" | "/settle",
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const url = `${config.url.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** The v2 wire body: the client's payload plus the requirements we offered. */
export interface VerifyRequest {
  x402Version: 2;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: PaymentRequirement;
}

/** The authorization a payload claims, or null when it carries none. */
export function authorizationFromPayload(
  payload: unknown
): VerifiedAuthorization | null {
  const auth = (payload as {
    payload?: { authorization?: { from?: unknown; nonce?: unknown } };
  })?.payload?.authorization;
  if (auth && typeof auth.from === "string" && typeof auth.nonce === "string") {
    return { from: auth.from, nonce: auth.nonce };
  }
  return null;
}

// ---------------------------------------------------------------------------
// /verify
// ---------------------------------------------------------------------------

export async function facilitatorVerify(
  config: FacilitatorConfig,
  request: VerifyRequest
): Promise<VerifyOutcome> {
  let res: Awaited<ReturnType<typeof post>>;
  try {
    res = await post(config, "/verify", request);
  } catch (err) {
    return { ok: false, kind: "error", reason: `facilitator unreachable: ${(err as Error).message}` };
  }

  // Structured denial — authoritative regardless of HTTP status.
  if (res.json && res.json.isValid === false) {
    const reason =
      typeof res.json.invalidReason === "string" ? res.json.invalidReason : "rejected";
    return { ok: false, kind: "invalid", reason };
  }

  // No structured verdict → outage, not a denial.
  if (res.status !== 200) {
    return { ok: false, kind: "error", reason: `facilitator /verify HTTP ${res.status}` };
  }
  if (!res.json || res.json.isValid !== true) {
    return { ok: false, kind: "error", reason: "facilitator /verify returned no verdict" };
  }

  const authorization = authorizationFromPayload(request.paymentPayload);
  if (!authorization) {
    return {
      ok: false,
      kind: "error",
      reason: "facilitator accepted a payload carrying no authorization",
    };
  }
  return {
    ok: true,
    payer: typeof res.json.payer === "string" ? res.json.payer : undefined,
    authorization,
  };
}

// ---------------------------------------------------------------------------
// /settle
// ---------------------------------------------------------------------------

/**
 * Call `/settle`, retrying once on `settlement_pending`, and on any non-success
 * confirm on-chain for the authorization `/verify` accepted **in this request**.
 */
export async function facilitatorSettle(
  config: FacilitatorConfig,
  request: VerifyRequest,
  chain: Eip155ChainInfo,
  verified: VerifiedAuthorization
): Promise<SettleOutcome> {
  let last: Awaited<ReturnType<typeof post>> | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await post(config, "/settle", request);
    } catch (err) {
      last = null;
      if (attempt === 1) {
        return { settled: false, kind: "error", reason: `facilitator unreachable: ${(err as Error).message}` };
      }
      continue;
    }

    const json = last.json ?? {};
    if (json.success === true) {
      return {
        settled: true,
        payer: typeof json.payer === "string" ? json.payer : undefined,
        transaction: typeof json.transaction === "string" ? json.transaction : "",
        network: typeof json.network === "string" ? json.network : chain.network,
      };
    }

    // Non-terminal: the transaction is broadcast but the receipt was not seen.
    // Retry exactly once, as the upstream resource server does.
    if (json.errorReason === "settlement_pending" && attempt === 0) continue;
    break;
  }

  const json = last?.json ?? {};
  const txHash = typeof json.transaction === "string" ? json.transaction : undefined;
  const reason =
    typeof json.errorReason === "string" ? json.errorReason : `settle HTTP ${last?.status ?? 0}`;

  // The facilitator may have settled and failed to tell us. Confirm the exact
  // authorization /verify accepted here; fail closed when we cannot.
  const onchain = await confirmSettlementOnChain(chain, {
    txHash,
    from: verified.from,
    nonce: verified.nonce,
  });
  if (onchain === "settled") {
    return {
      settled: true,
      payer: verified.from,
      transaction: txHash ?? "",
      network: chain.network,
    };
  }
  return { settled: false, kind: "error", reason };
}

/**
 * Startup probe: does the facilitator advertise `exact` on this network?
 * Returns null when the facilitator is unreachable (a warning, not a failure —
 * the rail's own breaker decides what to do at request time).
 */
export async function facilitatorSupports(
  config: FacilitatorConfig,
  network: string
): Promise<boolean | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/+$/, "")}/supported`, {
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      kinds?: Array<{ scheme?: string; network?: string; x402Version?: number }>;
    };
    if (!Array.isArray(body.kinds)) return null;
    return body.kinds.some(
      (k) => k?.scheme === "exact" && k?.network === network && k?.x402Version === 2
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// On-chain confirmation (settle-error recovery only)
// ---------------------------------------------------------------------------

// authorizationState(address,bytes32) — EIP-3009, returns whether a nonce is used.
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
 * Whether a specific EIP-3009 authorization was consumed on-chain: the tx
 * receipt if a hash was returned, else the token's `authorizationState`.
 * "unknown" on any RPC failure, so infrastructure trouble is never read as a
 * payment denial.
 */
export async function confirmSettlementOnChain(
  chain: Eip155ChainInfo,
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
      if (receipt) return receipt.status === "0x1" ? "settled" : "not_settled";
    }
    const data =
      AUTHORIZATION_STATE_SELECTOR +
      leftPad32(params.from.replace(/^0x/, "").toLowerCase()) +
      leftPad32(params.nonce.replace(/^0x/, "").toLowerCase());
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
  } catch {
    return "unknown";
  }
}
