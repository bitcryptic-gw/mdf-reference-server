/**
 * BOLT11 decoding and invoice checks for the lnbtc rail.
 *
 * The scheme makes the invoice itself the evidence: `payTo` must equal the
 * invoice's signing key, the signed description hash must equal our request
 * binding, the amount must be the rail's millisatoshi amount, the currency must
 * match the network, and the expiry must equal `maxTimeoutSeconds` exactly. The
 * preimage then proves payment; the invoice proves *what* was paid for.
 *
 * Deliberately hand-rolled and strict: a third-party decoder that silently
 * tolerates a missing description hash, or an inline description where the
 * scheme requires a hash, would defeat the binding. Anything unexpected throws
 * rather than being skipped.
 *
 * Supported: bech32 BOLT11, single-part invoices, `bc`/`tb` currencies, the
 * tagged fields the scheme names (`p`, `d`, `h`, `x`, `n`), and signature
 * recovery so the signing key is checked even when no `n` field is present.
 */

import { createHash } from "node:crypto";
import { Signature } from "@noble/secp256k1";

// ---------------------------------------------------------------------------
// bech32
// ---------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

interface Bech32Decoded {
  hrp: string;
  words: number[];
}

function bech32Decode(input: string): Bech32Decoded {
  if (input.length < 8) throw new Error("invoice too short");
  if (input !== input.toLowerCase()) throw new Error("invoice must be lowercase");

  const sep = input.lastIndexOf("1");
  if (sep < 1 || sep + 7 > input.length) throw new Error("missing bech32 separator");

  const hrp = input.slice(0, sep);
  const dataPart = input.slice(sep + 1);

  const words: number[] = [];
  for (const ch of dataPart) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) throw new Error("invalid bech32 character");
    words.push(idx);
  }

  const checksum = bech32Polymod([...bech32HrpExpand(hrp), ...words]);
  // 1 = bech32 (BIP-173), 0x2bc830a3 = bech32m. BOLT11 uses bech32.
  if (checksum !== 1) throw new Error("invalid bech32 checksum");

  return { hrp, words: words.slice(0, -6) };
}

/**
 * Regroup 5-bit words into bytes.
 *
 * `pad=false` is strict: leftover bits must be zero and are dropped, which is
 * what a fixed-width field payload wants (`p`, `h` are 52 words = 256 bits + 4
 * padding bits). `pad=true` zero-pads the leftover bits into a final byte, which
 * is what the BOLT11 **signature hash** is defined over — `convertbits(5, 8,
 * true)` in the spec's wording. Getting this wrong yields a valid-looking
 * recovered key that is simply the wrong one, so it is asserted against the
 * spec's own test vector.
 */
function wordsToBytes(words: readonly number[], pad = false): Buffer {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0) {
    if (pad) {
      out.push((acc << (8 - bits)) & 0xff);
    } else if ((acc & ((1 << bits) - 1)) !== 0) {
      throw new Error("non-zero padding in bech32 payload");
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

/** BOLT11 amount → millisatoshis. `null` for an any-amount invoice. */
function parseAmount(hrpAmount: string | null): number | null {
  if (!hrpAmount) return null;
  const m = /^(\d+)([munp])?$/.exec(hrpAmount);
  if (!m) throw new Error("malformed invoice amount");

  const value = Number(m[1]);
  if (!Number.isSafeInteger(value)) throw new Error("invoice amount out of range");

  // 1 BTC = 100_000_000_000 msat.
  const multiplier: Record<string, number> = {
    m: 100_000_000, // milli-BTC  = 1e8 msat
    u: 100_000, //     micro-BTC  = 1e5 msat
    n: 100, //         nano-BTC   = 100 msat
    p: 0.1, //         pico-BTC   = 0.1 msat
  };
  const msat = m[2] ? value * multiplier[m[2]] : value * 100_000_000_000;
  if (!Number.isSafeInteger(Math.round(msat))) throw new Error("invoice amount out of range");
  return Math.round(msat);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export interface DecodedInvoice {
  currency: "bc" | "tb";
  /** Millisatoshis, or null for an any-amount invoice. */
  amountMsat: number | null;
  /** Invoice creation time, unix seconds. */
  timestamp: number;
  /** `x` field in seconds, or null when absent (BOLT11 default 3600). */
  expirySeconds: number | null;
  /** Inline description (`d`), if present. Mutually exclusive with the hash. */
  description: string | null;
  /** Description hash (`h`) as 64 lowercase hex, if present. */
  descriptionHash: string | null;
  /** Payment hash (`p`), 64 lowercase hex. */
  paymentHash: string;
  /** `n` field (payee pubkey) when present, 66 char compressed hex. */
  payeePubkeyField: string | null;
  /** Signing key recovered from the signature, 66 char compressed hex. */
  signingKey: string;
  /** True when every tagged field was understood. */
  fullyParsed: boolean;
  /** Tagged field types seen, for diagnostics only. */
  tags: string[];
}

const TAG_NAMES: Record<number, string> = {
  1: "p", // payment hash
  13: "d", // description
  23: "h", // description hash
  6: "x", // expiry
  19: "n", // payee pubkey
  16: "s", // payment secret
  5: "c", // min_final_cltv_expiry
};

/**
 * Decode a BOLT11 invoice and recover the signing key. Throws on anything
 * malformed — the caller treats a throw as a rejected invoice.
 */
export function decodeBolt11(invoice: string): DecodedInvoice {
  const { hrp, words } = bech32Decode(invoice.trim());

  if (!hrp.startsWith("ln")) throw new Error("not a lightning invoice");
  const currency = hrp.slice(2, 4);
  if (currency !== "bc" && currency !== "tb") {
    throw new Error(`unsupported invoice currency '${currency}'`);
  }
  const hrpAmount = hrp.slice(4) || null;
  const amountMsat = parseAmount(hrpAmount);

  // Last 104 words are the signature (64-byte compact + recovery id).
  if (words.length < 7 + 104) throw new Error("invoice data too short for a signature");
  const dataWords = words.slice(0, words.length - 104);
  const sigWords = words.slice(words.length - 104);
  const sigBytes = wordsToBytes(sigWords);
  if (sigBytes.length !== 65) throw new Error("malformed signature");

  // Signed message: SHA-256 over the hrp and the data words (minus signature),
  // with the data regrouped into bytes for the hash input.
  const signature = Signature.fromCompact(sigBytes.subarray(0, 64)).addRecoveryBit(
    sigBytes[64]
  );
  const message = createHash("sha256")
    .update(Buffer.from(hrp, "ascii"))
    .update(wordsToBytes(dataWords, true))
    .digest();
  const signingKey = Buffer.from(signature.recoverPublicKey(message).toRawBytes(true)).toString(
    "hex"
  );

  // Timestamp: 35 bits.
  let bitOffset = 0;
  const readBits = (count: number): number => {
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const wordIdx = Math.floor(bitOffset / 5);
      const bitIdx = 4 - (bitOffset % 5);
      if (wordIdx >= dataWords.length) throw new Error("truncated invoice data");
      acc = (acc << 1) | ((dataWords[wordIdx] >> bitIdx) & 1);
      bitOffset++;
    }
    return acc;
  };
  const timestamp = readBits(35);

  const tags: string[] = [];
  let description: string | null = null;
  let descriptionHash: string | null = null;
  let paymentHash: string | null = null;
  let payeePubkeyField: string | null = null;
  let expirySeconds: number | null = null;
  let fullyParsed = true;

  while (bitOffset + 15 <= dataWords.length * 5) {
    const type = readBits(5);
    const length = readBits(10);
    if (bitOffset + length * 5 > dataWords.length * 5) {
      throw new Error("tagged field runs past the end of the invoice");
    }
    const fieldWords: number[] = [];
    for (let i = 0; i < length; i++) {
      let acc = 0;
      for (let b = 0; b < 5; b++) {
        const wordIdx = Math.floor(bitOffset / 5);
        const bitIdx = 4 - (bitOffset % 5);
        acc = (acc << 1) | ((dataWords[wordIdx] >> bitIdx) & 1);
        bitOffset++;
      }
      fieldWords.push(acc);
    }

    const name = TAG_NAMES[type];
    if (name) tags.push(name);
    else fullyParsed = false;

    if (type === 1) {
      paymentHash = wordsToBytes(fieldWords).toString("hex");
    } else if (type === 13) {
      description = wordsToBytes(fieldWords).toString("utf8");
    } else if (type === 23) {
      descriptionHash = wordsToBytes(fieldWords).toString("hex");
    } else if (type === 6) {
      const bytes = wordsToBytes(fieldWords);
      expirySeconds = bytes.length === 0 ? 0 : Number("0x" + bytes.toString("hex"));
    } else if (type === 19) {
      payeePubkeyField = wordsToBytes(fieldWords).toString("hex");
    }
  }

  if (!paymentHash || paymentHash.length !== 64) {
    throw new Error("invoice has no payment hash");
  }

  return {
    currency,
    amountMsat,
    timestamp,
    expirySeconds,
    description,
    descriptionHash,
    paymentHash,
    payeePubkeyField,
    signingKey,
    fullyParsed,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface InvoiceRequirements {
  /** Concrete network, e.g. lnbtc:000000000019d6689c085ae165831e93. */
  network: string;
  /** The rail's amount in millisatoshis. */
  amountMsat: number;
  /** Our computed request binding. */
  requestHash: string;
  /** The receiver node pubkey (accepts[].payTo). */
  payeePubkey: string;
  /** Must equal the invoice's expiry exactly. */
  maxTimeoutSeconds: number;
  /** Max tolerated clock skew for the creation time, seconds. */
  clockSkewSeconds?: number;
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** BOLT11 currency for a concrete lnbtc network. */
function currencyForNetwork(network: string): "bc" | "tb" {
  if (network === "lnbtc:000000000019d6689c085ae165831e93") return "bc";
  if (network === "lnbtc:000000000933ea01ad0ee984209779ba") return "tb";
  throw new Error(`unsupported lnbtc network '${network}'`);
}

/**
 * Assert a decoded invoice against the requirements it was minted for.
 *
 * Every check the scheme names, and one it implies: an invoice with an inline
 * description is rejected, because only a description *hash* can commit to our
 * request binding.
 */
export function checkInvoice(
  invoice: DecodedInvoice,
  requirement: InvoiceRequirements,
  nowSeconds: number
): CheckResult {
  const expectedCurrency = currencyForNetwork(requirement.network);
  if (invoice.currency !== expectedCurrency) {
    return {
      ok: false,
      reason: `invoice currency '${invoice.currency}' does not match network '${requirement.network}'`,
    };
  }
  if (invoice.amountMsat === null) {
    return { ok: false, reason: "invoice has no amount" };
  }
  if (invoice.amountMsat !== requirement.amountMsat) {
    return {
      ok: false,
      reason: `invoice amount ${invoice.amountMsat} msat does not equal the rail amount ${requirement.amountMsat} msat`,
    };
  }
  if (invoice.description !== null) {
    return { ok: false, reason: "invoice carries an inline description, not a description hash" };
  }
  if (!invoice.descriptionHash) {
    return { ok: false, reason: "invoice has no description hash" };
  }
  if (invoice.descriptionHash !== requirement.requestHash.toLowerCase()) {
    return {
      ok: false,
      reason: "invoice description hash does not match this request's binding",
    };
  }
  if (invoice.signingKey !== requirement.payeePubkey.toLowerCase()) {
    return { ok: false, reason: "invoice signing key does not equal payTo" };
  }
  if (invoice.payeePubkeyField && invoice.payeePubkeyField !== invoice.signingKey) {
    return { ok: false, reason: "invoice 'n' field does not match the signing key" };
  }
  const expiry = invoice.expirySeconds ?? 3600;
  if (expiry !== requirement.maxTimeoutSeconds) {
    return {
      ok: false,
      reason: `invoice expiry ${expiry}s does not equal maxTimeoutSeconds ${requirement.maxTimeoutSeconds}`,
    };
  }
  const skew = requirement.clockSkewSeconds ?? 60;
  if (invoice.timestamp > nowSeconds + skew) {
    return { ok: false, reason: "invoice creation time is in the future" };
  }
  if (nowSeconds > invoice.timestamp + expiry + skew) {
    return { ok: false, reason: "invoice has expired" };
  }
  return { ok: true };
}

/** `SHA-256(preimage) == paymentHash`, with both sides validated as 32 bytes. */
export function preimageMatches(preimageHex: string, paymentHashHex: string): CheckResult {
  if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
    return { ok: false, reason: "preimage must be exactly 64 lowercase hex characters" };
  }
  const digest = createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
  if (digest !== paymentHashHex.toLowerCase()) {
    return { ok: false, reason: "preimage does not hash to the invoice payment hash" };
  }
  return { ok: true };
}
