/**
 * Invoice-mint rate limiting (scope item 11).
 *
 * Minting a BOLT11 invoice costs receiver-node resources, and every 402 on a
 * lightning route mints one. Two buckets guard it:
 *
 *   - **global** (default 180/min, burst 60) — a ceiling on total minting;
 *   - **per client** (default 24/min, burst 8) — so one caller cannot spend the
 *     global budget.
 *
 * Numbers are sized against the monitoring load: two Kuma `lnbtc offered`
 * probes at one per 5 minutes are 0.4 mints/min, 0.2% of the global bucket, and
 * 1.7% of one client's. With both monitors retuned to 60 s it is 1.1% global
 * and 8.3% of one client's — still under the 10% ceiling, which is why the
 * per-client refill is 24/min rather than 12.
 * A probe spends its own client budget, so it can never exhaust a real user's.
 *
 * Exhaustion is not an error: the caller omits the lnbtc rail from that 402
 * exactly as if it were degraded, and the other rails are unaffected.
 *
 * State is in-process and per instance on purpose. This is a DoS guard, not an
 * accounting boundary; a shared counter would let one noisy client stop invoice
 * minting for everyone, which is the failure mode it exists to prevent.
 */

export interface BucketOptions {
  /** Maximum tokens (burst). */
  capacity: number;
  /** Tokens added per minute. */
  perMinute: number;
}

export interface TakeResult {
  ok: boolean;
  /** Which bucket refused, when it did. */
  scope?: "global" | "client";
  /** Seconds until at least one token is available in the refusing bucket. */
  retryAfterSeconds?: number;
}

/**
 * A single token bucket. Tokens refill continuously at `perMinute / 60_000` per
 * millisecond, so a client that mints steadily is never punished for a burst
 * earlier in the same minute.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(options: BucketOptions, nowMs: number = Date.now()) {
    if (!Number.isFinite(options.capacity) || options.capacity < 1) {
      throw new Error("bucket capacity must be >= 1");
    }
    if (!Number.isFinite(options.perMinute) || options.perMinute <= 0) {
      throw new Error("bucket refill must be > 0 per minute");
    }
    this.capacity = options.capacity;
    this.perMs = options.perMinute / 60_000;
    this.tokens = options.capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perMs);
    this.lastRefillMs = nowMs;
  }

  /** Consume one token if available. */
  take(nowMs: number = Date.now()): TakeResult {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const needed = 1 - this.tokens;
    return { ok: false, retryAfterSeconds: Math.ceil(needed / this.perMs / 1000) };
  }

  /** Tokens currently available (tests, /health diagnostics). */
  available(nowMs: number = Date.now()): number {
    this.refill(nowMs);
    return this.tokens;
  }
}

/** A keyed set of buckets that forgets idle clients. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastSeenMs: number }>();
  private readonly options: BucketOptions;
  private readonly maxKeys: number;

  constructor(options: BucketOptions, maxKeys = 10_000) {
    this.options = options;
    this.maxKeys = maxKeys;
  }

  take(key: string, nowMs: number = Date.now()): TakeResult {
    this.evictIfNeeded(nowMs);
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.options, nowMs), lastSeenMs: nowMs };
      this.buckets.set(key, entry);
    }
    entry.lastSeenMs = nowMs;
    return entry.bucket.take(nowMs);
  }

  size(): number {
    return this.buckets.size;
  }

  /**
   * Drop buckets that have fully refilled and not been seen for a while. A
   * refilled bucket is indistinguishable from a fresh one, so forgetting it
   * loses nothing — and keeps a scan across many addresses from growing the map
   * without bound.
   */
  private evictIfNeeded(nowMs: number): void {
    if (this.buckets.size < this.maxKeys) return;
    const refillMs = (this.options.capacity / this.options.perMinute) * 60_000;
    for (const [key, entry] of this.buckets) {
      const idleFor = nowMs - entry.lastSeenMs;
      if (idleFor > refillMs && entry.bucket.available(nowMs) >= this.options.capacity) {
        this.buckets.delete(key);
      }
      if (this.buckets.size < this.maxKeys * 0.9) break;
    }
  }
}

export interface MintLimiterOptions {
  global: BucketOptions;
  perClient: BucketOptions;
}

/**
 * The two-bucket gate around invoice minting. Global is checked first: when the
 * whole deployment is at its ceiling, a per-client refusal would be a misleading
 * explanation of the same condition.
 */
export class MintLimiter {
  private readonly global: TokenBucket;
  private readonly clients: KeyedBuckets;

  constructor(options: MintLimiterOptions, nowMs: number = Date.now()) {
    this.global = new TokenBucket(options.global, nowMs);
    this.clients = new KeyedBuckets(options.perClient);
  }

  tryTake(clientKey: string, nowMs: number = Date.now()): TakeResult {
    const global = this.global.take(nowMs);
    if (!global.ok) {
      return { ok: false, scope: "global", retryAfterSeconds: global.retryAfterSeconds };
    }
    const client = this.clients.take(clientKey, nowMs);
    if (!client.ok) {
      return { ok: false, scope: "client", retryAfterSeconds: client.retryAfterSeconds };
    }
    return { ok: true };
  }

  /** Available global tokens (tests/diagnostics). */
  globalAvailable(nowMs: number = Date.now()): number {
    return this.global.available(nowMs);
  }

  clientCount(): number {
    return this.clients.size();
  }
}

export const DEFAULT_MINT_LIMITS: MintLimiterOptions = {
  global: { capacity: 60, perMinute: 180 },
  perClient: { capacity: 8, perMinute: 24 },
};
