/**
 * The lnbtc replay store, and the token store that shares it.
 *
 * The scheme requires the consumption record to outlive the invoice:
 *
 *   "The replay entry MUST remain until at least one hour after
 *    `invoice_end + skew`. It MUST NOT be removed while the invoice can still
 *    pass validation."
 *
 * So the TTL is derived per entry, never a constant. With the demo's 300 s offer
 * window and the scheme's 60 s clock-skew allowance, the numbers are:
 *
 *   invoice_end            = creation + 300 s
 *   payable until          = invoice_end + 60 s  = 360 s after creation
 *   replay record retained = 360 s + 3600 s      = 3960 s (66 minutes)
 *
 * A preimage replayed one second inside that window is refused by the store; a
 * second after the record expires, the invoice can no longer pass validation
 * either, so there is no gap in which a replay would be accepted.
 *
 * The key is the scheme's canonical consumption key — `network:payment_hash` —
 * stored literally, and the insert is `SET … NX EX`, which is atomic and fails
 * when the key exists. `NX` is the whole point: a read-then-write would let two
 * concurrent claims both succeed.
 *
 * Failure is closed. An unreachable store returns `unavailable`, and the caller
 * omits the lnbtc rail from the offer (and refuses to settle an accepted proof)
 * rather than serving content on an unverified claim.
 */

import { connect, type Socket } from "node:net";

/** Clock-skew allowance the scheme defaults to, in seconds. */
export const REPLAY_SKEW_SECONDS = 60;
/** Minimum retention after the invoice stops being payable, in seconds. */
export const REPLAY_RETENTION_AFTER_EXPIRY_SECONDS = 3600;

/**
 * TTL for one replay record, in seconds.
 *
 * `invoiceExpirySeconds` is `maxTimeoutSeconds` (the BOLT11 expiry must equal it),
 * not the remaining lifetime — the record is written at settle time, and this
 * keeps it valid for the whole window in which any invoice of that shape could
 * still be accepted.
 */
export function replayTtlSeconds(
  invoiceExpirySeconds: number,
  skewSeconds: number = REPLAY_SKEW_SECONDS
): number {
  if (!Number.isFinite(invoiceExpirySeconds) || invoiceExpirySeconds <= 0) {
    throw new Error("replay TTL needs a positive invoice expiry");
  }
  if (!Number.isFinite(skewSeconds) || skewSeconds < 0) {
    throw new Error("replay TTL needs a non-negative skew allowance");
  }
  return Math.ceil(invoiceExpirySeconds + skewSeconds + REPLAY_RETENTION_AFTER_EXPIRY_SECONDS);
}

export type ClaimResult = "claimed" | "duplicate" | "unavailable";

/**
 * Store health for `/health`, as the failure *kind*.
 *
 * "auth" exists because the worst outage this store ever had was a credential
 * one: a password-protected Valkey answering NOAUTH looks exactly like an
 * unreachable store from the outside, and reporting it as a generic outage sent
 * the first investigation in the wrong direction.
 */
export type StoreHealth = "ok" | "unreachable" | "auth";

export interface ReplayStore {
  /** Atomically claim `network:payment_hash` for `ttlSeconds`. */
  claim(network: string, paymentHash: string, ttlSeconds: number): Promise<ClaimResult>;
  /** Reachability probe: AUTH plus a cheap command on the authenticated connection. */
  health(): Promise<StoreHealth>;
  close(): void;
}

/** In-memory store for tests and for a single-instance deployment. */
export class MemoryReplayStore implements ReplayStore {
  private readonly keys = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async claim(network: string, paymentHash: string, ttlSeconds: number): Promise<ClaimResult> {
    const key = replayKey(network, paymentHash);
    const now = this.now();
    const expiresAt = this.keys.get(key);
    if (expiresAt !== undefined && expiresAt > now) return "duplicate";
    this.keys.set(key, now + ttlSeconds * 1000);
    return "claimed";
  }

  async health(): Promise<StoreHealth> {
    return "ok";
  }

  close(): void {
    this.keys.clear();
  }

  /** Test helper: how many live records exist. */
  size(): number {
    return [...this.keys.values()].filter((exp) => exp > this.now()).length;
  }
}

/** Does a RESP error mean "you are not authenticated" rather than "no server"? */
export function isAuthError(message: string | undefined): boolean {
  return !!message && /^(NOAUTH|WRONGPASS)/.test(message);
}

/** The scheme's canonical consumption key. Never reformat this. */
export function replayKey(network: string, paymentHash: string): string {
  return `${network}:${paymentHash.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Valkey (RESP over a plain socket — no client dependency)
// ---------------------------------------------------------------------------

export interface ValkeyOptions {
  host: string;
  port: number;
  /** Read from a mounted file by the loader; never logged. */
  password?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

interface RespReply {
  kind: "simple" | "error" | "integer" | "bulk" | "nil";
  value?: string;
}

/**
 * Minimal RESP client: connect, optional AUTH, then one command per call over a
 * fresh short-lived connection.
 *
 * Per request rather than a pooled connection on purpose: a payment attempt is
 * rare, a stale pooled socket is a failure mode with no upside here, and a fresh
 * connection makes "unavailable" unambiguous. The tailnet is WireGuard-encrypted,
 * so plain `redis://` is acceptable and documented as such.
 */
export class ValkeyReplayStore implements ReplayStore {
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

  async claim(network: string, paymentHash: string, ttlSeconds: number): Promise<ClaimResult> {
    const key = replayKey(network, paymentHash);
    let socket: Socket | null = null;
    try {
      socket = await this.connect();
      if (this.options.password) {
        const auth = await this.command(socket, ["AUTH", this.options.password]);
        if (auth.kind === "error") return "unavailable";
      }
      // Atomic fail-on-exists with a per-entry expiry.
      const reply = await this.command(socket, [
        "SET",
        key,
        "1",
        "NX",
        "EX",
        String(Math.max(1, Math.ceil(ttlSeconds))),
      ]);
      if (reply.kind === "nil") return "duplicate";
      if (reply.kind === "simple" && reply.value === "OK") return "claimed";
      return "unavailable";
    } catch {
      return "unavailable";
    } finally {
      socket?.destroy();
    }
  }

  /**
   * AUTH + PING on a fresh connection — the same path a claim takes, because a
   * probe that skips AUTH or skips the command can report "ok" while every real
   * write fails.
   */
  async health(): Promise<StoreHealth> {
    let socket: Socket | null = null;
    try {
      socket = await this.connect();
      if (this.options.password) {
        const auth = await this.command(socket, ["AUTH", this.options.password]);
        if (auth.kind === "error") return isAuthError(auth.value) ? "auth" : "unreachable";
      }
      const reply = await this.command(socket, ["PING"]);
      if (reply.kind === "error") return isAuthError(reply.value) ? "auth" : "unreachable";
      return reply.kind === "simple" && reply.value === "PONG" ? "ok" : "unreachable";
    } catch {
      return "unreachable";
    } finally {
      socket?.destroy();
    }
  }

  close(): void {
    // Nothing pooled to close.
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("valkey connect timeout"));
      }, this.options.connectTimeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setTimeout(this.options.commandTimeoutMs, () => {
          socket.destroy();
        });
        resolve(socket);
      });
    });
  }

  private command(socket: Socket, args: string[]): Promise<RespReply> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseResp(buffer);
        if (!parsed) return;
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(parsed.reply);
      };
      const onError = (err: Error) => {
        socket.off("data", onData);
        reject(err);
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.write(encodeResp(args));
    });
  }
}

function encodeResp(args: string[]): Buffer {
  const parts = [Buffer.from(`*${args.length}\r\n`, "ascii")];
  for (const arg of args) {
    const body = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${body.length}\r\n`, "ascii"), body, Buffer.from("\r\n", "ascii"));
  }
  return Buffer.concat(parts);
}

/** Parse one RESP reply from the front of `buffer`; null when incomplete. */
export function parseResp(buffer: Buffer): { reply: RespReply; rest: Buffer } | null {
  if (buffer.length === 0) return null;
  const type = String.fromCharCode(buffer[0]);
  const eol = buffer.indexOf("\r\n");
  if (eol === -1) return null;
  const line = buffer.subarray(1, eol).toString("utf8");
  const rest = buffer.subarray(eol + 2);

  switch (type) {
    case "+":
      return { reply: { kind: "simple", value: line }, rest };
    case "-":
      return { reply: { kind: "error", value: line }, rest };
    case ":":
      return { reply: { kind: "integer", value: line }, rest };
    case "$": {
      const len = Number(line);
      if (len === -1) return { reply: { kind: "nil" }, rest };
      if (!Number.isInteger(len) || len < 0) return { reply: { kind: "error", value: "bad bulk" }, rest };
      if (rest.length < len + 2) return null;
      return { reply: { kind: "bulk", value: rest.subarray(0, len).toString("utf8") }, rest: rest.subarray(len + 2) };
    }
    default:
      return { reply: { kind: "error", value: `unknown RESP type ${type}` }, rest };
  }
}
