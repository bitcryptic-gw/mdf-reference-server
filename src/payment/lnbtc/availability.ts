/**
 * Whether the lnbtc rail may be offered, and why.
 *
 * The startup permission check has three outcomes and they must not be
 * conflated:
 *
 *   - **pass** — the wallet answered and permits only `make_invoice` (+ the
 *     `get_info` we used to ask), so the rail is available;
 *   - **bad credential** — the wallet answered and reported a spending or
 *     unexpected method. That is an operator misconfiguration with a security
 *     consequence, so the process **refuses to start**;
 *   - **unreachable** — the relay or the wallet could not be reached at all.
 *     That is a transient dependency failure, not a misconfiguration, so the
 *     process **starts normally** with the lnbtc rail degraded (omitted from
 *     `accepts[]`), and the permission check is retried on the invoice breaker's
 *     timed backoff until it passes.
 *
 * The distinction is the whole point: a relay outage must never take down USDC
 * payments, free content or `/health`, and a credential that can spend money must
 * never be tolerated just because it happens to be reachable.
 */

import { NwcError } from "./nwc.ts";
import { judgeNwcPermissions } from "./nwc-uri.ts";

export type NwcCheck =
  | { status: "pass"; methods: string[]; unverified: boolean; pubkey?: string }
  | { status: "bad_credential"; reason: string }
  | { status: "unreachable"; reason: string };

export interface NwcInfoSource {
  getInfo(): Promise<{ methods: string[] | null; pubkey?: string }>;
}

/**
 * Run the permission check once.
 *
 * `auth` from the wallet (a restricted or unauthorised method) is a credential
 * problem; every other failure — unreachable relay, timeout, malformed response
 * — is treated as unavailability. Nothing here throws: the caller decides, based
 * on its stage (startup vs background retry).
 */
export async function checkNwcConnection(client: NwcInfoSource): Promise<NwcCheck> {
  let info: { methods: string[] | null; pubkey?: string };
  try {
    info = await client.getInfo();
  } catch (err) {
    if (err instanceof NwcError && err.kind === "auth") {
      return { status: "bad_credential", reason: err.message };
    }
    return { status: "unreachable", reason: (err as Error).message };
  }

  const verdict = judgeNwcPermissions(info.methods);
  if (!verdict.ok) return { status: "bad_credential", reason: verdict.reason };
  const pubkey = info.pubkey && /^(02|03)[0-9a-f]{64}$/.test(info.pubkey) ? info.pubkey : undefined;
  if (!verdict.verified) {
    // Answered, but did not report a method list. The connection may well be
    // fine; it simply cannot be proven automatically.
    return { status: "pass", methods: [], unverified: true, ...(pubkey ? { pubkey } : {}) };
  }
  return { status: "pass", methods: verdict.methods, unverified: false, ...(pubkey ? { pubkey } : {}) };
}

export type LnbtcStatus = "disabled" | "available" | "degraded";

export interface LnbtcSnapshot {
  status: LnbtcStatus;
  /** Present when degraded: only "unreachable" reaches a public body. */
  category?: "unreachable";
  since?: string;
  reason?: string;
  unverified?: boolean;
}

export interface GateOptions {
  enabled: boolean;
  now?: () => number;
}

/**
 * The lnbtc rail's availability, as the 402 builder and `/health` see it.
 *
 * `startLnbtc()` performs the startup check and returns a gate; the breaker's
 * probe applies later checks with `applyCheck()`, so recovery needs no restart.
 */
export class LnbtcGate {
  private status: LnbtcStatus;
  private sinceMs: number | null = null;
  private reason?: string;
  private unverified = false;
  private readonly now: () => number;

  constructor(options: GateOptions) {
    this.now = options.now ?? Date.now;
    this.status = options.enabled ? "degraded" : "disabled";
    if (options.enabled) this.sinceMs = this.now();
  }

  /** May the lnbtc rail appear in `accepts[]`? */
  canOffer(): boolean {
    return this.status === "available";
  }

  /** Whether NWC is configured at all — false means "never call the wallet". */
  get enabled(): boolean {
    return this.status !== "disabled";
  }

  /** Apply a check result. Returns true when the rail became available. */
  applyCheck(result: NwcCheck): boolean {
    if (this.status === "disabled") return false;

    if (result.status === "pass") {
      const wasAvailable = this.status === "available";
      this.status = "available";
      this.sinceMs = null;
      this.reason = undefined;
      this.unverified = result.unverified;
      return !wasAvailable;
    }

    if (result.status === "unreachable") {
      this.status = "degraded";
      this.sinceMs = this.sinceMs ?? this.now();
      this.reason = result.reason;
      return false;
    }

    // bad_credential: never silently degrade — the caller refuses to start at
    // boot, and at runtime it disables the rail rather than pretending it is a
    // transient fault (the credential will not fix itself).
    this.status = "degraded";
    this.sinceMs = this.sinceMs ?? this.now();
    this.reason = result.reason;
    return false;
  }

  /** Coarse snapshot for `/health`. No secret, no URI, no upstream detail. */
  snapshot(): LnbtcSnapshot {
    if (this.status === "disabled") return { status: "disabled" };
    if (this.status === "available") {
      return this.unverified
        ? { status: "available", unverified: true }
        : { status: "available" };
    }
    return {
      status: "degraded",
      category: "unreachable",
      ...(this.sinceMs !== null ? { since: new Date(this.sinceMs).toISOString() } : {}),
    };
  }
}

export class CredentialRefusedError extends Error {
  constructor(reason: string) {
    super(
      `mdf-server: refusing to start — the NWC connection permits more than invoice minting: ${reason}`
    );
    this.name = "CredentialRefusedError";
  }
}

export interface StartLnbtcOptions {
  enabled: boolean;
  /** Absent when lnbtc is disabled; required when enabled. */
  client?: NwcInfoSource | null;
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * Startup wiring.
 *
 * - disabled ⇒ no NWC call at all, rail never offered;
 * - enabled + bad credential ⇒ throws `CredentialRefusedError` (fail loudly);
 * - enabled + unreachable ⇒ a degraded gate, and the caller schedules the retry
 *   on the breaker's backoff;
 * - enabled + pass ⇒ available immediately.
 */
export async function startLnbtc(options: StartLnbtcOptions): Promise<LnbtcGate> {
  const gate = new LnbtcGate({ enabled: options.enabled, now: options.now });

  if (!options.enabled) return gate;

  if (!options.client) {
    gate.applyCheck({ status: "unreachable", reason: "no NWC client configured" });
    return gate;
  }

  const result = await checkNwcConnection(options.client);
  options.onCheck?.(result);
  if (result.status === "bad_credential") throw new CredentialRefusedError(result.reason);

  gate.applyCheck(result);
  if (result.status === "unreachable") {
    options.log?.(
      `[mdf:lnbtc] wallet unreachable at startup (${result.reason}); ` +
        `the lnbtc rail is degraded and will be retried on the invoice breaker's backoff`
    );
  }
  return gate;
}
