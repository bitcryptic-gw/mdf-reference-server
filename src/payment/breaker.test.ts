/**
 * Lightning circuit-breaker unit tests (Vikunja #44)
 *
 * The breaker owns the time-based behaviour: open-on-failure, a single probe in
 * flight, exponential backoff with a cap, automatic recovery with no inbound
 * traffic, and log discipline (open transition once, a reminder at the slow cap,
 * recovery once — never a line per suppressed attempt). A fake scheduler and
 * clock make every one of those deterministic; no real timers are used.
 *
 * Run with: bun run src/payment/breaker.test.ts
 */

import { LightningBreaker, type LightningFailure } from "./breaker.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
  }
}

/** Flush the microtask queue a few times so an awaited probe settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const FAIL: LightningFailure = {
  category: "unreachable",
  upstreamStatus: null,
  upstreamMessage: "connect ECONNREFUSED",
};

const AUTH_FAIL: LightningFailure = {
  category: "auth",
  upstreamStatus: 401,
  upstreamMessage: "unauthorized",
};

// ---------------------------------------------------------------------------
// Fake scheduler
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  at: number;
  ms: number;
  fn: () => void;
  cancelled: boolean;
  unref(): void;
}

class FakeScheduler {
  nowMs = 1_000_000;
  readonly delays: number[] = [];
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now = () => this.nowMs;

  schedule = (fn: () => void, ms: number): FakeTimer => {
    const timer: FakeTimer = {
      id: this.nextId++,
      at: this.nowMs + ms,
      ms,
      fn,
      cancelled: false,
      unref() {},
    };
    this.delays.push(ms);
    this.timers.push(timer);
    return timer;
  };

  cancel = (timer: FakeTimer): void => {
    timer.cancelled = true;
  };

  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /** Fire every timer due within `ms`, in time order; then advance the clock. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.nowMs = due.at;
      this.timers = this.timers.filter((t) => t !== due);
      due.fn();
      await flush();
    }
    this.nowMs = target;
  }
}

function makeLog() {
  const entries: Record<string, unknown>[] = [];
  return { entries, log: (e: Record<string, unknown>) => entries.push(e) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nLightning breaker — open / suppress\n");

await test("starts closed and healthy", () => {
  const s = new FakeScheduler();
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 300000,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => null,
  });
  assertEquals(b.isOpen(), false, "closed");
  assertEquals(b.snapshot().status, "ok", "healthy snapshot");
  assertEquals(b.retryAfterSeconds(), null, "no retry when closed");
});

await test("opens on failure, records the category and arms one probe", () => {
  const s = new FakeScheduler();
  const { entries, log } = makeLog();
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 300000,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => null,
    log,
  });
  b.recordFailure(FAIL, { path: "/micropayment/intro" });

  assertEquals(b.isOpen(), true, "open");
  const snap = b.snapshot();
  assertEquals(snap.status, "degraded", "degraded");
  assertEquals(snap.category, "unreachable", "category");
  assert(!!snap.since, "since present");
  assert(!!snap.next_retry, "next_retry present");
  assertEquals(s.pending(), 1, "exactly one probe armed");
  assertEquals(entries.length, 1, "one log line");
  assertEquals(entries[0].event, "lightning_breaker_open", "open event");
  assertEquals(entries[0].path, "/micropayment/intro", "route logged");
  assertEquals(entries[0].upstream_message, "connect ECONNREFUSED", "sanitised message logged");
});

console.log("\nLightning breaker — backoff\n");

await test("backoff doubles and caps, with no inbound traffic", async () => {
  const s = new FakeScheduler();
  let fail = true;
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 20000,
    jitterRatio: 0,
    random: () => 0.5,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => (fail ? FAIL : null),
  });

  b.recordFailure(FAIL);
  assertEquals(s.delays[0], 5000, "first retry ~5s");
  await s.advance(5000);
  assertEquals(s.delays[1], 10000, "second retry ~10s");
  await s.advance(10000);
  assertEquals(s.delays[2], 20000, "third retry ~20s");
  await s.advance(20000);
  assertEquals(s.delays[3], 20000, "capped at 20s");
  await s.advance(20000);
  assertEquals(s.delays[4], 20000, "still capped");
  assert(b.isOpen(), "still open while failing");
});

await test("a successful probe closes the breaker and logs recovery once", async () => {
  const s = new FakeScheduler();
  const { entries, log } = makeLog();
  let fail = true;
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 60000,
    jitterRatio: 0,
    random: () => 0.5,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => (fail ? FAIL : null),
    log,
  });

  b.recordFailure(FAIL);
  await s.advance(5000); // probe fails
  fail = false;
  await s.advance(10000); // probe succeeds
  assertEquals(b.isOpen(), false, "closed after recovery");
  assertEquals(b.snapshot().status, "ok", "healthy");
  assertEquals(s.pending(), 0, "no timer remains");
  const closes = entries.filter((e) => e.event === "lightning_breaker_closed");
  assertEquals(closes.length, 1, "recovery logged once");
});

console.log("\nLightning breaker — one probe in flight\n");

await test("only one probe runs at a time, even when a probe hangs", async () => {
  const s = new FakeScheduler();
  let calls = 0;
  let resolveProbe: ((f: LightningFailure | null) => void) | null = null;
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 60000,
    jitterRatio: 0,
    random: () => 0.5,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: () => {
      calls++;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
  });

  b.recordFailure(FAIL);
  await s.advance(5000);
  assertEquals(calls, 1, "probe started");
  // Advance a long way while the probe hangs: no second probe may be armed.
  await s.advance(3_600_000);
  assertEquals(calls, 1, "still exactly one probe while in flight");
  assertEquals(s.pending(), 0, "no timer armed while a probe is in flight");

  // Resolve it as a failure: exactly one new probe is then armed.
  resolveProbe!(FAIL);
  await flush();
  assertEquals(s.pending(), 1, "one retry armed after the probe settles");
});

console.log("\nLightning breaker — logging discipline\n");

await test("does not log per suppressed attempt; reminds only at the cap", async () => {
  const s = new FakeScheduler();
  const { entries, log } = makeLog();
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 20000,
    jitterRatio: 0,
    random: () => 0.5,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => FAIL,
    log,
  });

  b.recordFailure(FAIL); // open
  await s.advance(5000); // 10s
  await s.advance(10000); // 20s
  await s.advance(20000); // cap reached
  await s.advance(20000); // reminder now
  await s.advance(20000); // reminder again

  assertEquals(entries.filter((e) => e.event === "lightning_breaker_open").length, 1, "one open line");
  assert(
    entries.filter((e) => e.event === "lightning_breaker_reminder").length >= 1,
    "a reminder is emitted once at the cap"
  );
});

await test("snapshot and retryAfterSeconds never carry the upstream message", () => {
  const s = new FakeScheduler();
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 300000,
    jitterRatio: 0,
    random: () => 0.5,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => null,
  });
  b.recordFailure(AUTH_FAIL);
  const snap = JSON.stringify(b.snapshot());
  assert(!snap.includes("unauthorized"), "snapshot must not carry the upstream message");
  assert(snap.includes("auth"), "snapshot carries the coarse category");
  assertEquals(b.retryAfterSeconds(), 5, "retry-after derived from the armed delay");
});

console.log("\nLightning breaker — shutdown\n");

await test("stop() clears the armed timer and prevents further probes", async () => {
  const s = new FakeScheduler();
  let calls = 0;
  const b = new LightningBreaker({
    initialBackoffMs: 5000,
    maxBackoffMs: 300000,
    now: s.now,
    schedule: s.schedule,
    cancel: s.cancel,
    probe: async () => {
      calls++;
      return null;
    },
  });
  b.recordFailure(FAIL);
  assertEquals(s.pending(), 1, "armed");
  b.stop();
  assertEquals(s.pending(), 0, "timer cleared on stop");
  await s.advance(600_000);
  assertEquals(calls, 0, "no probe after stop");
});

await test("invalid constructor options are rejected", () => {
  const opts = {
    initialBackoffMs: 5000,
    maxBackoffMs: 300000,
    probe: async () => null,
  };
  let threw = false;
  try {
    new LightningBreaker({ ...opts, initialBackoffMs: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "zero initial backoff rejected");

  threw = false;
  try {
    new LightningBreaker({ ...opts, maxBackoffMs: 1000 });
  } catch {
    threw = true;
  }
  assert(threw, "cap below initial rejected");
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
