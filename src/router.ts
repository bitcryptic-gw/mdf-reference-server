/**
 * mdf-server — HTTP request router
 *
 * Owns the single request-routing order for the content server. Extracted from
 * index.ts so the ordering (and its regressions) can be exercised in-process
 * by the test suite without starting a listening server.
 *
 * Request routing order:
 *   1. Health     — /health
 *   2. Discovery  — /mdf.json, /llms.txt
 *   3. Feed       — /feed.xml
 *   4. Token      — POST <auth.endpoint> / /mdf/auth / /mdf/pay: a payment in
 *                   the same request, then a bearer token for that section
 *   5. Existence  — 404 for paths with no content, before any pricing
 *   6. Payment    — free (serve), token (Bearer), or an x402 v2 rail
 *   7. Content    — serve markdown or HTML
 *
 * Two hard cuts shape the payment half of this file. The only payment header
 * read is `PAYMENT-SIGNATURE`: `X-PAYMENT` is named in the attempt log and
 * otherwise inert, because the spec 0.3.1 transport moved and a v1 client must
 * be told to upgrade rather than silently served. And every rail is described by
 * the same price entry that generates `/mdf.json`, so a 402 can only offer a
 * subset of what the site declares — never anything else.
 */

import { accessSync, constants } from "fs";
import { serveDiscovery } from "./discovery/discovery.ts";
import { serveFeed } from "./feed/handler.ts";
import { serveContent, serveNotFound, resolveContentPath } from "./content/handler.ts";
import { prefersMarkdown } from "./content/accept.ts";
import { createHash } from "crypto";
import {
  buildOfferFor,
  entryFor,
  paymentIdentity,
  verifyPayment,
  settlementHeader,
  type RequestContext,
  type VerifyResult,
} from "./payment/payment.ts";
import { render402, renderUnavailable } from "./payment/402.ts";
import { HEADER } from "./payment/headers.ts";
import { logAttempt, type AttemptOutcome } from "./payment/attempt-log.ts";
import { resolveClientKey } from "./payment/client-key.ts";
import { issueToken, validateToken, type PendingToken } from "./auth/token-store.ts";
import { decodeHeaderObject, MAX_PAYMENT_HEADER_CHARS } from "./payment/headers.ts";
import { isLnbtcNetwork, tokenScopeForPath } from "./payment/rails.ts";
import type { StoreHealth } from "./payment/lnbtc/replay-store.ts";
import { SERVER_VERSION } from "./version.ts";
import type { LoadedConfig } from "./config/loader.ts";

// ---------------------------------------------------------------------------
// Request size limit
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024; // 64 KB

async function readBody(req: Request): Promise<string | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return null;
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request logger
// ---------------------------------------------------------------------------

function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  extra?: Record<string, unknown>
) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      method,
      path,
      status,
      ms: durationMs,
      ...extra,
    })
  );
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string, noStore = false): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  // Payment paths pass noStore so a failed payment attempt can never be stored
  // by a shared cache — the same guard the 402 builder applies.
  if (noStore) headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function toResponse(result: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): Response {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Liveness + readiness probe for Caddy health checks.
 *
 * Verifies the two filesystem dependencies the app actually reads/writes at
 * runtime: the content directory (read per-request) and the data directory
 * (feed-event log). Config and secrets are startup-time only — if they were
 * broken the process would not be running, so they are not checked here.
 *
 * External payment deps are deliberately NOT probed on every call: the
 * facilitator is only touched on the payment path, and its outage must not take
 * a healthy content-serving instance out of the Caddy pool. The rail states
 * below are *reported*, not *probed*, except the replay store, which is a cheap
 * PING at most once every 30 s (the store being unreachable is a fail-closed
 * condition for lnbtc, so an operator needs to see it).
 *
 * The body is JSON carrying the server's *release* version (`version`) so a
 * deploy can be confirmed by asking the running process directly. `status`
 * preserves the old healthy/unhealthy signal; the HTTP status code remains the
 * authoritative probe. This is the release version, not the MDF protocol
 * version (`mdf_version` / `X-MDF-Version`).
 *
 * Member order is part of the contract: Kuma matches substrings, so `rails[]`
 * entries are emitted as exactly `{"rail":"<network>","status":"<state>"}`.
 */
function isHealthy(loaded: LoadedConfig): boolean {
  try {
    accessSync(loaded.contentDir, constants.R_OK);
    accessSync(process.env.MDF_DATA_DIR ?? "/app/data", constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Can the lnbtc rail actually be offered? The gate answers "is the wallet
 * permitted and reachable"; a rail also needs the receiver pubkey, which is
 * resolved from `get_info` when it is not configured.
 */
function lnbtcAvailable(loaded: LoadedConfig): boolean {
  return !!loaded.lnbtc && loaded.lnbtc.gate.canOffer() && !!loaded.lnbtc.payeePubkey;
}

/** One compact entry per configured rail, deduplicated by network. */
function railStates(loaded: LoadedConfig): Array<{ rail: string; status: string }> {
  const seen = new Map<string, string>();
  const entries = [
    loaded.config.pricing.default,
    ...Object.values(loaded.config.pricing.sections ?? {}),
  ];
  for (const entry of entries) {
    for (const rail of entry.rails) {
      if (seen.has(rail.network)) continue;
      const status = isLnbtcNetwork(rail.network)
        ? lnbtcAvailable(loaded)
          ? "ok"
          : "degraded"
        : "ok";
      seen.set(rail.network, status);
    }
  }
  return [...seen].map(([rail, status]) => ({ rail, status }));
}

/** The 0.2.7 `lightning` block, present only while the rail is degraded. */
function lightningBlock(loaded: LoadedConfig): Record<string, unknown> | null {
  const rt = loaded.lnbtc;
  if (!rt) return null;

  const breaker = rt.breakerRuntime?.snapshot() ?? null;
  if (breaker && breaker.status === "degraded") return { ...breaker };

  if (lnbtcAvailable(loaded)) return null;
  const gate = rt.gate.snapshot();
  return {
    status: "degraded",
    ...(gate.since ? { since: gate.since } : {}),
    category: gate.category ?? "unreachable",
    ...(breaker?.next_retry ? { next_retry: breaker.next_retry } : {}),
  };
}

/** A store probe as `/health` reports it: ok, or unavailable with the kind. */
function storeBlock(health: StoreHealth): { status: string; category?: string } {
  return health === "ok" ? { status: "ok" } : { status: "unavailable", category: health };
}

async function healthResponse(loaded: LoadedConfig): Promise<Response> {
  const ok = isHealthy(loaded);
  const lightning = lightningBlock(loaded);

  // Both stores are probed the way real requests use them (AUTH plus a cheap
  // command on the authenticated connection). A health check that skips AUTH
  // reports "ok" while every write fails — that is the shape of the outage that
  // hid the token store's missing AUTH.
  const [replay, token] = await Promise.all([
    loaded.replayStore ? loaded.replayStore.health() : Promise.resolve(null),
    loaded.tokenStore.health(),
  ]);

  const rails = railStates(loaded).map((state) =>
    // A rail whose only durable dependency is down is degraded, not ok.
    state.rail.startsWith("lnbtc:") && replay !== null && replay !== "ok"
      ? { ...state, status: "degraded" }
      : state
  );

  const body = JSON.stringify({
    status: ok ? "ok" : "unavailable",
    version: SERVER_VERSION,
    rails,
    token_store: storeBlock(token),
    ...(replay !== null ? { replay_store: storeBlock(replay) } : {}),
    ...(lightning ? { lightning } : {}),
  });
  return new Response(body, {
    status: ok ? 200 : 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// Payment helpers
// ---------------------------------------------------------------------------

export interface HandleOptions {
  /**
   * Transport peer address, from `server.requestIP(req)` in index.ts. Absent in
   * tests, which makes the client key `unknown` — and, with an empty trusted
   * proxy list, that is also the production-safe default.
   */
  peer?: string | null;
}

function clientKeyFor(req: Request, loaded: LoadedConfig, options: HandleOptions): string {
  const trusted = loaded.config.server?.trusted_proxies ?? [];
  return resolveClientKey({
    peer: options.peer ?? null,
    realIpHeader: req.headers.get("x-real-ip"),
    trustedProxies: trusted,
  }).key;
}

/** Absolute URL of a resource path, with the request's query string. */
function absoluteUrl(loaded: LoadedConfig, urlPath: string, search = ""): string {
  return `${loaded.config.site.url.replace(/\/$/, "")}${urlPath}${search}`;
}

function requestContext(
  loaded: LoadedConfig,
  urlPath: string,
  resourceUrl: string,
  method: string,
  headers: Record<string, string | null>,
  clientKey: string
): RequestContext {
  return { urlPath, resourceUrl, method, headers, clientKey };
}

/** Outcome bucket for the attempt log, from a verification result. */
function outcomeFor(result: VerifyResult): AttemptOutcome {
  switch (result.status) {
    case "approved":
      return "settled";
    case "no_payment":
      return "no_payment";
    case "error":
      return "error";
    case "rejected":
      return result.reason === "replay_rejected" ? "replay_rejected" : "verify_fail";
  }
}

/**
 * The 402 (or 503 when nothing can be offered) for a path.
 *
 * `renderUnavailable` is used whenever no rail survives degradation: a 402 with
 * an empty `accepts[]` would be a challenge a client cannot answer.
 */
async function offerResponse(
  loaded: LoadedConfig,
  context: RequestContext,
  options: { error?: VerifyResult["reason"]; mimeType?: string }
): Promise<Response> {
  const startedAtMs = Date.now();
  const { offer, doc } = await buildOfferFor(loaded, context, {
    ...(options.error ? { error: options.error } : {}),
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    startedAtMs,
  });

  if (offer.allUnavailable) {
    // A rate-limited mint carries its own hint; a rail degraded by an outage
    // borrows the breaker's next probe time, so the client is told when to come
    // back rather than retrying into the same window.
    const retryAfterSeconds =
      offer.retryAfterSeconds ?? loaded.lnbtc?.breakerRuntime?.retryAfterSeconds() ?? undefined;
    return toResponse(
      renderUnavailable({
        resourceUrl: context.resourceUrl,
        error: "payment_unavailable",
        ...(retryAfterSeconds !== undefined && retryAfterSeconds !== null
          ? { retryAfterSeconds }
          : {}),
      })
    );
  }
  return toResponse(render402(doc));
}

function mimeTypeFor(acceptHeader: string | null | undefined): string {
  return prefersMarkdown(acceptHeader) ? "text/markdown" : "text/html";
}

// ---------------------------------------------------------------------------
// Token issuance endpoint
// ---------------------------------------------------------------------------

/**
 * A settled payment's token is written with a short retry, and the payment is
 * recorded first so a client can retry the *same* `PAYMENT-SIGNATURE` and get the
 * token without paying twice. Fifteen minutes is the retry window; the payment
 * is single-use inside it and unretryable after.
 */
const PENDING_TTL_SECONDS = 900;
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_MS = 150;
const RETRY_AFTER_SECONDS = 5;

function signatureHash(paymentSignature: string): string {
  return createHash("sha256").update(`mdf-payment-signature-v1:${paymentSignature}`).digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a store write with a short retry; a flapping store often takes on the second. */
async function writeWithRetry(write: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    if (await write()) return true;
    if (attempt < WRITE_ATTEMPTS - 1) await sleep(WRITE_RETRY_MS);
  }
  return false;
}

/** Issue a token with a short retry, returning the issued credential or null. */
async function issueWithRetry(
  issue: () => Promise<{ token: string; expiresAt: number; ttlSeconds: number; id: string } | null>
): Promise<{ token: string; expiresAt: number; ttlSeconds: number; id: string } | null> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const issued = await issue();
    if (issued) return issued;
    if (attempt < WRITE_ATTEMPTS - 1) await sleep(WRITE_RETRY_MS);
  }
  return null;
}

function pendingResponse503(): Response {
  const response = jsonError(503, "token store unavailable", true);
  response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return response;
}

async function handleTokenEndpoint(
  req: Request,
  loaded: LoadedConfig,
  urlPath: string,
  clientKey: string
): Promise<{ response: Response; attempt: AttemptRecordInput | null }> {
  const start = Date.now();
  const method = req.method;

  if (method !== "POST") {
    return { response: jsonError(405, "Method Not Allowed — use POST"), attempt: null };
  }

  const body = await readBody(req);
  if (body === null) {
    return { response: jsonError(413, "Request body too large", true), attempt: null };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { response: jsonError(400, "Invalid JSON body", true), attempt: null };
  }

  // `resource` is the documented field; `path` is accepted as an alias for the
  // pre-0.2.9 shape. Anything else a client asserts about payment (`txHash`,
  // `from`, `amount`) is ignored — the payment header is the only evidence.
  const resource =
    typeof parsed.resource === "string"
      ? parsed.resource
      : typeof parsed.path === "string"
        ? parsed.path
        : null;
  if (!resource) {
    return { response: jsonError(400, "Missing or invalid field: resource", true), attempt: null };
  }

  let payPath: string;
  try {
    payPath = new URL(resource).pathname;
  } catch {
    payPath = resource.startsWith("/") ? resource : `/${resource}`;
  }

  const { tokenAccess } = entryFor(loaded, payPath);
  // A token is only meaningful for a token-access section. Refusing here keeps
  // a payment for a per-fetch section from being settled and then discarded, and
  // keeps the endpoint from becoming a general-purpose pay relay.
  if (!loaded.config.auth || !tokenAccess) {
    return {
      response: jsonError(400, "Resource is not a token-access section", true),
      attempt: null,
    };
  }

  // Probe the store before any money moves: a token payment settles on-chain
  // first, so discovering the store is down at issue time would take the payer's
  // payment and hand back nothing.
  const storeHealth = await loaded.tokenStore.health();
  if (storeHealth !== "ok") {
    return {
      response: jsonError(503, "token store unavailable", true),
      attempt: {
        path: urlPath,
        headers: {},
        outcome: "error",
        reason: "token_store_unavailable",
        status: 503,
        startedAtMs: start,
        client: clientKey,
      },
    };
  }

  const paymentSignature = req.headers.get(HEADER.signature.toLowerCase());
  const sawLegacy = req.headers.get("x-payment");
  const resourceUrl = absoluteUrl(loaded, payPath);
  const context = requestContext(
    loaded,
    payPath,
    resourceUrl,
    "POST",
    { "content-type": req.headers.get("content-type") },
    clientKey
  );
  const pathScope = tokenScopeForPath(payPath);
  const attemptBase = {
    path: urlPath,
    headers: { paymentSignature, xPayment: sawLegacy },
    startedAtMs: start,
    client: clientKey,
  };

  const respondWithToken = (token: {
    token: string;
    expiresAt: number;
    ttlSeconds: number;
  }, settlement: PendingToken["settlement"], rail: string | undefined) => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "token_issued",
        id_prefix: token.token.slice(0, 8),
        path_scope: pathScope,
        rail: rail ?? "unknown",
        expires_at: new Date(token.expiresAt).toISOString(),
      })
    );
    const paymentHeader = settlement
      ? Buffer.from(
          JSON.stringify({
            success: true,
            transaction: settlement.transaction,
            network: settlement.network,
            ...(settlement.payer ? { payer: settlement.payer } : {}),
          }),
          "utf8"
        ).toString("base64")
      : null;

    return new Response(
      JSON.stringify({
        token: token.token,
        expires_at: new Date(token.expiresAt).toISOString(),
        ttl_seconds: token.ttlSeconds,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // The body carries a bearer credential — never cacheable anywhere.
          "Cache-Control": "no-store",
          ...(paymentHeader ? { [HEADER.response]: paymentHeader } : {}),
        },
      }
    );
  };

  // ── 1. Idempotent retry ───────────────────────────────────────────────────
  //
  // If this exact payment already settled here and its token was not written,
  // issue it now without verifying or settling again. The pending record is the
  // proof: it can only exist because /verify approved this payment, and the
  // signature hash makes it unreachable to anyone who cannot reproduce the
  // signed payload. A payment that already produced a token is refused, so one
  // payment never buys two credentials.
  const decoded = paymentSignature
    ? decodeHeaderObject<Record<string, unknown>>(paymentSignature, MAX_PAYMENT_HEADER_CHARS)
    : null;
  const identity = decoded?.ok ? paymentIdentity(decoded.value) : null;
  const sigHash = paymentSignature ? signatureHash(paymentSignature) : null;

  // The settlement of this attempt, if it has one yet; the retry path uses the
  // record's copy instead.
  let pendingSettlement: PendingToken["settlement"] | undefined;

  const issue = () =>
    issueToken(loaded.tokenStore, {
      urlPath: payPath,
      pathScope,
      issuedTo: pendingSettlement?.payer ?? "unknown",
      txHash: pendingSettlement?.transaction ?? "unknown",
      ttlSeconds: loaded.config.auth.token_ttl_seconds,
    });

  if (identity && sigHash) {
    const pending = await loaded.tokenStore.getPending(identity.key);
    if (pending) {
      const samePayment = pending.signatureHash === sigHash;
      const sameTarget = pending.pathScope === pathScope;

      if (!samePayment || !sameTarget || pending.issued) {
        return {
          response: jsonError(402, "Payment already used", true),
          attempt: {
            ...attemptBase,
            outcome: "replay_rejected",
            reason: "replay_rejected",
            rail: identity.rail,
            status: 402,
          },
        };
      }

      pendingSettlement = pending.settlement;
      const retried = await issueWithRetry(issue);
      if (!retried) {
        return {
          response: pendingResponse503(),
          attempt: {
            ...attemptBase,
            outcome: "error",
            reason: "token_store_unavailable",
            rail: identity.rail,
            status: 503,
          },
        };
      }

      if (!(await writeWithRetry(() =>
        loaded.tokenStore.putPending(
          identity.key,
          { ...pending, issued: true, issuedTokenId: retried.id },
          PENDING_TTL_SECONDS
        )
      ))) {
        // The token exists; the idempotency mark did not stick. Say so, so an
        // operator can see why a retry minted a second token rather than
        // discovering it as a mystery.
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "token_pending_mark_failed",
            payment_key_last16: identity.key.slice(-16),
            id_prefix: retried.id.slice(0, 8),
          })
        );
      }
      if (!pending.settlement) {
        // The store accepted the pre-settlement record but not the settlement
        // update. The token is still owed; the header cannot be reconstructed.
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "payment_response_unavailable",
            payment_key_last16: identity.key.slice(-16),
          })
        );
      }

      return {
        response: respondWithToken(retried, pending.settlement, identity.rail),
        attempt: { ...attemptBase, outcome: "settled", rail: identity.rail, status: 200 },
      };
    }
  }

  // ── 2. Verify and settle ──────────────────────────────────────────────────
  //
  // The pending record is written *before* settlement (via the hook) so the
  // payment is recoverable if the store dies immediately after /settle — the gap
  // a post-settle-only record leaves open.
  const result = await verifyPayment({
    loaded,
    request: context,
    paymentSignature,
    sawLegacyHeader: !!sawLegacy,
    ...(identity && sigHash
      ? {
          onVerifiedPayment: async (payment) =>
            writeWithRetry(() =>
              loaded.tokenStore.putPending(
                identity.key,
                {
                  signatureHash: sigHash,
                  pathScope,
                  resourcePath: payPath,
                  createdAt: Date.now(),
                  issued: false,
                  rail: payment.rail,
                  ...(payment.payer ? { payer: payment.payer } : {}),
                },
                PENDING_TTL_SECONDS
              )
            ),
        }
      : {}),
  });
  const attempt = {
    ...attemptBase,
    outcome: outcomeFor(result),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.rail ? { rail: result.rail } : {}),
  };

  if (result.status === "error") {
    return {
      response: jsonError(503, result.reason ?? "payment_unavailable", true),
      attempt: { ...attempt, status: 503 },
    };
  }

  if (result.status !== "approved") {
    const response = await offerResponse(loaded, context, {
      error: result.reason ?? "payment_required",
    });
    return { response, attempt: { ...attempt, status: response.status } };
  }

  // ── 3. Issue, and record what a retry would need ──────────────────────────
  pendingSettlement = result.settlement
    ? {
        transaction: result.settlement.transaction,
        network: result.settlement.network,
        ...(result.settlement.payer ? { payer: result.settlement.payer } : {}),
      }
    : undefined;

  // Persist the settlement before issuing, so a retry can replay the exact
  // PAYMENT-RESPONSE (the transaction is only known now, after /settle).
  if (identity && sigHash && pendingSettlement) {
    await writeWithRetry(() =>
      loaded.tokenStore.putPending(
        identity.key,
        {
          signatureHash: sigHash,
          pathScope,
          resourcePath: payPath,
          createdAt: Date.now(),
          issued: false,
          settlement: pendingSettlement!,
          ...(result.rail ? { rail: result.rail } : {}),
        },
        PENDING_TTL_SECONDS
      )
    );
  }

  const issued = await issueWithRetry(issue);
  if (!issued) {
    // The payment is settled and recorded; a retry with the same signature will
    // issue the token once the store recovers.
    return {
      response: pendingResponse503(),
      attempt: { ...attempt, status: 503 },
    };
  }

  if (identity && sigHash) {
    const pendingRecord: PendingToken = {
      signatureHash: sigHash,
      pathScope,
      resourcePath: payPath,
      createdAt: Date.now(),
      issued: true,
      issuedTokenId: issued.id,
      ...(pendingSettlement ? { settlement: pendingSettlement } : {}),
      ...(result.rail ? { rail: result.rail } : {}),
    };
    if (
      !(await writeWithRetry(() =>
        loaded.tokenStore.putPending(identity.key, pendingRecord, PENDING_TTL_SECONDS)
      ))
    ) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "token_pending_mark_failed",
          payment_key_last16: identity.key.slice(-16),
          id_prefix: issued.id.slice(0, 8),
        })
      );
    }
  }

  return {
    response: respondWithToken(issued, pendingSettlement, result.rail),
    attempt: { ...attempt, status: 200 },
  };
}

interface AttemptRecordInput {
  path: string;
  headers: { paymentSignature?: string | null; xPayment?: string | null };
  outcome: AttemptOutcome;
  reason?: string;
  rail?: string;
  status: number;
  startedAtMs: number;
  client?: string;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: Request,
  loaded: LoadedConfig,
  options: HandleOptions = {}
): Promise<Response> {
  const start = Date.now();
  const url = new URL(req.url);
  const urlPath = url.pathname;
  const method = req.method;
  const clientKey = clientKeyFor(req, loaded, options);

  // The 402 body carries the absolute URL of the priced resource, query string
  // included, so a consumer can reconstruct it out of band.
  const resourceUri = absoluteUrl(loaded, url.pathname, url.search);

  // ── 0. Health check ────────────────────────────────────────────────────────
  if (urlPath === "/health") {
    const res = await healthResponse(loaded);
    logRequest(method, urlPath, res.status, Date.now() - start);
    return res;
  }

  // ── 1. Discovery ──────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const discovery = serveDiscovery(urlPath, loaded);
    if (discovery) {
      logRequest(method, urlPath, discovery.status, Date.now() - start);
      return toResponse(discovery);
    }
  }

  // ── 2. Feed ───────────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const feed = serveFeed(urlPath, loaded);
    if (feed) {
      logRequest(method, urlPath, feed.status, Date.now() - start);
      return toResponse(feed);
    }
  }

  // ── 3. Token issuance: POST <auth.endpoint>, /mdf/auth, /mdf/pay ──────────
  //
  // Every alias requires a valid payment **in the same request**. There is no
  // other way to mint a token: 0.2.8 and earlier issued one for any
  // body-supplied path without checking for a payment (fixed in 0.2.9), and
  // 0.3.0 keeps that gate while moving the store to Valkey.
  const authEndpoint = loaded.config.auth?.endpoint;
  const isTokenEndpoint =
    urlPath === "/mdf/auth" ||
    (!!authEndpoint && authEndpoint.startsWith("/") && urlPath === authEndpoint) ||
    urlPath === "/mdf/pay";

  if (isTokenEndpoint) {
    try {
      const { response, attempt } = await handleTokenEndpoint(req, loaded, urlPath, clientKey);
      if (attempt) logAttempt(attempt);
      logRequest(method, urlPath, response.status, Date.now() - start, {
        ...(attempt?.reason ? { reason: attempt.reason } : {}),
      });
      return response;
    } catch (err) {
      console.error(`[mdf:pay] unexpected error: ${(err as Error).message}`);
      logRequest(method, urlPath, 500, Date.now() - start);
      return jsonError(500, "Internal error", true);
    }
  }

  // ── Content methods only beyond this point ────────────────────────────────
  if (method !== "GET" && method !== "HEAD") {
    logRequest(method, urlPath, 405, Date.now() - start);
    return jsonError(405, "Method Not Allowed");
  }

  const acceptHeader = req.headers.get("accept");
  const ifNoneMatch = req.headers.get("if-none-match");
  const paymentSignature = req.headers.get(HEADER.signature.toLowerCase());
  const sawLegacy = req.headers.get("x-payment");
  const authHeader = req.headers.get("authorization") ?? "";

  // ── 4. Content existence ──────────────────────────────────────────────────
  //
  // 404 is a property of the resource hierarchy, not of the payment rail. If no
  // content file resolves for this path, return 404 here — before any pricing
  // lookup or payment verification — so an unknown path under a non-zero-priced
  // section cannot be advertised as a payable resource.
  if (!resolveContentPath(urlPath, loaded.contentDir)) {
    const notFound = serveNotFound(urlPath, acceptHeader);
    logRequest(method, urlPath, notFound.status, Date.now() - start);
    return toResponse(notFound);
  }

  const entry = entryFor(loaded, urlPath);
  const context = requestContext(
    loaded,
    urlPath,
    resourceUri,
    method,
    { accept: acceptHeader },
    clientKey
  );

  // ── 5. Free content ───────────────────────────────────────────────────────
  if (entry.free && !entry.tokenAccess) {
    const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
    logRequest(method, urlPath, content.status, Date.now() - start, {
      contentType: content.headers["Content-Type"]?.split(";")[0],
    });
    return toResponse(content);
  }

  // ── 6. Token-gated content ────────────────────────────────────────────────
  if (entry.tokenAccess) {
    const validated = await validateToken(loaded.tokenStore, authHeader, urlPath);
    if (!validated.ok) {
      const response = await offerResponse(loaded, context, {
        error: "payment_required",
        mimeType: mimeTypeFor(acceptHeader),
      });
      // A token failure is not a payment attempt; it is worth one line, without
      // the token or the reason an attacker could use as an oracle.
      logAttempt({
        path: urlPath,
        headers: { paymentSignature, xPayment: sawLegacy },
        outcome: validated.reason === "unknown" ? "verify_fail" : "no_payment",
        reason: "payment_required",
        status: response.status,
        startedAtMs: start,
        client: clientKey,
      });
      logRequest(method, urlPath, response.status, Date.now() - start, {
        reason: validated.reason,
      });
      return response;
    }

    const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
    logRequest(method, urlPath, content.status, Date.now() - start, {
      contentType: content.headers["Content-Type"]?.split(";")[0],
    });
    return toResponse(content);
  }

  // ── 7. Per-fetch payment ──────────────────────────────────────────────────
  const result = await verifyPayment({
    loaded,
    request: context,
    paymentSignature,
    sawLegacyHeader: !!sawLegacy,
  });

  // Upstream dependency failure (facilitator, RPC, replay store). Not a payment
  // denial — surface it as 503 so the client does not treat it as a hard 402.
  if (result.status === "error") {
    logAttempt({
      path: urlPath,
      headers: { paymentSignature, xPayment: sawLegacy },
      outcome: "error",
      reason: result.reason ?? "payment_unavailable",
      status: 503,
      startedAtMs: start,
      client: clientKey,
    });
    logRequest(method, urlPath, 503, Date.now() - start, { reason: result.reason });
    return jsonError(503, result.reason ?? "payment_unavailable", true);
  }

  if (result.status !== "approved") {
    const response = await offerResponse(loaded, context, {
      error: result.reason ?? "payment_required",
      mimeType: mimeTypeFor(acceptHeader),
    });
    logAttempt({
      path: urlPath,
      headers: { paymentSignature, xPayment: sawLegacy },
      outcome: outcomeFor(result),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.rail ? { rail: result.rail } : {}),
      status: response.status,
      startedAtMs: start,
      client: clientKey,
    });
    logRequest(method, urlPath, response.status, Date.now() - start, {
      reason: result.reason,
    });
    return toResponse(response);
  }

  // ── 8. Content serving ────────────────────────────────────────────────────
  const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
  logAttempt({
    path: urlPath,
    headers: { paymentSignature, xPayment: sawLegacy },
    outcome: "settled",
    ...(result.rail ? { rail: result.rail } : {}),
    status: content.status,
    startedAtMs: start,
    client: clientKey,
  });
  logRequest(method, urlPath, content.status, Date.now() - start, {
    contentType: content.headers["Content-Type"]?.split(";")[0],
    ...(result.rail ? { rail: result.rail } : {}),
  });

  const res = toResponse(content);
  const paymentResponse = settlementHeader(result);
  if (paymentResponse) res.headers.set(HEADER.response, paymentResponse);
  return res;
}
