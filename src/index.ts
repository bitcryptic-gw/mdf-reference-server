/**
 * mdf-server — Markdown First reference implementation
 * Entry point: starts the Bun HTTP server and wires all handlers.
 *
 * Request routing order:
 *   1. Discovery  — /mdf.json, /llms.txt
 *   2. Auth       — POST /mdf/auth (token issuance)
 *   3. Token check — if path requires token, validate Authorization header
 *   4. Payment    — if path is paid and no token, verify X-Payment header
 *   5. Content    — serve markdown or HTML
 */

import { loadConfig } from "./config/loader.ts";
import { serveDiscovery } from "./discovery/discovery.ts";
import { serveContent } from "./content/handler.ts";
import { verifyPayment, build402Response } from "./payment/payment.ts";
import {
  validateToken,
  handleAuthRequest,
  tokenStore,
} from "./auth/auth.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.MDF_CONFIG ?? "./mdf.yaml";
const PORT = parseInt(process.env.MDF_PORT ?? "3000", 10);
const DASHBOARD_PORT_OVERRIDE = process.env.MDF_DASHBOARD_PORT
  ? parseInt(process.env.MDF_DASHBOARD_PORT, 10)
  : null;

let loaded: Awaited<ReturnType<typeof loadConfig>>;

try {
  loaded = loadConfig(CONFIG_PATH);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const dashboardPort =
  DASHBOARD_PORT_OVERRIDE ?? loaded.config.dashboard.port;

// Start token expiry sweep
tokenStore.startSweep();

// ---------------------------------------------------------------------------
// Request size limit
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024; // 64 KB — generous for a payment proof JSON body

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

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const start = Date.now();
  const url = new URL(req.url);
  const urlPath = url.pathname;
  const method = req.method;

  // ── 1. Discovery ──────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const discovery = serveDiscovery(urlPath, loaded);
    if (discovery) {
      logRequest(method, urlPath, discovery.status, Date.now() - start);
      const res = toResponse(discovery);
      return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }
  }

  // ── 2. Auth endpoint ──────────────────────────────────────────────────────
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

  // ── Content methods only beyond this point ────────────────────────────────
  if (method !== "GET" && method !== "HEAD") {
    logRequest(method, urlPath, 405, Date.now() - start);
    return jsonError(405, "Method Not Allowed");
  }

  const acceptHeader = req.headers.get("accept");
  const authHeader = req.headers.get("authorization");
  const ifNoneMatch = req.headers.get("if-none-match");
  const paymentHeader = req.headers.get("x-payment");

  // ── 3. Payment verification ───────────────────────────────────────────────
  const paymentResult = verifyPayment(urlPath, paymentHeader, loaded);

  if (paymentResult.requiresToken) {
    // High-price tier — must have a valid bearer token
    const tokenResult = validateToken(authHeader, urlPath);
    if (!tokenResult.ok) {
      // No valid token — return 402 with auth endpoint details
      const response402 = build402Response(urlPath, paymentResult, loaded);
      logRequest(method, urlPath, 402, Date.now() - start, {
        reason: tokenResult.reason,
        requiresToken: true,
      });
      return toResponse(response402);
    }
    // Token valid — fall through to content serving
  } else if (
    paymentResult.status === "no_proof" ||
    paymentResult.status === "rejected"
  ) {
    // Paid content without valid proof
    const response402 = build402Response(urlPath, paymentResult, loaded);
    logRequest(method, urlPath, 402, Date.now() - start, {
      reason: paymentResult.reason,
    });
    return toResponse(response402);
  }
  // status === "approved" | "stub_approved" — fall through

  // ── 4. Content serving ────────────────────────────────────────────────────
  const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
  logRequest(method, urlPath, content.status, Date.now() - start, {
    contentType: content.headers["Content-Type"]?.split(";")[0],
    tokens: content.headers["X-MDF-Tokens"],
  });

  const res = toResponse(content);
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

// ---------------------------------------------------------------------------
// Dashboard server (internal port, not public-facing)
// ---------------------------------------------------------------------------

function buildDashboardHtml(): string {
  const store = (tokenStore as any).store as Map<string, any>;
  const activeTokens = [...store.values()].filter(
    (r) => r.expiresAt > Date.now()
  ).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdf-server dashboard</title>
<style>
  body { font-family: ui-monospace, monospace; max-width: 800px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: .5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; }
  .card .label { font-size: .75rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
  .card .value { font-size: 1.75rem; color: #58a6ff; margin-top: .25rem; }
  .meta { color: #8b949e; font-size: .85rem; line-height: 1.8; }
  .tag { display: inline-block; background: #1f6feb33; color: #58a6ff; border-radius: 4px; padding: .1rem .4rem; font-size: .75rem; margin: .1rem; }
</style>
</head>
<body>
<h1>mdf-server</h1>
<div class="grid">
  <div class="card"><div class="label">Active tokens</div><div class="value">${activeTokens}</div></div>
  <div class="card"><div class="label">Content dir</div><div class="value" style="font-size:1rem;word-break:break-all">${loaded.contentDir}</div></div>
  <div class="card"><div class="label">Default price</div><div class="value">${loaded.config.pricing.default.amount} ${loaded.config.pricing.default.currency ?? "free"}</div></div>
</div>
<div class="meta">
  <strong>Site:</strong> ${loaded.config.site.url}<br>
  <strong>MDF version:</strong> 1.0<br>
  <strong>Accepted chains:</strong> ${(loaded.config.payment?.accepted_chains ?? []).map((c) => `<span class="tag">${c}</span>`).join("") || "—"}<br>
  <strong>Accepted currencies:</strong> ${(loaded.config.payment?.accepted_currencies ?? []).map((c) => `<span class="tag">${c}</span>`).join("") || "—"}<br>
  <strong>Auth threshold:</strong> ${loaded.config.auth?.price_threshold ?? "—"}<br>
  <strong>Token TTL:</strong> ${loaded.config.auth?.token_ttl_seconds ?? "—"}s<br>
  <strong>Signals:</strong>
    ai_train=${loaded.config.signals.ai_train}
    ai_input=${loaded.config.signals.ai_input}
    search=${loaded.config.signals.search}
    human_only=${loaded.config.signals.human_only}
</div>
<p style="margin-top:2rem;color:#30363d;font-size:.75rem">Refresh for current state — no auto-refresh.</p>
</body>
</html>`;
}

async function handleDashboardRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(buildDashboardHtml(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const mainServer = Bun.serve({
  port: PORT,
  fetch: handleRequest,
  error(err) {
    console.error(`[mdf-server] unhandled error: ${err.message}`);
    return jsonError(500, "Internal Server Error");
  },
});

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: "startup",
    site: loaded.config.site.url,
    port: PORT,
    dashboardPort,
    contentDir: loaded.contentDir,
    defaultPrice: `${loaded.config.pricing.default.amount} ${loaded.config.pricing.default.currency ?? "free"}`,
  })
);

if (loaded.config.dashboard.enabled) {
  const dashServer = Bun.serve({
    port: dashboardPort,
    fetch: handleDashboardRequest,
    error(err) {
      console.error(`[mdf-dashboard] unhandled error: ${err.message}`);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "dashboard_startup",
      port: dashboardPort,
    })
  );
}
