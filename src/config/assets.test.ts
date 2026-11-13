/**
 * Vendored asset table (decision 24): the EIP-712 domain must come from the
 * table, never from config, because the domain is what a signature commits to.
 *
 * Run with: bun run src/config/assets.test.ts
 */




import {
  ASSET_TABLE,
  ASSET_TABLE_SOURCE,
  assetTableNetworks,
  lookupAsset,
  requireAsset,
} from "./assets.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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
  if (a !== b) throw new Error(`${m}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}

console.log("mdf-server vendored asset table");
console.log("--------------------------------------------------");

test("Base mainnet USDC is 'USD Coin' v2", () => {
  const e = lookupAsset("eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert(!!e, "entry must exist");
  eq(e!.name, "USD Coin", "mainnet EIP-712 domain name");
  eq(e!.version, "2", "domain version");
  eq(e!.decimals, 6, "decimals");
});

test("Base Sepolia USDC is 'USDC' v2", () => {
  const e = lookupAsset("eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert(!!e, "entry must exist");
  eq(e!.name, "USDC", "sepolia EIP-712 domain name");
});

test("lookup is case-insensitive on the address", () => {
  const lower = lookupAsset("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert(!!lower, "a lower-cased address must still resolve");
  eq(lower!.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "canonical casing is returned");
});

test("an unknown asset on a known network is refused, naming the expected entries", () => {
  const r = requireAsset("eip155:8453", "0x1111111111111111111111111111111111111111");
  eq(r.ok, false, "must refuse");
  if (!r.ok) {
    assert(r.reason.includes("not in the vendored table"), "reason names the table");
    assert(r.reason.includes("USD Coin"), "reason names the expected domain");
  }
});

test("an unknown network is refused, listing what the build can settle", () => {
  const r = requireAsset("eip155:10", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
  eq(r.ok, false, "must refuse");
  if (!r.ok) assert(r.reason.includes("not one this build can settle"), "reason explains why");
});

test("the table covers exactly the three eip155 networks this build serves", () => {
  eq(assetTableNetworks().sort().join(","), "eip155:1,eip155:8453,eip155:84532", "networks");
  for (const [network, entries] of Object.entries(ASSET_TABLE)) {
    assert(entries.length > 0, `${network} must have at least one entry`);
  }
});

test("the vendored source and hash are recorded", () => {
  eq(ASSET_TABLE_SOURCE.commit, "513dd66d2b3eb2388065f9923d81aa496e626082", "upstream commit pin");
  eq(
    ASSET_TABLE_SOURCE.sha256,
    "4a87a165c7c2510b49465e969f58c9441488a491e4068e7aa819a4a5a43f3d8b",
    "upstream file hash"
  );
  assert(ASSET_TABLE_SOURCE.path.endsWith("defaultAssets.ts"), "path names the source file");
});

test("no asset address appears twice on the same network with a different domain", () => {
  for (const [network, entries] of Object.entries(ASSET_TABLE)) {
    const seen = new Map<string, string>();
    for (const e of entries) {
      const key = e.asset.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`${network}: ${key} appears twice with ${seen.get(key)} and ${e.name}`);
      }
      seen.set(key, e.name);
    }
  }
});

test("every table address is a well-formed 0x address", () => {
  for (const [network, entries] of Object.entries(ASSET_TABLE)) {
    for (const e of entries) {
      assert(/^0x[0-9a-fA-F]{40}$/.test(e.asset), `${network}: ${e.asset} is a 20-byte address`);
      assert(e.decimals >= 0 && e.decimals <= 36, `${network}: decimals in range`);
      assert(e.version.length > 0 && e.name.length > 0, `${network}: name and version set`);
    }
  }
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
