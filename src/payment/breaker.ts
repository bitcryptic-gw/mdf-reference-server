/**
 * Lightning invoice-creation circuit breaker.
 *
 * Backend-agnostic by design: it knows only about failure *categories* and an
 * injected `probe` callback, never about Alby. A future pluggable invoice
 * backend (Vikunja #46) reuses this unchanged — it only has to throw a
 * categorised `LightningFailure` or hand one back from its probe.
 *
 * Responsibilities:
 *   - open on the first real invoice-creation failure and stop calling the
 *     backend on every subsequent 402 (so each request does not pay a timeout);
 *   - run a single probe at a time on a timer with exponential backoff, a cap
 *     and jitter, so a transient fault recovers with no inbound traffic;
 *   - expose a coarse snapshot for /health (category + timestamps only — never
 *     the upstream message);
 *   - emit a structured log line on the open transition, at the slow cap, and
 *     on recovery — never one line per suppressed attempt.
 *
 * State is in-memory and per-process. After a restart the breaker is closed
 * and rediscovers a persisting fault on the first attempt.
 */

export type LightningFailureCategory = "rejected" | "auth" | "unreachable" | "unknown";

export interface LightningFailure {
  category: LightningFailureCategory;
  /** Upstream HTTP status, when there was one (null for network/timeout). */
  upstreamStatus: number | null;
  /** Sanitised, truncated upstream message. NEVER exposed in a public body. */
  upstreamMessage: string;
}

export interface BreakerSnapshot {
  status: "ok" | "degraded";
  /** ISO timestamp the breaker opened. Present only when degraded. */
  since?: string;
  category?: LightningFailureCategory;
  /** ISO timestamp of the next scheduled probe. Present only when degraded. */
  next_retry?: string;
}

export interface BreakerProbeState {
  /** Category of the last failure, or null if none recorded. */
  category: LightningFailureCategory | null;
  /** Epoch ms the breaker opened, or null. */
  since: number | null;
}

interface TimerHandle {
  unref?: () => void;
}

export interface LightningBreakerOptions {
  /** First retry delay (ms). Must be > 0. */
  initialBackoffMs: number;
  /** Backoff cap (ms). Must be >= initialBackoffMs. */
  maxBackoffMs: number;
  /** Jitter as a fraction of the delay (0.2 = ±20%). Default 0.2. */
  jitterRatio?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable scheduler (tests). */
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable canceller (tests). */
  cancel?: (timer: TimerHandle) => void;
  /** Injectable RNG (tests). */
  random?: () => number;
  /**
   * Runs on the retry timer. Returns null when the backend is healthy again,
   * or a LightningFailure when it is still failing. Must never throw.
   */
  probe: (state: BreakerProbeState) => Promise<LightningFailure | null>;
  /** Structured log sink. */
  log?: (entry: Record<string, unknown>) => void;
}

export class LightningBreaker {
  private open = false;
  private sinceMs = 0;
  private failureCount = 0;
  private category: LightningFailureCategory | null = null;
  private upstreamStatus: number | null = null;
  private upstreamMessage = "";
  private nextRetryMs = 0;
  private timer: TimerHandle | null = null;
  private probeInFlight = false;
  private stopped = false;

  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly cancel: (timer: TimerHandle) => void;
  private readonly random: () => number;
  private readonly jitterRatio: number;

  constructor(private readonly options: LightningBreakerOptions) {
    if (!(options.initialBackoffMs > 0)) {
      throw new Error("lightning breaker: initialBackoffMs must be > 0");
    }
    if (!(options.maxBackoffMs >= options.initialBackoffMs)) {
      throw new Error("lightning breaker: maxBackoffMs must be >= initialBackoffMs");
    }
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.cancel =
      options.cancel ??
      ((timer) => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Coarse state for /health. Never carries the upstream message. */
  snapshot(): BreakerSnapshot {
    if (!this.open) return { status: "ok" };
    return {
      status: "degraded",
      since: new Date(this.sinceMs).toISOString(),
      category: this.category ?? "unknown",
      next_retry: new Date(this.nextRetryMs).toISOString(),
    };
  }

  /** Last recorded failure, for the suppressed-request path. */
  lastFailure(): LightningFailure {
    return {
      category: this.category ?? "unknown",
      upstreamStatus: this.upstreamStatus,
      upstreamMessage: this.upstreamMessage,
    };
  }

  /** Seconds until the next probe, or null when closed. Min 1. */
  retryAfterSeconds(): number | null {
    if (!this.open) return null;
    return Math.max(1, Math.ceil((this.nextRetryMs - this.now()) / 1000));
  }

  /**
   * Record a failure from a real (non-probe) request. Opens the breaker and
   * logs the transition once; a repeated call while already open is treated
   * as a probe failure so it cannot spam the log.
   */
  recordFailure(failure: LightningFailure, context?: { path?: string }): void {
    if (this.stopped) return;
    const wasOpen = this.open;
    this.category = failure.category;
    this.upstreamStatus = failure.upstreamStatus;
    this.upstreamMessage = failure.upstreamMessage;

    if (!wasOpen) {
      this.open = true;
      this.sinceMs = this.now();
      this.failureCount = 0;
      this.log({
        event: "lightning_breaker_open",
        category: failure.category,
        upstream_status: failure.upstreamStatus,
        upstream_message: failure.upstreamMessage,
        ...(context?.path ? { path: context.path } : {}),
      });
    }

    this.scheduleNextProbe(wasOpen);
  }

  /** Stop the breaker and clear any armed timer (graceful shutdown). */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  // -------------------------------------------------------------------------

  private scheduleNextProbe(reminder: boolean): void {
    this.failureCount += 1;
    const base = this.backoffBase();
    const delay = this.jittered(base);
    this.nextRetryMs = this.now() + delay;

    // A repeated reminder is only worth a line once the backoff has reached its
    // cap — before that the next attempt is only seconds away.
    if (reminder && base >= this.options.maxBackoffMs) {
      this.log({
        event: "lightning_breaker_reminder",
        category: this.category,
        upstream_status: this.upstreamStatus,
        upstream_message: this.upstreamMessage,
        retry_in_ms: delay,
      });
    }

    this.arm(delay);
  }

  private backoffBase(): number {
    const exponent = Math.min(this.failureCount - 1, 30);
    const raw = this.options.initialBackoffMs * Math.pow(2, exponent);
    return Math.min(raw, this.options.maxBackoffMs);
  }

  private jittered(base: number): number {
    const factor = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return Math.max(0, Math.round(base * factor));
  }

  private arm(delay: number): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = this.schedule(() => {
      void this.runProbe();
    }, delay);
    this.timer?.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private async runProbe(): Promise<void> {
    if (this.stopped || this.probeInFlight || !this.open) return;
    this.probeInFlight = true;
    this.timer = null;
    try {
      const failure = await this.options.probe({
        category: this.category,
        since: this.sinceMs,
      });
      if (failure === null) {
        this.recordSuccess();
      } else {
        this.category = failure.category;
        this.upstreamStatus = failure.upstreamStatus;
        this.upstreamMessage = failure.upstreamMessage;
        this.scheduleNextProbe(true);
      }
    } catch (err) {
      // The probe contract says it must not throw, but a bug there must not
      // leave the breaker permanently closed with no retry scheduled.
      this.category = "unknown";
      this.upstreamStatus = null;
      this.upstreamMessage = (err as Error)?.message?.slice(0, 120) ?? "probe error";
      this.scheduleNextProbe(true);
    } finally {
      this.probeInFlight = false;
    }
  }

  private recordSuccess(): void {
    if (!this.open) return;
    const outageMs = this.now() - this.sinceMs;
    this.open = false;
    this.clearTimer();
    this.log({
      event: "lightning_breaker_closed",
      outage_ms: outageMs,
      category: this.category,
    });
    this.category = null;
    this.upstreamStatus = null;
    this.upstreamMessage = "";
    this.failureCount = 0;
    this.nextRetryMs = 0;
    this.sinceMs = 0;
  }

  private log(entry: Record<string, unknown>): void {
    this.options.log?.(entry);
  }
}
