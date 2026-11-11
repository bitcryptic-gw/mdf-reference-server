/**
 * x402 v2 facilitator client: an ordered list of legs, one leg per request.
 *
 * **Topology (corrected 2026-11-12).** `x402.bitcryptic.com` is the **v1** pool
 * and the 0.3.0 server never calls it. Each 0.3.0 instance talks to the **v2
 * legs directly over the tailnet**, with the order set per instance:
 *
 *   mdf-server-syd   → [http://mdf-facilitator-syd:8080,   http://mdf-facilitator-public:8080]
 *   MDF-Server-Prod  → [http://mdf-facilitator-public:8080, http://mdf-facilitator-syd:8080]
 *
 * Two rules make that ordering safe rather than hopeful:
 *
 *   - **Fail over only on a connection or timeout error**, and only for
 *     `/verify`, which has no side effects and can be retried on another leg.
 *     Any answer from a leg — valid, invalid, or even an HTTP 500 with no
 *     verdict — pins that leg for the rest of the request.
 *   - **`/verify` and `/settle` use the same leg within a request.** That is the
 *     whole reason for the pin: the facilitator's pending-settlement store is
 *     per process, so a `/settle` that lands elsewhere cannot reconcile and may
 *     re-broadcast (step-0 §7).
 *
 * Because of that, `/settle` is never retried — not on `settlement_pending`
 * either. The upstream resource server retries once, which is safe for a single
 * facilitator process; here a retry could cross legs. Instead, `pending` is
 * reconciled against the transaction the facilitator returned, with the receipt
 * checked against the payment itself (see `confirmSuccessfulTransfer`).
 *
 * The 0.2.8 #52 contract is otherwise carried unchanged: a structured
 * `{isValid:false}` is a denial whatever the HTTP status, no verdict is an
 * outage, approval requires a `/settle` in this request, and the one recovery is
 * bound to the exact `(from, nonce)` `/verify` accepted here.
 */

import type { PaymentRequirement } from "./rails.ts";

export interface FacilitatorConfig {
  /** Ordered legs. First reachable leg serves the whole request. */
  legs: string[];
  timeoutMs: number;
  /** Optional JSON-RPC per CAIP-2 network, for on-chain confirmation. */
  rpc: Record<string, string>;
}

export interface Eip155ChainInfo {
  network: string;
  asset: string;
  /** JSON-RPC used by the on-chain checks; absent disables them. */
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

export interface VerifyRequest {
  x402Version: 2;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: PaymentRequirement;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface LegResponse {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

/** A transport failure (nothing usable came back) — the only failover trigger. */
class TransportError extends Error {}

async function postToLeg(
  leg: string,
  path: "/verify" | "/settle",
  body: unknown,
  timeoutMs: number
): Promise<LegResponse> {
  const url = `${leg.replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // DNS failure, connection refused, TLS error, or the abort timeout. Nothing
    // was decided, so /verify may move to the next leg.
    throw new TransportError((err as Error).message);
  }

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

/** The authorization a payload claims, or null when it carries none. */
export function authorizationFromPayload(payload: unknown): VerifiedAuthorization | null {
  const auth = (payload as {
    payload?: { authorization?: { from?: unknown; nonce?: unknown } };
  })?.payload?.authorization;
  if (auth && typeof auth.from === "string" && typeof auth.nonce === "string") {
    return { from: auth.from, nonce: auth.nonce };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-leg calls
// ---------------------------------------------------------------------------

function classifyVerify(
  res: LegResponse,
  request: VerifyRequest
): VerifyOutcome {
  // Structured denial — authoritative regardless of HTTP status.
  if (res.json && res.json.isValid === false) {
    const reason =
      typeof res.json.invalidReason === "string" ? res.json.invalidReason : "rejected";
    return { ok: false, kind: "invalid", reason };
  }
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

export interface VerifyOnLegResult {
  outcome: VerifyOutcome;
  /** True only when the leg never produced a response (safe to try the next). */
  transportFailure: boolean;
}

/** Call `/verify` on one leg. Side-effect free, so a transport retry is safe. */
export async function verifyOnLeg(
  leg: string,
  request: VerifyRequest,
  timeoutMs: number
): Promise<VerifyOnLegResult> {
  try {
    const res = await postToLeg(leg, "/verify", request, timeoutMs);
    return { outcome: classifyVerify(res, request), transportFailure: false };
  } catch (err) {
    return {
      outcome: { ok: false, kind: "error", reason: `facilitator unreachable: ${(err as Error).message}` },
      transportFailure: err instanceof TransportError,
    };
  }
}

/**
 * The facilitator legs, in order, with the leg pinned per request.
 */
export class FacilitatorPool {
  private readonly config: FacilitatorConfig;

  constructor(config: FacilitatorConfig) {
    if (config.legs.length === 0) throw new Error("facilitator needs at least one leg");
    this.config = config;
  }

  /** Ordered legs, for logging and /health. */
  get legs(): readonly string[] {
    return this.config.legs;
  }

  /**
   * `/verify` against the first leg that answers. Returns the leg that answered
   * so the caller can pin `/settle` to it; `leg` is the last tried when every
   * leg failed at the transport level.
   */
  async verify(request: VerifyRequest): Promise<{ outcome: VerifyOutcome; leg: string }> {
    let lastLeg = this.config.legs[0];
    let lastOutcome: VerifyOutcome = {
      ok: false,
      kind: "error",
      reason: "no facilitator leg answered",
    };
    for (const leg of this.config.legs) {
      lastLeg = leg;
      const result = await verifyOnLeg(leg, request, this.config.timeoutMs);
      lastOutcome = result.outcome;
      // A transport failure decided nothing, so the next leg may be tried.
      // Anything that answered — valid, invalid, or an HTTP error — pins this
      // leg for the rest of the request.
      if (!result.transportFailure) return { outcome: result.outcome, leg };
    }
    return { outcome: lastOutcome, leg: lastLeg };
  }

  /**
   * `/settle` on the pinned leg — **no failover**. A settle that landed on a
   * different leg could not reconcile a pending settlement and might
   * re-broadcast, so an unreachable pinned leg is an outage (503), not a reason
   * to try elsewhere.
   */
  async settle(
    leg: string,
    request: VerifyRequest,
    chain: Eip155ChainInfo,
    verified: VerifiedAuthorization,
    timing?: { attempts?: number; intervalMs?: number }
  ): Promise<SettleOutcome> {
    let res: LegResponse | null = null;
    try {
      res = await postToLeg(leg, "/settle", request, this.config.timeoutMs);
    } catch {
      res = null;
    }

    if (res?.json && res.json.success === true) {
      return {
        settled: true,
        payer: typeof res.json.payer === "string" ? res.json.payer : undefined,
        transaction: typeof res.json.transaction === "string" ? res.json.transaction : "",
        network: typeof res.json.network === "string" ? res.json.network : chain.network,
      };
    }

    const json = res?.json ?? {};
    const txHash =
      typeof json.transaction === "string" && json.transaction ? json.transaction : undefined;
    const reason =
      typeof json.errorReason === "string" ? json.errorReason : `settle HTTP ${res?.status ?? 0}`;

    // Broadcast, receipt not seen. Never re-post: confirm the transaction we were
    // told about against the payment terms.
    if (json.errorReason === "settlement_pending") {
      const confirmed = txHash
        ? await confirmSuccessfulTransfer(
            chain,
            txHash,
            {
              asset: chain.asset,
              from: verified.from,
              to: request.paymentRequirements.payTo,
              value: request.paymentRequirements.amount,
            },
            { nonce: verified.nonce, ...timing }
          )
        : "unknown";

      if (confirmed === "settled") {
        return {
          settled: true,
          payer: verified.from,
          transaction: txHash ?? "",
          network: chain.network,
        };
      }
      return {
        settled: false,
        kind: "error",
        reason: `settlement pending, not confirmed against the payment (${confirmed})`,
      };
    }

    // The facilitator may have settled and failed to tell us: confirm the exact
    // authorization /verify accepted here; fail closed when we cannot.
    const onchain = await confirmSettlementOnChain(chain, {
      txHash,
      from: verified.from,
      nonce: verified.nonce,
    });
    if (onchain === "settled") {
      return { settled: true, payer: verified.from, transaction: txHash ?? "", network: chain.network };
    }
    return { settled: false, kind: "error", reason };
  }

  /** Does any leg advertise `exact` on this network? */
  async supports(network: string): Promise<boolean | null> {
    let answered = false;
    for (const leg of this.config.legs) {
      try {
        const res = await fetch(`${leg.replace(/\/+$/, "")}/supported`, {
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          kinds?: Array<{ scheme?: string; network?: string; x402Version?: number }>;
        };
        if (!Array.isArray(body.kinds)) continue;
        answered = true;
        if (
          body.kinds.some(
            (k) => k?.scheme === "exact" && k?.network === network && k?.x402Version === 2
          )
        ) {
          return true;
        }
      } catch {
        // try the next leg
      }
    }
    return answered ? false : null;
  }
}

// ---------------------------------------------------------------------------
// On-chain confirmation
// ---------------------------------------------------------------------------

/** ERC-20 `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** authorizationState(address,bytes32) — EIP-3009, true once a nonce is used. */
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

interface ReceiptLog {
  address?: string;
  topics?: string[];
  data?: string;
}

export interface PaymentTerms {
  asset: string;
  from: string;
  to: string;
  /** Atomic amount, decimal string. */
  value: string;
}

/**
 * Does any log in the receipt show `asset` transferring exactly `value` from
 * `from` to `to`? Topic comparison is case-insensitive and padding-normalised;
 * the value is compared as a BigInt, so a 1000-vs-10000 slip cannot pass.
 */
export function receiptHasMatchingTransfer(
  logs: readonly ReceiptLog[],
  terms: PaymentTerms
): boolean {
  const asset = terms.asset.toLowerCase();
  const fromTopic = "0x" + leftPad32(terms.from.replace(/^0x/, "").toLowerCase());
  const toTopic = "0x" + leftPad32(terms.to.replace(/^0x/, "").toLowerCase());

  let expected: bigint;
  try {
    expected = BigInt(terms.value);
  } catch {
    return false;
  }

  for (const log of logs) {
    if (typeof log.address !== "string" || log.address.toLowerCase() !== asset) continue;
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length < 3) continue;
    if ((topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((topics[1] ?? "").toLowerCase() !== fromTopic) continue;
    if ((topics[2] ?? "").toLowerCase() !== toTopic) continue;
    if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) continue;
    try {
      if (BigInt(log.data) === expected) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Poll a receipt for a transaction the facilitator says it broadcast, and
 * accept it only when it can be tied to **this** payment.
 *
 * A successful (`status: 0x1`) receipt is not enough on its own: the hash comes
 * from the facilitator, so any successful transaction — an unrelated transfer,
 * the wrong amount, a different payer — would otherwise be accepted as payment.
 * Accepted evidence, in order:
 *
 *   1. a `Transfer` log from the configured asset contract with the verified
 *      `from`, the offer's `payTo` and the offer's exact atomic `value`;
 *   2. `authorizationState(from, nonce) == true`, i.e. the exact EIP-3009
 *      authorization `/verify` accepted in this request was consumed (the nonce
 *      is inside the signature, so this cannot be another payment).
 *
 * Anything else — including a receipt we never see — is `not_settled`/`unknown`,
 * and the caller answers 503.
 */
export async function confirmSuccessfulTransfer(
  chain: Eip155ChainInfo,
  txHash: string,
  terms: PaymentTerms,
  options: { nonce?: string; attempts?: number; intervalMs?: number } = {}
): Promise<"settled" | "not_settled" | "unknown"> {
  if (!chain.rpcUrl) return "unknown";
  const attempts = options.attempts ?? 6;
  const intervalMs = options.intervalMs ?? 2000;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const receipt = (await rpcCall(
        chain.rpcUrl,
        "eth_getTransactionReceipt",
        [txHash],
        8000
      )) as { status?: string; logs?: ReceiptLog[] } | null;

      if (receipt) {
        if (receipt.status === "0x1" && receiptHasMatchingTransfer(receipt.logs ?? [], terms)) {
          return "settled";
        }
        // A receipt that does not show our transfer settles nothing by itself.
        // Fall back to the nonce binding when we have one — a consumed nonce
        // proves the exact signed authorization executed, whatever the log shape.
        if (options.nonce) {
          const used = await authorizationUsed(chain, terms.from, options.nonce);
          if (used === "settled") return "settled";
          if (used === "not_settled") return "not_settled";
        }
        return "not_settled";
      }
      // No receipt yet — the transaction may still be pending.
    } catch {
      // Keep polling until the window closes.
    }
  }
  return "unknown";
}

/** `authorizationState(from, nonce)` on the asset contract. */
export async function authorizationUsed(
  chain: Eip155ChainInfo,
  from: string,
  nonce: string
): Promise<"settled" | "not_settled" | "unknown"> {
  if (!chain.rpcUrl) return "unknown";
  try {
    const data =
      AUTHORIZATION_STATE_SELECTOR +
      leftPad32(from.replace(/^0x/, "").toLowerCase()) +
      leftPad32(nonce.replace(/^0x/, "").toLowerCase());
    const result = (await rpcCall(
      chain.rpcUrl,
      "eth_call",
      [{ to: chain.asset, data }, "latest"],
      8000
    )) as string | undefined;
    if (typeof result === "string" && result.length >= 3) {
      return result.slice(-1) === "1" ? "settled" : "not_settled";
    }
    return "not_settled";
  } catch {
    return "unknown";
  }
}

/**
 * Settle-error recovery: a receipt if the facilitator gave a hash, else the
 * nonce state, for the exact authorization `/verify` accepted in this request.
 * "unknown" on any RPC failure, so infrastructure trouble is never a denial.
 */
export async function confirmSettlementOnChain(
  chain: Eip155ChainInfo,
  params: { txHash?: string; from: string; nonce: string }
): Promise<"settled" | "not_settled" | "unknown"> {
  if (!chain.rpcUrl) return "unknown";
  try {
    if (params.txHash) {
      const receipt = (await rpcCall(
        chain.rpcUrl,
        "eth_getTransactionReceipt",
        [params.txHash],
        8000
      )) as { status?: string } | null;
      if (receipt) {
        if (receipt.status !== "0x1") return "not_settled";
        // A successful tx is only evidence through the nonce: the hash came from
        // the facilitator, so the receipt alone says nothing about our payment.
        return authorizationUsed(chain, params.from, params.nonce);
      }
    }
    return authorizationUsed(chain, params.from, params.nonce);
  } catch {
    return "unknown";
  }
}
