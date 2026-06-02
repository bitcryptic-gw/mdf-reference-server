/**
 * mdf-server — Markdown First reference implementation
 * Entry point: starts the Bun HTTP server and wires all handlers.
 *
 * Request routing order:
 *   1. Discovery  — /mdf.json, /llms.txt
 *   2. Feed       — /feed.xml
 *   3. Auth       — POST /mdf/auth (token issuance)
 *   4. Payment    — L402 (Lightning) or x402 (EVM) verification
 *   5. Content    — serve markdown or HTML
 */

import { loadConfig } from "./config/loader.ts";
import { serveDiscovery } from "./discovery/discovery.ts";
import { serveFeed } from "./feed/handler.ts";
import { ensureDataDir } from "./feed/events.ts";
import { initWatcher, startWatcher } from "./feed/watcher.ts";
import { emitEvent } from "./feed/events.ts";
import { serveContent } from "./content/handler.ts";
import { verifyPayment, verifyL402, build402Response } from "./payment/payment.ts";
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

// ---------------------------------------------------------------------------
// Feed setup — data dir, initial manifest, startup event
// ---------------------------------------------------------------------------

ensureDataDir();
initWatcher(loaded);
startWatcher(loaded);

// Emit startup capability event — records that the server started and
// what MDF version/capabilities it advertises. One event per start.
emitEvent(
  "mdf_capability",
  "/mdf.json",
  `mdf-server started — MDF v1.0`,
  `site: ${loaded.config.site.url}`
);

// ---------------------------------------------------------------------------
// Token store sweep
// ---------------------------------------------------------------------------

tokenStore.startSweep();

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

  // ── 2. Feed ───────────────────────────────────────────────────────────────
  if (method === "GET" || method === "HEAD") {
    const feed = serveFeed(urlPath, loaded);
    if (feed) {
      logRequest(method, urlPath, feed.status, Date.now() - start);
      const res = toResponse(feed);
      return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
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

  // ── Content methods only beyond this point ────────────────────────────────
  if (method !== "GET" && method !== "HEAD") {
    logRequest(method, urlPath, 405, Date.now() - start);
    return jsonError(405, "Method Not Allowed");
  }

  const acceptHeader = req.headers.get("accept");
  const ifNoneMatch = req.headers.get("if-none-match");
  const paymentHeader = req.headers.get("x-payment");
  const authHeader = req.headers.get("authorization") ?? "";

  // ── 4. Payment verification ───────────────────────────────────────────────
  if (authHeader.toLowerCase().startsWith("l402 ")) {
    // L402: agent submitting a Lightning preimage proof
    const l402Result = await verifyL402(urlPath, authHeader, loaded);
    if (l402Result.status !== "approved" && l402Result.status !== "stub_approved") {
      const response402 = await build402Response(urlPath, l402Result, loaded);
      logRequest(method, urlPath, 402, Date.now() - start, { reason: l402Result.reason });
      return toResponse(response402);
    }
  } else {
    // x402: agent submitting EVM payment proof, or no proof at all
    const paymentResult = verifyPayment(urlPath, paymentHeader, loaded);

    if (paymentResult.requiresToken) {
      const tokenResult = validateToken(authHeader, urlPath);
      if (!tokenResult.ok) {
        const response402 = await build402Response(urlPath, paymentResult, loaded);
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
      const response402 = await build402Response(urlPath, paymentResult, loaded);
      logRequest(method, urlPath, 402, Date.now() - start, {
        reason: paymentResult.reason,
      });
      return toResponse(response402);
    }
  }

  // ── 5. Content serving ────────────────────────────────────────────────────
  const content = serveContent(urlPath, acceptHeader, ifNoneMatch, loaded);
  logRequest(method, urlPath, content.status, Date.now() - start, {
    contentType: content.headers["Content-Type"]?.split(";")[0],
    tokens: content.headers["X-MDF-Tokens"],
  });

  const res = toResponse(content);
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

// ---------------------------------------------------------------------------
// Dashboard server
// ---------------------------------------------------------------------------

function buildDashboardHtml(): string {
  const store = (tokenStore as any).store as Map<string, any>;
  const activeTokens = [...store.values()].filter(
    (r) => r.expiresAt > Date.now()
  ).length;

  const cfg = loaded.config;
  const chains: string[] = cfg.payment?.accepted_chains ?? [];
  const currencies: string[] = cfg.payment?.accepted_currencies ?? [];
  const signals = cfg.signals ?? {};
  const sections = cfg.pricing?.sections ?? {};

  // Build pricing tiers rows — sorted by amount ascending
  type SectionEntry = { path: string; amount: string; currency: string | null; chain: string | null };
  const tiers: SectionEntry[] = Object.entries(sections).map(([path, p]: [string, any]) => ({
    path,
    amount: p.amount,
    currency: p.currency ?? null,
    chain: p.chain ?? null,
  }));
  tiers.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));

  function tierLabel(t: SectionEntry): string {
    if (!t.currency) return "Free";
    const amt = parseFloat(t.amount);
    if (t.chain === "lightning") {
      // Convert BTC to sats for readability
      const sats = Math.round(amt * 1e8);
      return sats === 1 ? "1 sat" : `${sats} sats`;
    }
    return `${parseFloat(t.amount).toFixed(amt >= 1 ? 2 : 4)} ${t.currency}`;
  }

  function railBadge(chain: string | null): string {
    if (!chain) return `<span class="badge badge-free">open</span>`;
    if (chain === "lightning") return `<span class="badge badge-lightning">⚡ Lightning</span>`;
    return `<span class="badge badge-evm">${chain}</span>`;
  }

  const tierRows = tiers.map(t => `
    <tr>
      <td class="td-path"><code>${t.path}</code></td>
      <td class="td-price">${tierLabel(t)}</td>
      <td class="td-rail">${railBadge(t.chain)}</td>
    </tr>`).join("");

  const defaultPrice = cfg.pricing?.default;
  const defaultLabel = defaultPrice?.currency
    ? `${parseFloat(defaultPrice.amount).toFixed(4)} ${defaultPrice.currency}`
    : "free";

  // Signal dots
  function sig(val: boolean | undefined, name: string): string {
    const on = val === true;
    return `<span class="sig ${on ? "sig-on" : "sig-off"}">${name}</span>`;
  }

  // Chain / currency tags
  const chainTags = chains.map(c =>
    c === "lightning"
      ? `<span class="tag tag-lightning">⚡ ${c}</span>`
      : `<span class="tag tag-evm">${c}</span>`
  ).join("");

  const currencyTags = currencies.map(c =>
    `<span class="tag tag-currency">${c}</span>`
  ).join("");

  // Lightning node status — present if lightning: block configured
  const lightningCfg = (cfg as any).lightning;
  const lightningRow = lightningCfg
    ? `<tr>
        <td class="meta-label">Lightning node</td>
        <td><span class="dot dot-green"></span> Alby Hub &nbsp;<code class="subtle">${lightningCfg.api_url}</code></td>
      </tr>
      <tr>
        <td class="meta-label">Invoice expiry</td>
        <td>${lightningCfg.invoice_expiry_seconds}s</td>
      </tr>`
    : `<tr><td class="meta-label">Lightning node</td><td><span class="dot dot-off"></span> not configured</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdf-server</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace;
    font-size: 13px;
    line-height: 1.6;
    background: #0d1117;
    color: #c9d1d9;
    max-width: 860px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }

  /* Header */
  .header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid #21262d; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .header h1 { font-size: 1.25rem; font-weight: 600; color: #58a6ff; letter-spacing: -.01em; }
  .header .site { color: #8b949e; font-size: .8rem; }
  .header .version { margin-left: auto; color: #3fb950; font-size: .75rem; }

  /* Stat cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 2rem; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: .9rem 1rem; }
  .card .label { font-size: .7rem; color: #8b949e; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .3rem; }
  .card .value { font-size: 1.5rem; font-weight: 600; color: #58a6ff; }
  .card .sub { font-size: .75rem; color: #8b949e; margin-top: .15rem; word-break: break-all; }

  /* Section heading */
  .section-title { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin: 1.75rem 0 .6rem; border-bottom: 1px solid #21262d; padding-bottom: .4rem; }

  /* Pricing table */
  table.tiers { width: 100%; border-collapse: collapse; }
  table.tiers th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; padding: .3rem .5rem; }
  table.tiers td { padding: .4rem .5rem; border-top: 1px solid #21262d; vertical-align: middle; }
  .td-path code { color: #c9d1d9; font-size: .8rem; }
  .td-price { color: #e6edf3; min-width: 100px; }
  .td-rail { text-align: right; }

  /* Meta table */
  table.meta { width: 100%; border-collapse: collapse; }
  table.meta td { padding: .35rem .5rem; border-top: 1px solid #21262d; vertical-align: middle; }
  .meta-label { color: #8b949e; width: 140px; white-space: nowrap; }
  code { font-family: inherit; }
  code.subtle { color: #6e7681; font-size: .78rem; }

  /* Badges */
  .badge { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; font-weight: 600; letter-spacing: .02em; }
  .badge-lightning { background: #f7931a22; color: #f7931a; border: 1px solid #f7931a44; }
  .badge-evm { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb55; }
  .badge-free { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95044; }

  /* Tags (chains/currencies) */
  .tags { display: flex; flex-wrap: wrap; gap: .3rem; }
  .tag { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; }
  .tag-lightning { background: #f7931a22; color: #f7931a; border: 1px solid #f7931a44; }
  .tag-evm { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb55; }
  .tag-currency { background: #8957e522; color: #d2a8ff; border: 1px solid #8957e544; }

  /* Signals */
  .signals { display: flex; flex-wrap: wrap; gap: .4rem; }
  .sig { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; }
  .sig-on  { background: #3fb95018; color: #3fb950; border: 1px solid #3fb95033; }
  .sig-off { background: #21262d; color: #6e7681; border: 1px solid #30363d; }

  /* Status dots */
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .dot-green { background: #3fb950; box-shadow: 0 0 4px #3fb95088; }
  .dot-off   { background: #6e7681; }

  /* Footer */
  .footer { margin-top: 3rem; color: #21262d; font-size: .7rem; }
</style>
</head>
<body>

<div class="header">
  <h1>mdf-server</h1>
  <span class="site">${cfg.site?.url ?? "—"}</span>
  <span class="version">MDF v${cfg.mdf_version ?? "1.0"}</span>
</div>

<div class="cards">
  <div class="card">
    <div class="label">Active tokens</div>
    <div class="value">${activeTokens}</div>
  </div>
  <div class="card">
    <div class="label">Default price</div>
    <div class="value" style="font-size:1.1rem">${defaultLabel}</div>
  </div>
  <div class="card">
    <div class="label">Content dir</div>
    <div class="sub" style="font-size:.8rem;margin-top:.4rem">${loaded.contentDir}</div>
  </div>
  <div class="card">
    <div class="label">Price tiers</div>
    <div class="value">${tiers.length}</div>
  </div>
</div>

<div class="section-title">Pricing tiers</div>
<table class="tiers">
  <thead>
    <tr>
      <th>Path</th>
      <th>Price</th>
      <th style="text-align:right">Rail</th>
    </tr>
  </thead>
  <tbody>${tierRows}</tbody>
</table>

<div class="section-title">Payment</div>
<table class="meta">
  <tr>
    <td class="meta-label">Accepted chains</td>
    <td><div class="tags">${chainTags || "—"}</div></td>
  </tr>
  <tr>
    <td class="meta-label">Currencies</td>
    <td><div class="tags">${currencyTags || "—"}</div></td>
  </tr>
  <tr>
    <td class="meta-label">Payment endpoint</td>
    <td><code class="subtle">${cfg.payment?.endpoint ?? "—"}</code></td>
  </tr>
  ${lightningRow}
</table>

<div class="section-title">Auth</div>
<table class="meta">
  <tr>
    <td class="meta-label">Threshold</td>
    <td>${cfg.auth?.price_threshold ?? "—"}</td>
  </tr>
  <tr>
    <td class="meta-label">Token TTL</td>
    <td>${cfg.auth?.token_ttl_seconds ?? "—"}s</td>
  </tr>
  <tr>
    <td class="meta-label">Auth endpoint</td>
    <td><code class="subtle">${cfg.auth?.endpoint ?? "—"}</code></td>
  </tr>
</table>

<div class="section-title">Content signals</div>
<table class="meta">
  <tr>
    <td class="meta-label">Signals</td>
    <td>
      <div class="signals">
        ${sig(signals.ai_train, "ai_train")}
        ${sig(signals.ai_input, "ai_input")}
        ${sig(signals.search, "search")}
        ${sig(signals.human_only, "human_only")}
      </div>
    </td>
  </tr>
</table>

<div class="section-title">Feed</div>
<table class="meta">
  <tr>
    <td class="meta-label">Feed URL</td>
    <td><code class="subtle">${cfg.feed?.url ?? "—"}</code></td>
  </tr>
  <tr>
    <td class="meta-label">WebSub hub</td>
    <td><code class="subtle">${cfg.feed?.websub_hub ?? "—"}</code></td>
  </tr>
</table>

<p class="footer">Refresh for current state — no auto-refresh.</p>

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
