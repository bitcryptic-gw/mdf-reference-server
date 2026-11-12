/**
 * A deliberately small Nostr relay client: enough for NWC, and no more.
 *
 * NWC is one request/response exchange per invoice over a relay, so this is not
 * a general-purpose Nostr library. What it does do carefully:
 *
 *  - **signed events**: id = SHA-256 of the NIP-01 serialisation, signed BIP-340;
 *  - **verified responses**: an incoming event is only accepted if its id matches
 *    its content, its signature verifies against the wallet pubkey, and it tags
 *    our request — a relay is not trusted to hand us a well-formed answer;
 *  - **bounded waits**: connect and response both have deadlines, so a silent
 *    relay cannot hang a 402;
 *  - **relay failover at connect only**: if the first relay refuses, the next is
 *    tried; once a request is published, the same socket is used for its answer.
 */

import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class RelayError extends Error {
  readonly kind: "unreachable" | "timeout" | "rejected" | "malformed";
  constructor(kind: RelayError["kind"], message: string) {
    super(message);
    this.name = "RelayError";
    this.kind = kind;
  }
}

/** NIP-01 event serialisation → id. */
export function eventId(event: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  const serialised = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return createHash("sha256").update(serialised, "utf8").digest("hex");
}

/** Build and sign an event. */
export function signEvent(
  event: { kind: number; tags: string[][]; content: string; created_at?: number },
  privateKeyHex: string
): NostrEvent {
  const priv = hexToBytes(privateKeyHex);
  const pubkey = Buffer.from(schnorr.getPublicKey(priv)).toString("hex"); // x-only, 64 hex
  const base = {
    pubkey,
    created_at: event.created_at ?? Math.floor(Date.now() / 1000),
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  };
  const id = eventId(base);
  const sig = Buffer.from(schnorr.sign(hexToBytes(id), priv)).toString("hex");
  return { id, ...base, sig };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new RelayError("malformed", "invalid hex input");
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

/**
 * Structural and cryptographic validation of an incoming event. Returns the
 * event when it is genuinely from `expectedAuthor`, else a reason.
 */
export function verifyEvent(
  raw: unknown,
  expectedAuthor: string
): { ok: true; event: NostrEvent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const e = raw as Partial<NostrEvent>;
  if (
    typeof e.id !== "string" ||
    typeof e.pubkey !== "string" ||
    typeof e.created_at !== "number" ||
    typeof e.kind !== "number" ||
    !Array.isArray(e.tags) ||
    typeof e.content !== "string" ||
    typeof e.sig !== "string"
  ) {
    return { ok: false, reason: "malformed event" };
  }
  if (e.pubkey !== expectedAuthor) return { ok: false, reason: "unexpected author" };

  const expectedId = eventId({
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags as string[][],
    content: e.content,
  });
  if (expectedId !== e.id) return { ok: false, reason: "id does not match content" };

  let valid = false;
  try {
    valid = schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  return { ok: true, event: e as NostrEvent };
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

export interface RelayOptions {
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

interface Pending {
  resolve: (event: NostrEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Validates a candidate before it is accepted as the answer. */
  accept: (event: NostrEvent) => boolean;
}

/**
 * One relay connection, with NWC's request/response on top of it.
 *
 * Bun's global `WebSocket` is used directly: no dependency, and the shape of the
 * protocol (publish, subscribe, await one matching event) is small enough that a
 * library would obscure it.
 */
export class RelayConnection {
  private socket: WebSocket;
  private readonly walletPubkey: string;
  private readonly options: RelayOptions;
  private pending: Pending | null = null;
  private closed = false;

  private constructor(socket: WebSocket, walletPubkey: string, options: RelayOptions) {
    this.socket = socket;
    this.walletPubkey = walletPubkey;
    this.options = options;
  }

  static connect(url: string, walletPubkey: string, options: RelayOptions): Promise<RelayConnection> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new RelayError("unreachable", `relay ${url}: ${(err as Error).message}`));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new RelayError("timeout", `relay ${url}: connect timed out`));
      }, options.connectTimeoutMs);

      const connection = new RelayConnection(socket, walletPubkey, options);

      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(connection);
      });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RelayError("unreachable", `relay ${url}: connection failed`));
      });
      socket.addEventListener("message", (event: MessageEvent) =>
        connection.onMessage(typeof event.data === "string" ? event.data : "")
      );
      socket.addEventListener("close", () => {
        connection.closed = true;
        connection.failPending(new RelayError("unreachable", "relay closed the connection"));
      });
    });
  }

  private onMessage(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;

    const [type, ...rest] = msg as [string, ...unknown[]];

    if (type === "EVENT") {
      const raw = rest[1];
      const pending = this.pending;
      if (!pending) return;
      const checked = verifyEvent(raw, this.walletPubkey);
      if (!checked.ok) return; // ignore forged or malformed events
      if (!pending.accept(checked.event)) return;
      this.finishPending();
      pending.resolve(checked.event);
      return;
    }

    if (type === "OK") {
      // ["OK", id, accepted, message] — a rejected publish is a hard failure.
      const accepted = rest[1];
      const message = typeof rest[2] === "string" ? rest[2] : "";
      if (accepted === false) {
        const pending = this.pending;
        if (!pending) return;
        this.finishPending();
        pending.reject(
          new RelayError(
            /restricted|unauthori[sz]ed|permission/i.test(message) ? "rejected" : "malformed",
            `relay rejected the request: ${message || "no reason"}`
          )
        );
      }
      return;
    }

    if (type === "CLOSED" || type === "NOTICE") {
      const pending = this.pending;
      if (!pending) return;
      const message = typeof rest[0] === "string" ? rest[0] : "";
      this.finishPending();
      pending.reject(new RelayError("rejected", `relay: ${message || type}`));
    }
  }

  private finishPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private failPending(err: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.finishPending();
    pending.reject(err);
  }

  /**
   * Publish `event` and wait for a response event that `accept` claims.
   *
   * Subscribes *before* publishing so a fast wallet response cannot be missed.
   */
  request(event: NostrEvent, accept: (event: NostrEvent) => boolean): Promise<NostrEvent> {
    if (this.closed) {
      return Promise.reject(new RelayError("unreachable", "relay connection is closed"));
    }
    const subscriptionId = "mdf-" + randomBytes(6).toString("hex");

    return new Promise<NostrEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending;
        this.finishPending();
        this.send(["CLOSE", subscriptionId]);
        reject(new RelayError("timeout", "wallet did not answer in time"));
      }, this.options.responseTimeoutMs);

      this.pending = { resolve, reject, timer, accept };

      this.send([
        "REQ",
        subscriptionId,
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [this.walletPubkey],
          "#e": [event.id],
          limit: 1,
        },
      ]);
      this.send(["EVENT", event]);
    });
  }

  private send(message: unknown[]): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      this.failPending(new RelayError("unreachable", `relay send failed: ${(err as Error).message}`));
    }
  }

  close(): void {
    this.closed = true;
    this.failPending(new RelayError("unreachable", "connection closed"));
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Connect to the first relay that answers.
 *
 * Connect-time failover only: once a request is published, its answer must come
 * from the same relay, because the request is addressed to that connection.
 */
export async function connectAnyRelay(
  urls: readonly string[],
  walletPubkey: string,
  options: RelayOptions
): Promise<RelayConnection> {
  let last: Error | null = null;
  for (const url of urls) {
    try {
      return await RelayConnection.connect(url, walletPubkey, options);
    } catch (err) {
      last = err as Error;
    }
  }
  throw new RelayError(
    "unreachable",
    `no relay answered (${urls.length} tried)${last ? `: ${last.message}` : ""}`
  );
}
