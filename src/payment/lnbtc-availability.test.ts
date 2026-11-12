/**
 * Startup and recovery policy for the lnbtc rail.
 *
 * The rule that matters: a **bad credential** and an **unreachable relay** are
 * different things and must produce different outcomes. A wallet that answers and
 * admits it may spend money is a security misconfiguration — refuse to boot. A
 * relay that cannot be reached is a dependency outage — boot normally, omit the
 * rail, and retry.
 *
 * Run with: bun run src/payment/lnbtc-availability.test.ts
 */

import {
  CredentialRefusedError,
  LnbtcGate,
  checkNwcConnection,
  startLnbtc,
} from "./lnbtc/availability.ts";
import { NwcError } from "./lnbtc/nwc.ts";

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

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

function eq(a: unknown, b: unknown, m: string) {
  if (a !== b) {
    throw new Error(`${m}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
  }
}

function fakeClient(behaviour: "pass" | "unreachable" | "auth" | "spend" | "no-methods") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getInfo() {
      calls++;
      if (behaviour === "unreachable") {
        throw new NwcError("unreachable", "no relay answered");
      }
      if (behaviour === "auth") {
        throw new NwcError("auth", "wallet refused get_info: UNAUTHORIZED");
      }
      if (behaviour === "no-methods") return { methods: null };
      return {
        methods:
          behaviour === "spend" ? ["make_invoice", "get_info", "pay_invoice"] : ["make_invoice", "get_info"],
      };
    },
  };
}

console.log("mdf-server lnbtc availability");
console.log("--------------------------------------------------");

await test("disabled: no NWC call at all, and the rail is never offered", async () => {
  const client = fakeClient("pass");
  const gate = await startLnbtc({ enabled: false, client });
  eq(client.calls, 0, "the wallet is never contacted");
  eq(gate.canOffer(), false, "rail not offered");
  eq(gate.enabled, false, "disabled");
  eq(gate.snapshot().status, "disabled", "health says disabled");
});

await test("relay down at boot: gate degraded, server keeps going", async () => {
  const gate = await startLnbtc({ enabled: true, client: fakeClient("unreachable") });
  eq(gate.canOffer(), false, "lnbtc omitted from accepts[]");
  eq(gate.snapshot().status, "degraded", "health shows degraded");
  eq(gate.snapshot().category, "unreachable", "category is unreachable");
  assert(typeof gate.snapshot().since === "string", "since recorded");
});

await test("relay recovers: the background check flips the rail on", async () => {
  const gate = await startLnbtc({ enabled: true, client: fakeClient("unreachable") });
  eq(gate.canOffer(), false, "starts degraded");

  const becomesAvailable = gate.applyCheck({ status: "pass", methods: ["make_invoice", "get_info"], unverified: false });
  eq(becomesAvailable, true, "reports the transition");
  eq(gate.canOffer(), true, "rail now offered");
  eq(gate.snapshot().status, "available", "health says available");
  assert(!("category" in gate.snapshot()), "no stale category");
});

await test("a later outage degrades again, without a restart", async () => {
  const gate = await startLnbtc({ enabled: true, client: fakeClient("pass") });
  eq(gate.canOffer(), true, "available");

  gate.applyCheck({ status: "unreachable", reason: "relay closed" });
  eq(gate.canOffer(), false, "degraded again");
  eq(gate.snapshot().status, "degraded", "health follows");
});

await test("pay_invoice reported by the wallet refuses startup", async () => {
  let refusal: Error | null = null;
  try {
    await startLnbtc({ enabled: true, client: fakeClient("spend") });
  } catch (err) {
    refusal = err as Error;
  }
  assert(refusal instanceof CredentialRefusedError, "a typed refusal");
  assert(/pay_invoice/.test(refusal.message), "names the offending method");
  assert(/refusing to start/.test(refusal.message), "says what it did");
});

await test("an auth failure from the wallet is a credential problem, not an outage", async () => {
  let refusal: Error | null = null;
  try {
    await startLnbtc({ enabled: true, client: fakeClient("auth") });
  } catch (err) {
    refusal = err as Error;
  }
  assert(refusal instanceof CredentialRefusedError, "refused rather than degraded");

  const check = await checkNwcConnection(fakeClient("auth"));
  eq(check.status, "bad_credential", "classified as a credential problem");
});

await test("answered-but-silent permissions: available, flagged unverified", async () => {
  const gate = await startLnbtc({ enabled: true, client: fakeClient("no-methods") });
  eq(gate.canOffer(), true, "the rail works; the check simply cannot prove the scope");
  eq(gate.snapshot().status, "available", "available");
  eq(gate.snapshot().unverified, true, "flagged for the operator");
});

await test("lookup_invoice is refused too (wider than needed)", async () => {
  const check = await checkNwcConnection({
    async getInfo() {
      return { methods: ["make_invoice", "lookup_invoice"] };
    },
  });
  eq(check.status, "bad_credential", "refused");
  if (check.status === "bad_credential") assert(check.reason.includes("lookup_invoice"), "names it");
});

await test("malformed wallet data degrades rather than refusing", async () => {
  const check = await checkNwcConnection({
    async getInfo() {
      throw new NwcError("malformed", "wallet response could not be decrypted");
    },
  });
  eq(check.status, "unreachable", "unavailability, not a credential verdict");
});

await test("a disabled gate ignores later check results", async () => {
  const gate = new LnbtcGate({ enabled: false });
  gate.applyCheck({ status: "pass", methods: ["make_invoice"], unverified: false });
  eq(gate.canOffer(), false, "still disabled");
  eq(gate.snapshot().status, "disabled", "unchanged");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
