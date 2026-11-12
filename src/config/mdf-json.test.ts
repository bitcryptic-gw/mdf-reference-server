/**
 * `/mdf.json` describes what the site **sells**; the 402 describes what it can
 * **settle right now**. This file pins the difference in both directions, because
 * getting it wrong in either direction is a conformance failure:
 *
 *   - a rail that is degraded / rate-limited at runtime must still be declared
 *     (rendered from config), and is only absent from `accepts[]`;
 *   - a rail that is not configured (lnbtc with `lightning.enabled: false`) must
 *     not be declared at all.
 *
 * Run with: bun run src/config/mdf-json.test.ts
 */

import { LnbtcGate } from "../payment/lnbtc/availability.ts";
import { buildOffers } from "../payment/offers.ts";
import { MintLimiter } from "../payment/rate-limit.ts";
import type { PriceEntryConfig, RequirementContext } from "../payment/rails.ts";
import { buildMdfJson, type MdfJsonInput } from "./mdf-json.ts";

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

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NODE = "02" + "ab".repeat(32);
const LNBTC = "lnbtc:000000000019d6689c085ae165831e93";

const SIGNALS = { ai_train: false, ai_input: true, search: true, human_only: false };
const FORMATS = { dialect: "commonmark", frontmatter: true, math: false };

/** The demo's priced sections, as configuration would hold them. */
function demoPricing(includeLnbtc: boolean): MdfJsonInput["pricing"] {
  return {
    default: { rails: [] },
    sections: {
      "/micropayment/**": {
        rails: includeLnbtc
          ? [{ scheme: "exact", network: LNBTC, asset: "BTC", amount: "1000" }]
          : [],
      },
      "/showcase/**": {
        rails: [
          { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
          ...(includeLnbtc
            ? [{ scheme: "exact" as const, network: LNBTC, asset: "BTC", amount: "20000" }]
            : []),
        ],
      },
      "/private/**": {
        access: "token",
        rails: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "100000" }],
      },
    },
  };
}

function doc(includeLnbtc: boolean) {
  return buildMdfJson({
    site: { url: "https://mdf-demo.bitcryptic.com", name: "MDF Demo Site" },
    pricing: demoPricing(includeLnbtc),
    auth: { endpoint: "/mdf/auth", token_ttl_seconds: 86400 },
    signals: SIGNALS,
    formats: FORMATS,
    mdfVersion: "0.3.1",
  });
}

function sectionRails(json: Record<string, unknown>, pattern: string): Array<Record<string, unknown>> {
  const pricing = json.pricing as { sections: Record<string, { rails: Array<Record<string, unknown>> }> };
  return pricing.sections[pattern].rails;
}

console.log("mdf-server /mdf.json rendering");
console.log("--------------------------------------------------");

await test("the document declares the spec version and carries no payment object or wallet", () => {
  const json = doc(true);
  eq(json.mdf_version, "0.3.1", "mdf_version");
  assert(!("payment" in json), "no payment object");
  assert(!JSON.stringify(json).includes("0xa7D9"), "no wallet address");
  eq((json.site as string), "https://mdf-demo.bitcryptic.com", "site");
});

await test("rails are emitted verbatim, in configured order, with atomic amounts", () => {
  const json = doc(true);
  const showcase = sectionRails(json, "/showcase/**");
  eq(showcase.length, 2, "both rails");
  eq(showcase[0].network, "eip155:8453", "order preserved");
  eq(showcase[1].network, LNBTC, "lnbtc second");
  eq(showcase[0].amount, "20000", "atomic amount as configured");
});

await test("access: token is declared; per_fetch is the default and omitted", () => {
  const json = doc(true);
  const pricing = json.pricing as { sections: Record<string, Record<string, unknown>> };
  eq(pricing.sections["/private/**"].access, "token", "token access declared");
  assert(!("access" in pricing.sections["/showcase/**"]), "per_fetch not restated");
});

await test("auth.endpoint is absolute and the TTL is carried", () => {
  const json = doc(true);
  const auth = json.auth as Record<string, unknown>;
  eq(auth.endpoint, "https://mdf-demo.bitcryptic.com/mdf/auth", "absolute endpoint");
  eq(auth.token_ttl_seconds, 86400, "ttl");
});

// ---------------------------------------------------------------------------
// The subtraction-only rule, both directions
// ---------------------------------------------------------------------------

await test("a degraded lnbtc rail stays DECLARED, and is only omitted from accepts[]", async () => {
  const json = doc(true);
  const declared = sectionRails(json, "/showcase/**");
  eq(declared.length, 2, "mdf.json declares both rails");

  // Same configuration, runtime rail degraded.
  const entry: PriceEntryConfig = {
    rails: [
      { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
      { scheme: "exact", network: LNBTC, asset: "BTC", amount: "20000" },
    ],
  };
  const gate = new LnbtcGate({ enabled: true });
  gate.applyCheck({ status: "unreachable", reason: "relay down" });

  const offer = await buildOffers({
    entry,
    ctx: { eip155PayTo: "0xa7D911138322aF8823642beA2b174dFaC2725fB7", lnbtcPayTo: NODE, maxTimeoutSeconds: 300 },
    binding: { method: "GET", url: "https://mdf-demo.bitcryptic.com/showcase/dual-rail", boundHeaders: ["accept"] },
    lnbtc: {
      gate,
      limiter: new MintLimiter(
        { global: { capacity: 10, perMinute: 60 }, perClient: { capacity: 10, perMinute: 60 } },
        0
      ),
      clientKey: "203.0.113.9",
      mint: async () => ({ invoice: "lnbc200n1px", paymentHash: "aa".repeat(32) }),
    },
    nowMs: 0,
  });

  eq(offer.accepts.length, 1, "the 402 omits the degraded rail");
  eq(offer.omitted[0].reason, "lnbtc_degraded", "and says why");
  eq(declared.length, 2, "while mdf.json still declares it");
});

await test("a rate-limited lnbtc rail stays DECLARED, and is only omitted from accepts[]", async () => {
  const json = doc(true);
  eq(sectionRails(json, "/showcase/**").length, 2, "declared");

  const limiter = new MintLimiter(
    { global: { capacity: 10, perMinute: 60 }, perClient: { capacity: 1, perMinute: 1 } },
    0
  );
  limiter.tryTake("203.0.113.9", 0); // spend the only token

  const entry: PriceEntryConfig = {
    rails: [
      { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000" },
      { scheme: "exact", network: LNBTC, asset: "BTC", amount: "20000" },
    ],
  };
  const offer = await buildOffers({
    entry,
    ctx: { eip155PayTo: "0xa7D911138322aF8823642beA2b174dFaC2725fB7", lnbtcPayTo: NODE, maxTimeoutSeconds: 300 },
    binding: { method: "GET", url: "https://x/showcase", boundHeaders: ["accept"] },
    lnbtc: {
      gate: (() => {
        const g = new LnbtcGate({ enabled: true });
        g.applyCheck({ status: "pass", methods: ["make_invoice"], unverified: false });
        return g;
      })(),
      limiter,
      clientKey: "203.0.113.9",
      mint: async () => ({ invoice: "lnbc200n1px", paymentHash: "aa".repeat(32) }),
    },
    nowMs: 0,
  });

  eq(offer.accepts.length, 1, "omitted from the offer");
  eq(offer.omitted[0].reason, "mint_rate_limited", "reason");
  eq(sectionRails(json, "/showcase/**").length, 2, "still declared in mdf.json");
});

await test("lnbtc disabled in CONFIG is not declared at all", () => {
  const withLnbtc = doc(true);
  const without = doc(false);

  eq(sectionRails(withLnbtc, "/micropayment/**").length, 1, "enabled: declared");
  eq(sectionRails(without, "/micropayment/**").length, 0, "disabled: no rails");
  eq(sectionRails(without, "/showcase/**").length, 1, "only the USDC rail remains");
  assert(!JSON.stringify(without).includes("lnbtc:"), "no lnbtc rail anywhere in the document");
});

await test("the renderer has no access to runtime state (structural type only)", () => {
  // The builder takes only the configured document fields. There is no clock, no
  // gate, no breaker and no limiter in its signature, which is the property that
  // makes the rule above structural rather than a convention.
  const json = doc(true);
  const keys = Object.keys(json).sort().join(",");
  eq(keys, "auth,contact,content_signals,formats,mdf_version,name,pricing,site".replace(",contact", ""), "document keys");
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
