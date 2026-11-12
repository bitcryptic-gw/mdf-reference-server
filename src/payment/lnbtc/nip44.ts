/**
 * NIP-44 v2 encryption, as NWC carries its payloads.
 *
 * Alby Hub supports both NIP-44 v2 and NIP-04 (`SUPPORTED_ENCRYPTIONS =
 * "nip44_v2 nip04"`, `nip47/cipher/cipher.go`), so this server uses NIP-44 v2
 * and sends the `["encryption","nip44_v2"]` tag on every request. NIP-04 is
 * implemented nowhere here on purpose: the fallback exists in the Hub for old
 * clients, and a second cipher path is a second place to get padding wrong.
 *
 * Implemented from the NIP's own pseudocode and pinned to its published test
 * vector (conversation key, nonce and payload for the test keys 1 and 2). The
 * ChaCha20 primitive comes from `@noble/ciphers` rather than being hand-rolled —
 * a stream cipher is not a thing to reimplement for a reference server.
 *
 * Length prefix (this revision of the NIP): a 2-byte big-endian u16 below 65536
 * bytes, and a 6-byte form (two zero bytes + u32) at or above it.
 */

import { chacha20 } from "@noble/ciphers/chacha.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Point } from "@noble/secp256k1";
import { randomBytes, timingSafeEqual } from "node:crypto";

const SALT = new TextEncoder().encode("nip44-v2");
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 0xffffffff;
const EXTENDED_PREFIX_THRESHOLD = 65536;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * `secp256k1_ecdh`: multiply the peer's point by our scalar and take the x
 * coordinate. Deliberately **not** hashed — NIP-44 uses the raw x (a common
 * mistake is to feed a compressed or SHA-256'd shared secret into the KDF).
 */
export function sharedX(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  const priv = privateKeyHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(priv)) throw new Error("NIP-44: invalid private key");
  const point = liftPublicKey(publicKeyHex); // validates on-curve
  const shared = point.multiply(BigInt("0x" + priv)).toRawBytes(true);
  return shared.slice(1, 33);
}

/**
 * Accept an x-only key (32 bytes, as Nostr and NIP-44 use) as well as a
 * compressed one. The x-only form has two candidate points; the even-y lift is
 * tried first and the odd-y one second, which is exactly what BIP-340's
 * `lift_x` does.
 */
function liftPublicKey(publicKeyHex: string): Point {
  const clean = publicKeyHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error("NIP-44: invalid public key");
  if (clean.length === 64) {
    let lastError: unknown = null;
    for (const prefix of ["02", "03"]) {
      try {
        return Point.fromHex(prefix + clean);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`NIP-44: public key is not on the curve (${(lastError as Error)?.message ?? ""})`);
  }
  return Point.fromHex(clean);
}

/** `get_conversation_key`: HKDF-Extract(shared_x, salt = "nip44-v2"). */
export function getConversationKey(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  return hkdfExtract(sha256, sharedX(privateKeyHex, publicKeyHex), SALT);
}

/** Per-message keys: HKDF-Expand(conversation key, info = nonce, 76 bytes). */
export function getMessageKeys(
  conversationKey: Uint8Array,
  nonce: Uint8Array
): { chachaKey: Uint8Array; chachaNonce: Uint8Array; hmacKey: Uint8Array } {
  if (conversationKey.length !== 32) throw new Error("NIP-44: conversation key must be 32 bytes");
  if (nonce.length !== 32) throw new Error("NIP-44: nonce must be 32 bytes");
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.slice(0, 32),
    chachaNonce: keys.slice(32, 44),
    hmacKey: keys.slice(44, 76),
  };
}

/** Padded length for a plaintext of `len` bytes (the NIP's `calc_padded_len`). */
export function calcPaddedLen(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function writeU16Be(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, false);
  return out;
}

function writeU32Be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

/** `pad`: 2-byte (or 6-byte, for ≥65536) length prefix, plaintext, zero fill. */
export function pad(plaintext: string): Uint8Array {
  const unpadded = utf8(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) {
    throw new Error("NIP-44: invalid plaintext length");
  }
  const prefix =
    len >= EXTENDED_PREFIX_THRESHOLD
      ? new Uint8Array([0, 0, ...writeU32Be(len)])
      : writeU16Be(len);
  const padded = new Uint8Array(prefix.length + calcPaddedLen(len));
  padded.set(prefix, 0);
  padded.set(unpadded, prefix.length);
  return padded;
}

/** `unpad`: reverse of `pad`, rejecting lengths that do not match the rule. */
export function unpad(padded: Uint8Array): string {
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  let unpaddedLen: number;
  let prefixLen: number;
  if (padded.length < 2) throw new Error("NIP-44: padded payload too short");

  const firstTwo = view.getUint16(0, false);
  if (firstTwo === 0) {
    if (padded.length < 6) throw new Error("NIP-44: padded payload too short");
    unpaddedLen = view.getUint32(2, false);
    if (unpaddedLen < EXTENDED_PREFIX_THRESHOLD) throw new Error("NIP-44: invalid padding");
    prefixLen = 6;
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }

  if (unpaddedLen === 0) throw new Error("NIP-44: empty plaintext");
  if (padded.length !== prefixLen + calcPaddedLen(unpaddedLen)) {
    throw new Error("NIP-44: invalid padding");
  }
  const slice = padded.subarray(prefixLen, prefixLen + unpaddedLen);
  if (slice.length !== unpaddedLen) throw new Error("NIP-44: truncated plaintext");
  return new TextDecoder().decode(slice);
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Error("NIP-44: associated data must be 32 bytes");
  const input = new Uint8Array(aad.length + message.length);
  input.set(aad, 0);
  input.set(message, aad.length);
  return hmac(sha256, key, input);
}

export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Encrypt a UTF-8 string. The nonce is caller-supplied so vectors are testable. */
export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array
): string {
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmacAad(hmacKey, ciphertext, nonce);

  const data = new Uint8Array(1 + 32 + ciphertext.length + 32);
  data[0] = 2;
  data.set(nonce, 1);
  data.set(ciphertext, 33);
  data.set(mac, 33 + ciphertext.length);
  return Buffer.from(data).toString("base64");
}

/** Decrypt a NIP-44 payload, validating the MAC in constant time. */
export function decrypt(payload: string, conversationKey: Uint8Array): string {
  if (typeof payload !== "string" || payload.length < 132) {
    throw new Error("NIP-44: payload too short");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("NIP-44: invalid base64");

  const data = new Uint8Array(Buffer.from(payload, "base64"));
  if (data.length < 99) throw new Error("NIP-44: invalid data size");
  if (data[0] !== 2) throw new Error("NIP-44: unsupported version");

  const nonce = data.slice(1, 33);
  const ciphertext = data.slice(33, data.length - 32);
  const mac = data.slice(data.length - 32);

  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const calculated = hmacAad(hmacKey, ciphertext, nonce);
  if (!timingSafeEqual(Buffer.from(calculated), Buffer.from(mac))) {
    throw new Error("NIP-44: invalid MAC");
  }
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
