/**
 * mdf-server — HTTP request router
 *
 * Owns the single request-routing order for the content server. Extracted from
 * index.ts so the ordering (and its regressions) can be exercised in-process
 * by the test suite without starting a listening server.
 *
 * Request routing order:
 *   1. Discovery  — /mdf.json, /llms.txt
 *   2. Feed       — /feed.xml
 *   3. Auth       — POST /mdf/auth (token issuance)
 *   4. Pay        — POST /mdf/pay (x402 settlement → bearer token)
 *   5. Existence  — 404 for paths with no content, before any pricing
 *   6. Payment    — L402 (Lightning) or x402 (EVM) verification
 *   7. Content    — serve markdown or HTML
 */

import { accessSync, constants } from "fs";
import { serveDiscovery } from "./discovery/discovery.ts";
import { serveFeed } from "./feed/handler.ts";
import { serveContent, serveNotFound, resolveContentPath } from "./content/handler.ts";
import { verifyPayment, verifyL402, build402Response } from "./payment/payment.ts";
import { validateToken, handleAuthRequest, issueToken } from "./auth/auth.ts";
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
  // Payment paths pass noStore so a failed payment attempt (malformed or
  // rejected X-PAYMENT, facilitator error surfaced to the client) can never be
  // stored by a shared cache — same guard the 402 builder applies.
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
 * External payment deps (Alby Hub for L402, the x402 facilitator) are
 * deliberately NOT checked: they are only touched on the payment paths, and
 * their outage should not take a healthy content-serving instance out of the
 * Caddy pool.
 *
 * Cheap by design — access checks only, no writes, no network I/O — since
 * Caddy polls this frequently.
 *
 * The body is JSON carrying the server's *release* version (`version`) so a
 * deploy can be confirmed by asking the running process directly, rather than
 * inferring it from behaviour. `status` preserves the old healthy/unhealthy
 * signal; the HTTP status code remains the authoritative probe. Note this is
 * the release version, not the MDF protocol version (`mdf_version` /
 * `X-MDF-Version`).
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

function healthResponse(loaded: LoadedConfig): Response {
  const ok = isHealthy(loaded);
  const body = JSON.stringify({
    status: ok ? "ok" : "unavailable",
    version: SERVER_VERSION,
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
// Main request handler
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: Request,
  loaded: LoadedConfig
): Promise<Response> {
  const start = Date.now();
  const url = new URL(req.url);
  const urlPath = url.pathname;
  const method = req.method;

  // Absolute URL of the resource being requested, query string included.
  // The 402 body carries this so a consumer can reconstruct the priced
  // resource out of band (queued, retried, logged, passed between processes).
  const resourceUri = `${loaded.config.site.url.replace(/\/$/, "")}${url.pathname}${url.search}`;

  // ── 0. Health check ────────────────────────────────────────────────────────
  if (urlPath === "/health") {
    const res = healthResponse(loaded);
    logRequest(method, urlPath, res.status, Date.now() - start);
    return res;
  }

  // ── 1. Discovery ──────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const discovery = serveDiscovery(urlPath, loaded);
    if (discovery) {
      logRequest(method, urlPath, discovery.status, Date.now() - start);
      const res = toResponse(discovery);
      return res;
    }
  }

  // ── 2. Feed ───────────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const feed = serveFeed(urlPath, loaded);
    if (feed) {
      logRequest(method, urlPath, feed.status, Date.now() - start);
      const res = toResponse(feed);
      return res;
    }
  }

  // ── 3. Auth endpoint ──────────────────────────────────────────────────────
  if (urlPath === "/mdf/auth" || urlPath === loaded.config.auth?.endpoint) {
    if (method !== "POST") {
      logRequest(method, urlPath, 405, Date.now() - start);
      return jsonError(405, "Method Not Allowed — use POST");
    }

    const body = await readBody(req);
    if (body === null) {
      logRequest(method, urlPath, 413, Date.now() - start);
      return jsonError(413, "Request body too large");
    }

    const result = handleAuthRequest(body, loaded);
    logRequest(method, urlPath, result.status, Date.now() - start);
    return toResponse(result);
  }

  // ── 3.5 Pay endpoint ──────────────────────────────────────────────────────
  //
  // High-tier token issuance. The client sends a standard x402 PaymentPayload
  // in the X-PAYMENT header. The JSON body identifies the resource being paid
  // for, since the payment endpoint is a single fixed URL.
  //
  //   POST /mdf/pay
  //   X-PAYMENT: <base64 x402 PaymentPayload>
  //   { "resource": "/private/internals" }   (absolute URL also accepted)
  const payEndpoint = loaded.config.payment?.endpoint;
  const isPayEndpoint =
    urlPath === "/mdf/pay" ||
    (!!payEndpoint && payEndpoint.startsWith("/") && urlPath === payEndpoint);

  if (method === "POST" && isPayEndpoint) {
    try {
      const body = await readBody(req);
      if (body === null) {
        logRequest(method, urlPath, 413, Date.now() - start);
        return jsonError(413, "Request body too large", true);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        logRequest(method, urlPath, 400, Date.now() - start);
        return jsonError(400, "Invalid JSON body", true);
      }

      const resource = typeof parsed.resource === "string" ? parsed.resource : null;
      if (!resource) {
        logRequest(method, urlPath, 400, Date.now() - start);
        return jsonError(400, "Missing or invalid field: resource", true);
      }

      let payPath: string;
      try {
        payPath = new URL(resource).pathname;
      } catch {
        payPath = resource.startsWith("/") ? resource : `/${resource}`;
      }

      const xPayment = req.headers.get("x-payment");
      if (!xPayment) {
        logRequest(method, urlPath, 400, Date.now() - start);
        return jsonError(400, "Missing X-PAYMENT header", true);
      }

      const result = await verifyPayment(payPath, xPayment, loaded);

      if (result.status === "error") {
        logRequest(method, urlPath, 503, Date.now() - start, { reason: result.reason });
        return jsonError(503, result.reason, true);
      }

      if (result.status !== "approved" && result.status !== "stub_approved") {
        const response402 = await build402Response(payPath, result, loaded);
        logRequest(method, urlPath, 402, Date.now() - start, { reason: result.reason });
        return toResponse(response402);
      }

      const tokenResult = issueToken(
        payPath,
        result.settlement?.payer ?? result.proof?.from ?? "unknown",
        result.settlement?.transaction ?? "unknown",
        loaded
      );

      if (!tokenResult.ok) {
        logRequest(method, urlPath, 500, Date.now() - start, { reason: tokenResult.reason });
        return jsonError(500, "Token issuance failed", true);
      }

      logRequest(method, urlPath, 200, Date.now() - start);
      return new Response(JSON.stringify({
        token: tokenResult.token,
        expires_at: new Date(tokenResult.expiresAt).toISOString(),
        ttl_seconds: tokenResult.ttlSeconds,
        ...(result.settlement ? { payment: result.settlement } : {}),
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // The body carries a bearer credential — never cacheable anywhere.
          "Cache-Control": "no-store",
        },
      });
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
  const paymentHeader = req.headers.get("x-payment");
  const authHeader = req.headers.get("authorization") ?? "";

  // ── 4. Content existence ──────────────────────────────────────────────────
  //
  // 404 is a property of the resource hierarchy, not of the payment rail. If no
  // content file resolves for this path, return 404 here — before any pricing
  // lookup or payment verification — so an unknown path under a non-zero-priced
  // section cannot be advertised as a payable resource. This is the single
  // shared place the check lives; serveContent shares the same resolver, so the
  // two paths cannot drift.
  if (!resolveContentPath(urlPath, loaded.contentDir)) {
    const notFound = serveNotFound(urlPath, acceptHeader);
    logRequest(method, urlPath, notFound.status, Date.now() - start);
    return toResponse(notFound);
  }

  // Settlement metadata from an x402 payment, echoed back as a
  // Payment-Response header so the caller can verify on-chain independently.
  let x402Settlement: { payer: string; transaction: string } | undefined;

  // ── 5. Payment verification ───────────────────────────────────────────────
  if (authHeader.toLowerCase().startsWith("l402 ")) {
    // L402: agent submitting a Lightning preimage proof
    const l402Result = await verifyL402(urlPath, authHeader, loaded);
    if (l402Result.status !== "approved" && l402Result.status !== "stub_approved") {
      const response402 = await build402Response(urlPath, l402Result, loaded, resourceUri);
      logRequest(method, urlPath, 402, Date.now() - start, { reason: l402Result.reason });
      return toResponse(response402);
    }
  } else {
    // x402: agent submitting EVM payment proof, or no proof at all
    const paymentResult = await verifyPayment(urlPath, paymentHeader, loaded);

    // Upstream dependency failure (facilitator/RPC). Not a payment denial —
    // surface it as 503 so the client does not treat it as a hard 402.
    if (paymentResult.status === "error") {
      logRequest(method, urlPath, 503, Date.now() - start, { reason: paymentResult.reason });
      return jsonError(503, paymentResult.reason, true);
    }

    if (paymentResult.settlement) x402Settlement = paymentResult.settlement;

    if (paymentResult.requiresToken) {
      const tokenResult = validateToken(authHeader, urlPath);
      if (!tokenResult.ok) {
        const response402 = await build402Response(urlPath, paymentResult, loaded, resourceUri);
        logRequest(method, urlPath, 402, Date.now() - start, {
          reason: tokenResult.reason,
          requiresToken: true,
        });
        return toResponse(response402);
      }
    } else if (
      paymentResult.status === "no_proof" ||
      paymentResult.status === "rejected"
    ) {
      const response402 = await build402Response(urlPath, paymentResult, loaded, resourceUri);
      logRequest(method, urlPath, 402, Date.now() - start, {
        reason: paymentResult.reason,
      });
      return toResponse(response402);
    }
  }

  // ── 6. Content serving ────────────────────────────────────────────────────
  const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
  logRequest(method, urlPath, content.status, Date.now() - start, {
    contentType: content.headers["Content-Type"]?.split(";")[0],
  });

  const res = toResponse(content);
  if (x402Settlement) {
    res.headers.set(
      "Payment-Response",
      Buffer.from(JSON.stringify({ success: true, ...x402Settlement })).toString("base64")
    );
  }
  return res;
}
