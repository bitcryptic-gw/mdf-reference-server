/**
 * EIP-55 wallet address validation.
 *
 * An EVM address carries no intrinsic checksum, but EIP-55 encodes one in the
 * capitalisation of its hex digits. Requiring the published wallet to be in
 * canonical EIP-55 form means a typo changes the casing and is caught, rather
 * than silently sending funds to the wrong address.
 *
 * Only keccak-256 is needed here, so this uses @noble/hashes (audited, zero
 * transitive dependencies) rather than pulling in viem/ethers.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_RE = /^0x0{40}$/i;

/**
 * Convert an address (any casing) to its canonical EIP-55 checksummed form.
 * Assumes the input has already passed the 0x + 40-hex-digit shape check.
 */
export function toEip55Checksum(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * True only when `value` is exactly its own EIP-55 checksum form.
 *
 * Rejects: wrong length, missing/short 0x prefix, non-hex characters, the zero
 * address, and — because they differ from the checksum — all-lowercase and
 * all-uppercase forms. Unchecksummed addresses carry no typo protection, which
 * is the entire point of this check.
 */
export function isValidEip55Address(value: string): boolean {
  if (!ADDRESS_RE.test(value)) return false;
  if (ZERO_ADDRESS_RE.test(value)) return false;
  return value === toEip55Checksum(value);
}
