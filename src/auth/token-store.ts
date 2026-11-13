/**
 * Bearer-token store: hash-only, shared, fail closed.
 *
 * Two changes from the 0.2.x in-process `Map`:
 *
 *   - **the raw token is never stored** (decision 3). Only
 *     `SHA-256(LABEL || id || secret)` is persisted, so a dump of the store — or
 *     of Valkey — cannot be turned back into a usable credential. The token the
 *     client receives is the only copy of the secret.
 *   - **it is shared** (Valkey), because the demo runs two instances behind
 *     round-robin and a per-process store means a token works on whichever
 *     instance minted it and fails on the other roughly half the time.
 *
 * Validation stays constant-time: the stored digest is compared with
 * `timingSafeEqual`, and a missing record returns the same shape of failure as a
 * wrong secret so a probe cannot tell "no such id" from "wrong secret".
 *
 * Failure is closed. If Valkey cannot be reached, `get` returns null and `put`
 * fails: the request is treated as unauthenticated. Serving a token-gated page
 * because the store was down would be the exact inverse of the guarantee the
 * token exists to provide.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import {
  isAuthError,
  parseResp,
  type StoreHealth,
  type ValkeyOptions,
} from "../payment/lnbtc/replay-store.ts";

/** Domain separation for the digest, so a token hash cannot collide with a replay key. */
const TOKEN_HASH_LABEL = "mdf-token-v1:";
const KEY_PREFIX = "mdf:token:";
const PENDING_PREFIX = "mdf:pending-token:";

export interface StoredToken {
  /** SHA-256(LABEL || id || secret), hex. Never the token itself. */
  secretHash: string;
  pathScope: string;
  expiresAt: number;
  issuedTo: string;
  txHash: string;
}

/**
 * A payment that verified and settled (or is about to) but whose token has not
 * been written yet.
 *
 * Keyed by the payment's identity, and carrying a hash of the exact
 * `PAYMENT-SIGNATURE` that paid: the retry path issues a token *without*
 * re-verifying, so it must be impossible to reach it by asserting someone
 * else's `(from, nonce)`.
 */
export interface PendingToken {
  /** SHA-256 of the raw PAYMENT-SIGNATURE header value. */
  signatureHash: string;
  /** Section the token will be scoped to. */
  pathScope: string;
  /** The path that was verified, so a retry cannot re-target the token. */
  resourcePath: string;
  createdAt: number;
  /** True once a token has been issued for this payment. */
  issued: boolean;
  /** Id of the issued token, so the mark can be audited. */
  issuedTokenId?: string;
  /** Rail label, for the issued-token log line on the retry path. */
  rail?: string;
  /** Settlement this payment produced, replayed in the retry's header. */
  settlement?: { transaction: string; network: string; payer?: string };
  /** Payer, when the rail exposes one (lnbtc does not). */
  payer?: string;
}

export interface TokenStore {
  put(id: string, token: StoredToken, ttlSeconds: number): Promise<boolean>;
  get(id: string): Promise<StoredToken | null>;
  delete(id: string): Promise<void>;
  /** Record a settled payment whose token has not been written yet. */
  putPending(key: string, record: PendingToken, ttlSeconds: number): Promise<boolean>;
  getPending(key: string): Promise<PendingToken | null>;
  /**
   * Reachability probe (AUTH plus a cheap command), used *before* a payment is
   * settled and by `/health`. A probe that skips AUTH reports "ok" while every
   * write fails — which is exactly the outage that hid the missing-AUTH bug.
   */
  health(): Promise<StoreHealth>;
  close(): void;
}

export function hashTokenSecret(id: string, secret: string): string {
  return createHash("sha256").update(`${TOKEN_HASH_LABEL}${id}:${secret}`).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// In-memory store (tests, and a single-instance deployment)
// ---------------------------------------------------------------------------

export class MemoryTokenStore implements TokenStore {
  private readonly records = new Map<string, StoredToken>();
  private readonly pending = new Map<string, { record: PendingToken; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async put(id: string, token: StoredToken, _ttlSeconds: number): Promise<boolean> {
    this.records.set(id, token);
    return true;
  }

  /**
   * Returns the record even when expired: `validateToken` classifies expiry as
   * "expired" rather than "unknown", which is the distinction that tells an
   * operator whether a token was revoked or simply aged out.
   */
  async get(id: string): Promise<StoredToken | null> {
    return this.records.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async putPending(key: string, record: PendingToken, ttlSeconds: number): Promise<boolean> {
    this.pending.set(key, { record, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }

  async getPending(key: string): Promise<PendingToken | null> {
    const hit = this.pending.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.pending.delete(key);
      return null;
    }
    return hit.record;
  }

  async health(): Promise<StoreHealth> {
    return "ok";
  }

  close(): void {
    this.records.clear();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Valkey-backed store
// ---------------------------------------------------------------------------

/**
 * Tokens in Valkey, one key per token id, with the token's own TTL so expiry
 * needs no sweeper. The value is JSON of the record — a digest, a scope and two
 * opaque identifiers, never a credential.
 */
export class ValkeyTokenStore implements TokenStore {
  private readonly options: Required<Omit<ValkeyOptions, "password">> & { password?: string };

  constructor(options: ValkeyOptions) {
    this.options = {
      host: options.host,
      port: options.port,
      password: options.password,
      connectTimeoutMs: options.connectTimeoutMs ?? 2000,
      commandTimeoutMs: options.commandTimeoutMs ?? 2000,
    };
  }

  async put(id: string, token: StoredToken, ttlSeconds: number): Promise<boolean> {
    const reply = await this.run([
      ["SET", KEY_PREFIX + id, JSON.stringify(token), "EX", String(Math.max(1, Math.ceil(ttlSeconds)))],
    ]);
    return reply.kind === "simple" && reply.value === "OK";
  }

  async get(id: string): Promise<StoredToken | null> {
    const reply = await this.run([["GET", KEY_PREFIX + id]]);
    if (reply.kind !== "bulk" || typeof reply.value !== "string") return null;
    try {
      const parsed = JSON.parse(reply.value) as StoredToken;
      if (typeof parsed.secretHash !== "string" || typeof parsed.pathScope !== "string") return null;
      if (!Number.isFinite(parsed.expiresAt)) return null;
      // Expiry is judged by the caller, so "expired" and "unknown" stay distinct
      // in logs. Valkey's own TTL normally removes the key first.
      return parsed;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await this.run([["DEL", KEY_PREFIX + id]]);
  }

  /** AUTH + PING on a fresh connection; the same path a write takes. */
  async health(): Promise<StoreHealth> {
    const reply = await this.run([["PING"]]);
    if (reply.kind === "simple" && reply.value === "PONG") return "ok";
    return isAuthError(reply.value) ? "auth" : "unreachable";
  }

  async putPending(key: string, record: PendingToken, ttlSeconds: number): Promise<boolean> {
    const reply = await this.run([
      [
        "SET",
        PENDING_PREFIX + key,
        JSON.stringify(record),
        "EX",
        String(Math.max(1, Math.ceil(ttlSeconds))),
      ],
    ]);
    return reply.kind === "simple" && reply.value === "OK";
  }

  async getPending(key: string): Promise<PendingToken | null> {
    const reply = await this.run([["GET", PENDING_PREFIX + key]]);
    if (reply.kind !== "bulk" || typeof reply.value !== "string") return null;
    try {
      const parsed = JSON.parse(reply.value) as PendingToken;
      if (typeof parsed.signatureHash !== "string" || typeof parsed.pathScope !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  close(): void {
    // Nothing pooled.
  }

  /** Run one command over a fresh short-lived connection; an error on any step. */
  private async run(commands: string[][]): Promise<{ kind: string; value?: string }> {
    let socket: ReturnType<typeof connect> | null = null;
    try {
      socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
        const s = connect({ host: this.options.host, port: this.options.port });
        const timer = setTimeout(() => {
          s.destroy();
          reject(new Error("valkey connect timeout"));
        }, this.options.connectTimeoutMs);
        s.once("error", (err) => {
          clearTimeout(timer);
          s.destroy();
          reject(err);
        });
        s.once("connect", () => {
          clearTimeout(timer);
          s.setTimeout(this.options.commandTimeoutMs, () => s.destroy());
          resolve(s);
        });
      });

      const client = socket;
      // AUTH first: a password-protected store answers NOAUTH to everything
      // else, and a silent failure here would read as "store unavailable" on
      // every token mint.
      if (this.options.password) {
        const auth = await this.command(client, ["AUTH", this.options.password]);
        if (auth.kind === "error") return { kind: "error", value: auth.value };
      }

      for (const command of commands) {
        const reply = await this.command(client, command);
        if (reply.kind === "error") return { kind: "error", value: reply.value };
        if (command !== commands[commands.length - 1]) continue;
        return reply;
      }
      return { kind: "error" };
    } catch {
      return { kind: "error", value: "unavailable" };
    } finally {
      socket?.destroy();
    }
  }

  private command(
    socket: ReturnType<typeof connect>,
    args: string[]
  ): Promise<{ kind: string; value?: string }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseResp(buffer);
        if (!parsed) return;
        socket.off("data", onData);
        resolve(parsed.reply as { kind: string; value?: string });
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.write(encodeCommand(args));
    });
  }
}

function encodeCommand(args: string[]): Buffer {
  const parts = [Buffer.from(`*${args.length}\r\n`, "ascii")];
  for (const arg of args) {
    const body = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${body.length}\r\n`, "ascii"), body, Buffer.from("\r\n", "ascii"));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Issuance and validation
// ---------------------------------------------------------------------------

export interface IssuedToken {
  /** The only copy of the secret; never persisted. */
  token: string;
  id: string;
  expiresAt: number;
  ttlSeconds: number;
}

const ID_BYTES = 16;
const SECRET_BYTES = 32;

/** Mint a token and persist only its digest. */
export async function issueToken(
  store: TokenStore,
  params: {
    urlPath: string;
    pathScope: string;
    issuedTo: string;
    txHash: string;
    ttlSeconds: number;
    now?: number;
  }
): Promise<IssuedToken | null> {
  const now = params.now ?? Date.now();
  const id = randomBytes(ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const expiresAt = now + params.ttlSeconds * 1000;

  const stored = await store.put(
    id,
    {
      secretHash: hashTokenSecret(id, secret),
      pathScope: params.pathScope,
      expiresAt,
      issuedTo: params.issuedTo,
      txHash: params.txHash,
    },
    params.ttlSeconds
  );
  if (!stored) return null;

  return { token: `${id}.${secret}`, id, expiresAt, ttlSeconds: params.ttlSeconds };
}

export type ValidateOutcome =
  | { ok: true; record: StoredToken }
  | { ok: false; reason: "malformed" | "unknown" | "expired" | "wrong_secret" | "out_of_scope" };

/**
 * Validate a `Bearer <id>.<secret>` header against the store.
 *
 * "unknown" and "wrong_secret" are deliberately distinct in the return value but
 * identical to the client (both a 402 with the same offer): the distinction is
 * for logs, where it tells an operator whether a token was revoked or mistyped.
 */
export async function validateToken(
  store: TokenStore,
  authHeader: string | null | undefined,
  urlPath: string,
  now: number = Date.now()
): Promise<ValidateOutcome> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return { ok: false, reason: "malformed" };
  const raw = authHeader.slice("Bearer ".length).trim();
  const dot = raw.indexOf(".");
  if (dot === -1) return { ok: false, reason: "malformed" };

  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret)) {
    return { ok: false, reason: "malformed" };
  }

  const record = await store.get(id);
  if (!record) return { ok: false, reason: "unknown" };
  if (record.expiresAt <= now) return { ok: false, reason: "expired" };

  if (!digestsEqual(hashTokenSecret(id, secret), record.secretHash)) {
    return { ok: false, reason: "wrong_secret" };
  }

  if (!pathInScope(urlPath, record.pathScope)) return { ok: false, reason: "out_of_scope" };
  return { ok: true, record };
}

/** Scope check on path-segment boundaries (`/premium` must not cover `/premiumx`). */
export function pathInScope(urlPath: string, scope: string): boolean {
  if (scope === "/") return true;
  const trimmed = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return urlPath === trimmed || urlPath.startsWith(trimmed + "/") || urlPath === scope;
}
