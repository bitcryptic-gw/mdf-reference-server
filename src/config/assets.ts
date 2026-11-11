/**
 * Vendored per-network asset table.
 *
 * MDF 0.3.x takes an `exact`/eip155 rail's asset, decimals and EIP-712 domain
 * (`extra.name`, `extra.version`) from a fixed table — never from free config.
 * Getting `name` wrong changes the signature domain and every payment fails
 * verification on-chain (decision 24: "USD Coin" on Base mainnet, "USDC" on
 * Base Sepolia), so the values are vendored from upstream and the source is
 * recorded here and checked by the tests.
 *
 * Source:  x402-foundation/x402 @ 513dd66d2b3eb2388065f9923d81aa496e626082
 *          typescript/packages/mechanisms/evm/src/defaultAssets.ts
 *          sha256 4a87a165c7c2510b49465e969f58c9441488a491e4068e7aa819a4a5a43f3d8b
 *
 * Only the networks this server can settle are vendored. A rail on any other
 * network is a config error (see `loader.ts`), so the table never needs to be
 * complete — it needs to be exactly right for what is offered.
 */

export interface AssetEntry {
  /** Token contract address, EIP-55 checksummed exactly as upstream writes it. */
  asset: string;
  /** EIP-712 domain name. Must match the token's domain separator. */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  /** Token decimals, for converting a human price to atomic units. */
  decimals: number;
  symbol: string;
}

export const ASSET_TABLE_SOURCE = {
  repo: "x402-foundation/x402",
  commit: "513dd66d2b3eb2388065f9923d81aa496e626082",
  path: "typescript/packages/mechanisms/evm/src/defaultAssets.ts",
  sha256: "4a87a165c7c2510b49465e969f58c9441488a491e4068e7aa819a4a5a43f3d8b",
} as const;

export const ASSET_TABLE: Readonly<Record<string, readonly AssetEntry[]>> = {
  "eip155:1": [
    {
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      name: "USD Coin",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    },
  ],
  "eip155:8453": [
    {
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      name: "USD Coin",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    },
  ],
  "eip155:84532": [
    {
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      name: "USDC",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    },
  ],
};

/** Networks the table can answer for. A rail elsewhere is unservable. */
export function assetTableNetworks(): string[] {
  return Object.keys(ASSET_TABLE);
}

/**
 * Look up an asset on a network, comparing addresses case-insensitively
 * (EIP-55 is a checksum, not part of the identity), and return the table's
 * entry — the authoritative name/version/decimals.
 */
export function lookupAsset(network: string, asset: string): AssetEntry | null {
  const entries = ASSET_TABLE[network];
  if (!entries) return null;
  const wanted = asset.toLowerCase();
  for (const entry of entries) {
    if (entry.asset.toLowerCase() === wanted) return entry;
  }
  return null;
}

/**
 * Startup gate: an `exact`/eip155 rail must name an asset the table knows for
 * its network. Returns the entry, or a message naming exactly what is wrong —
 * never a silent fallback to a default token.
 */
export function requireAsset(
  network: string,
  asset: string
): { ok: true; entry: AssetEntry } | { ok: false; reason: string } {
  const known = ASSET_TABLE[network];
  if (!known) {
    return {
      ok: false,
      reason:
        `network '${network}' is not one this build can settle ` +
        `(vendored: ${assetTableNetworks().join(", ")})`,
    };
  }
  const entry = lookupAsset(network, asset);
  if (!entry) {
    const expected = known.map((e) => `${e.symbol} ${e.asset} ("${e.name}" v${e.version})`);
    return {
      ok: false,
      reason:
        `asset '${asset}' is not in the vendored table for ${network} ` +
        `(expected one of: ${expected.join(", ")}) — the EIP-712 domain must come ` +
        `from the table, so an unknown asset cannot be served`,
    };
  }
  return { ok: true, entry };
}
