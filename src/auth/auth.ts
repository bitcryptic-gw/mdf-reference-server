import { randomBytes, timingSafeEqual, createHmac } from "crypto";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenRecord {
  /** The token value stored as a Buffer for timing-safe comparison */
  tokenBuf: Buffer;
  /** Absolute expiry as Unix ms timestamp */
  expiresAt: number;
  /** Path scope — token is valid for paths that start with this prefix */
  pathScope: string;
  /** Wallet address that paid for this token */
  issuedTo: string;
  /** Transaction hash that funded issuance */
  txHash: string;
  /** When the token was issued */
  issuedAt: number;
}

export type IssueResult =
  | { ok: true; token: string; expiresAt: number; ttlSeconds: number }
  | { ok: false; reason: string };

export type ValidateResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

/**
 * In-memory token store. Interface is intentionally narrow so it can be
 * replaced with a persistent backend (Redis, SQLite) without touching
 * issuance or validation logic.
 */
class TokenStore {
  private store = new Map<string, TokenRecord>();
  private sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sweepIntervalMs = 60_000) {
    this.sweepIntervalMs = sweepIntervalMs;
  }

  set(id: string, record: TokenRecord): void {
    this.store.set(id, record);
  }

  get(id: string): TokenRecord | undefined {
    return this.store.get(id);
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  size(): number {
    return this.store.size;
  }

  /**
   * Remove all expired tokens. Called periodically to prevent unbounded growth.
   * Returns the number of entries removed.
   */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of this.store) {
      if (record.expiresAt <= now) {
        this.store.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Start background sweep timer. Call once at server startup.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const removed = this.sweep();
      if (removed > 0) {
        console.log(`[mdf:auth] swept ${removed} expired token(s)`);
      }
    }, this.sweepIntervalMs);
    // Don't prevent process exit
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

// Module-level singleton — one store per server process
export const tokenStore = new TokenStore();

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

// Token format: <id>.<secret>
// id  — 16 random bytes hex (32 chars) — used as store key
// secret — 32 random bytes hex (64 chars) — compared timing-safely
const ID_BYTES = 16;
const SECRET_BYTES = 32;
const SEPARATOR = ".";

function generateToken(): { token: string; id: string; secretBuf: Buffer } {
  const id = randomBytes(ID_BYTES).toString("hex");
  const secretBuf = randomBytes(SECRET_BYTES);
  const token = `${id}${SEPARATOR}${secretBuf.toString("hex")}`;
  return { token, id, secretBuf };
}

function splitToken(token: string): { id: string; secret: string } | null {
  const idx = token.indexOf(SEPARATOR);
  if (idx === -1) return null;
  const id = token.slice(0, idx);
  const secret = token.slice(idx + 1);
  // Basic sanity: id must be 32 hex chars, secret 64 hex chars
  if (id.length !== ID_BYTES * 2 || secret.length !== SECRET_BYTES * 2) return null;
  if (!/^[0-9a-f]+$/.test(id) || !/^[0-9a-f]+$/.test(secret)) return null;
  return { id, secret };
}

// ---------------------------------------------------------------------------
// Path scope helpers
// ---------------------------------------------------------------------------

/**
 * Derive the path scope from the paid URL path.
 * /private/internals → /private/
 * /premium/deep-dive → /premium/
 * Scope is the top-level directory of the paid path.
 */
function derivePathScope(urlPath: string): string {
  const parts = urlPath.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return `/${parts[0]}/`;
}

function pathInScope(urlPath: string, scope: string): boolean {
  return urlPath === scope.replace(/\/$/, "") || urlPath.startsWith(scope);
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

/**
 * Issue a bearer token after successful payment verification.
 *
 * @param urlPath  - The path that was paid for (used to derive scope)
 * @param issuedTo - Wallet address of the payer
 * @param txHash   - Transaction hash that funded issuance
 * @param loaded   - Server config
 */
export function issueToken(
  urlPath: string,
  issuedTo: string,
  txHash: string,
  loaded: LoadedConfig
): IssueResult {
  const { config } = loaded;

  if (!config.auth) {
    return { ok: false, reason: "auth not configured on this server" };
  }

  const ttlSeconds = config.auth.token_ttl_seconds;
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const pathScope = derivePathScope(urlPath);

  const { token, id, secretBuf } = generateToken();

  tokenStore.set(id, {
    tokenBuf: secretBuf,
    expiresAt,
    pathScope,
    issuedTo,
    txHash,
    issuedAt: now,
  });

  console.log(JSON.stringify({
    ts: new Date(now).toISOString(),
    event: "token_issued",
    id,
    pathScope,
    issuedTo: issuedTo ? `${issuedTo.slice(0, 6)}…${issuedTo.slice(-4)}` : "unknown",
    txHash,
    expiresAt: new Date(expiresAt).toISOString(),
  }));

  return { ok: true, token, expiresAt, ttlSeconds };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a bearer token from the Authorization header.
 *
 * @param authHeader - Raw Authorization header value e.g. "Bearer <token>"
 * @param urlPath    - The path being requested (scope check)
 */
export function validateToken(
  authHeader: string | null | undefined,
  urlPath: string
): ValidateResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing or malformed Authorization header" };
  }

  const raw = authHeader.slice("Bearer ".length).trim();
  const parts = splitToken(raw);

  if (!parts) {
    return { ok: false, reason: "invalid token format" };
  }

  const record = tokenStore.get(parts.id);

  if (!record) {
    return { ok: false, reason: "token not found" };
  }

  // Expiry check before timing-sensitive comparison
  if (record.expiresAt <= Date.now()) {
    tokenStore.delete(parts.id);
    return { ok: false, reason: "token expired" };
  }

  // Timing-safe secret comparison
  const incomingBuf = Buffer.from(parts.secret, "hex");
  if (
    incomingBuf.length !== record.tokenBuf.length ||
    !timingSafeEqual(incomingBuf, record.tokenBuf)
  ) {
    return { ok: false, reason: "invalid token" };
  }

  // Path scope check
  if (!pathInScope(urlPath, record.pathScope)) {
    return {
      ok: false,
      reason: `token scope '${record.pathScope}' does not cover '${urlPath}'`,
    };
  }

  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export interface AuthHandlerResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Handle POST /mdf/auth — receives payment proof and issues a bearer token.
 *
 * Request body (JSON):
 *   { "path": "/private/internals", "txHash": "0x...", "from": "0x...", "chain": "base", "currency": "USDC", "amount": "100.00" }
 *
 * This handler is intentionally separate from the payment verifier —
 * the caller (index.ts) runs payment verification first, then calls this
 * if requiresToken is true and verification passed.
 */
export function handleAuthRequest(
  body: string,
  loaded: LoadedConfig
): AuthHandlerResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "invalid JSON body" }),
    };
  }

  const path = typeof parsed.path === "string" ? parsed.path : null;
  const txHash = typeof parsed.txHash === "string" ? parsed.txHash : "unknown";
  const from = typeof parsed.from === "string" ? parsed.from : "unknown";

  if (!path) {
    return {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "missing required field: path" }),
    };
  }

  const result = issueToken(path, from, txHash, loaded);

  if (!result.ok) {
    return {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: result.reason }),
    };
  }

  return {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      token: result.token,
      expires_at: new Date(result.expiresAt).toISOString(),
      ttl_seconds: result.ttlSeconds,
    }),
  };
}
