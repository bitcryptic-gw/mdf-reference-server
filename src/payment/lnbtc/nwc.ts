/**
 * NWC client: mint invoices over NIP-47, and nothing else.
 *
 * Alby Hub's HTTP API cannot set a description hash or an expiry, both of which
 * the lnbtc scheme makes mandatory, so minting goes over NWC. The client is
 * deliberately tiny and single-purpose:
 *
 *   - `makeInvoice()` — the only method the server needs;
 *   - `getInfo()` — used **once at startup** to verify the connection's
 *     permissions (a wider credential refuses startup);
 *   - no pay/lookup methods exist here at all. If a future need appears, it is a
 *     deliberate addition, not a latent capability.
 *
 * Every payload is NIP-44 encrypted; the request carries the
 * `["encryption","nip44_v2"]` tag Alby Hub reads to pick its cipher. Failures are
 * categorised so the invoice breaker can tell "wallet unreachable" from "wallet
 * refused", and the URI is never included in an error message.
 */

import { randomBytes } from "node:crypto";
import { getPublicKey } from "@noble/secp256k1";
import { getConversationKey, encrypt, decrypt } from "./nip44.ts";
import { parseNwcUri, redactNwcUri, type NwcUri } from "./nwc-uri.ts";
import {
  NWC_REQUEST_KIND,
  RelayError,
  connectAllRelays,
  firstResponse,
  signEvent,
  type RelayOptions,
} from "./relay.ts";

export type NwcFailureKind = "unreachable" | "timeout" | "auth" | "rejected" | "malformed";

/** A categorised NWC failure. `message` is safe to log: no URI, no secret. */
export class NwcError extends Error {
  readonly kind: NwcFailureKind;
  constructor(kind: NwcFailureKind, message: string) {
    super(message);
    this.name = "NwcError";
    this.kind = kind;
  }
}

export interface NwcClientOptions {
  /** The `nostr+walletconnect://` URI (a file-mounted secret). */
  uri: string;
  /**
   * Client signing key. Normally omitted: NIP-47 says the URI's `secret` IS the
   * client's private key ("The client MUST use this to sign events and encrypt
   * payloads"). The override exists for tests that need a fixed key.
   */
  clientSecretKey?: string;
  connectTimeoutMs?: number;
  /** Bound on a single wallet round trip. */
  responseTimeoutMs?: number;
}

export interface MadeInvoice {
  invoice: string;
  paymentHash: string;
}

export interface WalletInfo {
  alias?: string;
  pubkey?: string;
  network?: string;
  /** Methods the connection is permitted to call, when the wallet reports them. */
  methods: string[] | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

interface NwcResponse {
  result_type?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
  result?: unknown;
}

/**
 * A single NWC connection, used per call and closed immediately.
 *
 * Per-call connections keep the failure modes obvious (no half-open socket to
 * reason about) at the cost of a relay handshake per mint — acceptable when a
 * mint happens only on an unpaid 402, and bounded by the timeouts below.
 */
export class NwcClient {
  private readonly uri: NwcUri;
  private readonly clientSecretKey: string;
  private readonly options: RelayOptions;

  constructor(options: NwcClientOptions) {
    const parsed = parseNwcUri(options.uri);
    if (!parsed.ok) {
      // Never echo the URI — it carries the secret.
      throw new NwcError("malformed", `NWC URI is invalid (${parsed.reason})`);
    }
    this.uri = parsed.value;
    // The URI's `secret` is the client key, not a shared password: the wallet
    // authorises the connection by the public key derived from it. Generating a
    // random key here made every request come from an unknown author, which the
    // wallet silently ignores — a failure this comment exists to prevent.
    this.clientSecretKey = options.clientSecretKey ?? parsed.value.secret;
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      responseTimeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    };
  }

  /** The x-only public key this connection authenticates as (NIP-47). */
  get clientPubkey(): string {
    // x-only, as every Nostr pubkey is: the compressed key minus its parity byte.
    return Buffer.from(getPublicKey(Buffer.from(this.clientSecretKey, "hex"), true))
      .subarray(1)
      .toString("hex");
  }

  /** Redacted form, for logs and health output. */
  describe(): string {
    return redactNwcUri(
      `nostr+walletconnect://${this.uri.walletPubkey}?${this.uri.relays
        .map((r) => `relay=${encodeURIComponent(r)}`)
        .join("&")}&secret=${this.uri.secret}`
    );
  }

  private conversationKey(): Uint8Array {
    return getConversationKey(this.clientSecretKey, this.uri.walletPubkey);
  }

  /**
   * Mint an invoice for an exact millisatoshi amount that commits to
   * `descriptionHash` and expires in `expirySeconds`.
   */
  async makeInvoice(params: {
    amountMsat: number;
    descriptionHash: string;
    expirySeconds: number;
  }): Promise<MadeInvoice> {
    if (!/^[0-9a-f]{64}$/.test(params.descriptionHash)) {
      throw new NwcError("malformed", "description hash must be 64 lowercase hex characters");
    }
    if (!Number.isSafeInteger(params.amountMsat) || params.amountMsat < 1000) {
      throw new NwcError("malformed", "invoice amount must be at least 1000 msat");
    }
    // The wallet refuses sub-satoshi invoices; failing here names the cause
    // instead of surfacing an opaque wallet rejection at request time.
    if (params.amountMsat % 1000 !== 0) {
      throw new NwcError("malformed", "invoice amount must be a whole number of satoshis");
    }
    if (!Number.isSafeInteger(params.expirySeconds) || params.expirySeconds <= 0) {
      throw new NwcError("malformed", "invoice expiry must be a positive integer");
    }

    const result = await this.call("make_invoice", {
      amount: params.amountMsat,
      description_hash: params.descriptionHash,
      expiry: params.expirySeconds,
    });

    const invoice = (result as { invoice?: unknown }).invoice;
    const paymentHash = (result as { payment_hash?: unknown }).payment_hash;
    if (typeof invoice !== "string" || invoice.length === 0) {
      throw new NwcError("malformed", "wallet returned no invoice");
    }
    if (typeof paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(paymentHash)) {
      throw new NwcError("malformed", "wallet returned no payment hash");
    }
    return { invoice, paymentHash };
  }

  /** Wallet info, including the permission list when the wallet reports it. */
  async getInfo(): Promise<WalletInfo> {
    const result = (await this.call("get_info", {})) as Record<string, unknown>;
    const methods = Array.isArray(result.methods)
      ? result.methods.filter((m): m is string => typeof m === "string")
      : null;
    return {
      alias: typeof result.alias === "string" ? result.alias : undefined,
      pubkey: typeof result.pubkey === "string" ? result.pubkey : undefined,
      network: typeof result.network === "string" ? result.network : undefined,
      methods,
    };
  }

  /** Publish a request and decode its response. */
  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      // Publish on every relay in the URI and take the first valid answer: Alby
      // Hub subscribes to all of them, and one silent relay should not strand a
      // request that the other would have answered.
      const { connections, errors } = await connectAllRelays(
        this.uri.relays,
        this.uri.walletPubkey,
        this.options
      );
      if (connections.length === 0) {
        throw new RelayError(
          "unreachable",
          `no relay answered (${this.uri.relays.length} tried)` +
            (errors.length > 0 ? `: ${errors[0].message}` : "")
        );
      }

      const conversationKey = this.conversationKey();
      const event = signEvent(
        {
          kind: NWC_REQUEST_KIND,
          tags: [
            ["p", this.uri.walletPubkey],
            ["encryption", "nip44_v2"],
          ],
          content: encrypt(JSON.stringify({ method, params }), conversationKey, randomBytes(32)),
        },
        this.clientSecretKey
      );

      const responseEvent = await firstResponse(connections, event, (candidate) => {
        const tags = candidate.tags ?? [];
        const matches = tags.some((tag) => tag[0] === "e" && tag[1] === event.id);
        const addressedToUs = tags.some(
          (tag) => tag[0] === "p" && tag[1] === event.pubkey
        );
        return matches && addressedToUs;
      });

      let payload: NwcResponse;
      try {
        payload = JSON.parse(decrypt(responseEvent.content, conversationKey)) as NwcResponse;
      } catch {
        throw new NwcError("malformed", "wallet response could not be decrypted");
      }

      if (payload.error) {
        const code =
          typeof payload.error.code === "string" ? payload.error.code.toUpperCase() : "";
        const message =
          typeof payload.error.message === "string" ? payload.error.message : "no detail";
        throw new NwcError(classifyErrorCode(code, message), `wallet refused ${method}: ${code || "error"}`);
      }
      if (payload.result_type && payload.result_type !== method) {
        throw new NwcError("malformed", `wallet answered ${String(payload.result_type)} to ${method}`);
      }
      return payload.result ?? {};
    } catch (err) {
      if (err instanceof NwcError) throw err;
      if (err instanceof RelayError) {
        const kind: NwcFailureKind =
          err.kind === "timeout" ? "timeout" : err.kind === "rejected" ? "auth" : "unreachable";
        throw new NwcError(kind, err.message);
      }
      throw new NwcError("malformed", `NWC call failed: ${(err as Error).message}`);
    }
  }
}

/** Map NIP-47 error codes onto the invoice breaker's categories. */
export function classifyErrorCode(code: string, message: string): NwcFailureKind {
  const c = `${code} ${message}`.toLowerCase();
  if (c.includes("unauthorized") || c.includes("restricted") || c.includes("permission")) {
    return "auth";
  }
  if (c.includes("timeout") || c.includes("time out") || c.includes("timed out")) return "timeout";
  if (c.includes("not_found") || c.includes("not found") || c.includes("insufficient")) {
    return "rejected";
  }
  if (c.includes("unreachable") || c.includes("connection")) return "unreachable";
  return "rejected";
}
