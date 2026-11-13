/**
 * mdf-server — Markdown First reference implementation
 * Entry point: loads config, runs the startup gates, starts the Bun HTTP server,
 * and wires the feed watcher and dashboard. Request routing lives in router.ts.
 *
 * Two startup gates decide what the demo can sell, and they are deliberately
 * different in kind:
 *
 *   - an NWC credential that answers and permits more than invoice minting is an
 *     operator misconfiguration with a security consequence, so the process
 *     **exits 1** and says which method is over-permitted;
 *   - an unreachable relay is a transient dependency failure, so the process
 *     starts with the lnbtc rail degraded (omitted from `accepts[]`, reported on
 *     `/health`) and re-checks the wallet on the invoice breaker's backoff.
 *
 * USDC payments, free content and `/health` never depend on the relay, so a
 * Lightning outage can never take the site down.
 */

import { loadConfig } from "./config/loader.ts";
import { ensureDataDir } from "./feed/events.ts";
import { initWatcher, startWatcher } from "./feed/watcher.ts";
import { emitEvent } from "./feed/events.ts";
import { handleRequest } from "./router.ts";
import { startLnbtc, checkNwcConnection } from "./payment/lnbtc/availability.ts";
import { LightningBreaker, type LightningFailure } from "./payment/breaker.ts";
import { SERVER_VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.MDF_CONFIG ?? "./mdf.yaml";
const PORT = parseInt(process.env.MDF_PORT ?? "3000", 10);
const DASHBOARD_PORT_OVERRIDE = process.env.MDF_DASHBOARD_PORT
  ? parseInt(process.env.MDF_DASHBOARD_PORT, 10)
  : null;

let loaded: ReturnType<typeof loadConfig>;

try {
  loaded = loadConfig(CONFIG_PATH);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const dashboardPort = DASHBOARD_PORT_OVERRIDE ?? loaded.config.dashboard.port;

// ---------------------------------------------------------------------------
// lnbtc startup gate
// ---------------------------------------------------------------------------

const log = (message: string) => console.warn(message);

if (loaded.lnbtc) {
  const rt = loaded.lnbtc;

  /** The last scope the wallet reported, so a change is logged once. */
  let reportedMethods: string | null = null;

  /**
   * Capture the receiver node pubkey and log the credential's exact scope.
   *
   * The scope is the wallet's answer, not our allowlist: an operator needs to
   * see what Alby Hub actually granted, because that is what governs the risk if
   * the connection leaks.
   */
  function applyCheckResult(check: {
    status: string;
    pubkey?: string;
    methods?: string[];
    unverified?: boolean;
  }): void {
    if (check.status === "pass" && check.pubkey && !rt.payeePubkey) {
      rt.payeePubkey = check.pubkey;
    }
    if (check.status === "pass") {
      const methods = [...(check.methods ?? [])].sort().join(",");
      if (methods !== reportedMethods) {
        reportedMethods = methods;
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "lnbtc_credential",
            permitted_methods: methods === "" ? [] : methods.split(","),
            unverified: check.unverified === true,
          })
        );
      }
    }
  }

  /** One wallet permission check, applied to the gate; null means healthy. */
  async function runNwcCheck(): Promise<LightningFailure | null> {
    const check = await checkNwcConnection(rt.client);
    applyCheckResult(check);
    rt.gate.applyCheck(check);
    if (check.status === "pass") return null;
    return {
      category: check.status === "bad_credential" ? "auth" : "unreachable",
      upstreamStatus: null,
      upstreamMessage: check.reason.slice(0, 120),
    };
  }

  try {
    const gate = await startLnbtc({
      enabled: true,
      client: rt.client,
      log,
      onCheck: applyCheckResult,
    });
    rt.gate = gate;
  } catch (err) {
    // bad_credential: refuse to run with a credential that can spend.
    console.error((err as Error).message);
    process.exit(1);
  }

  rt.breakerRuntime = new LightningBreaker({
    initialBackoffMs: rt.breaker.initialBackoffMs,
    maxBackoffMs: rt.breaker.maxBackoffMs,
    probe: () => runNwcCheck(),
  });

  if (!rt.gate.canOffer()) {
    // Not a failure of the process: open the breaker so its timed probe owns
    // recovery, and keep USDC and free content serving meanwhile.
    rt.breakerRuntime.recordFailure({
      category: "unreachable",
      upstreamStatus: null,
      upstreamMessage: "wallet unreachable at startup",
    });
  }
}

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
  `mdf-server started — MDF 0.3.1`,
  `site: ${loaded.config.site.url}`
);

// ---------------------------------------------------------------------------
// Graceful shutdown — clear timers so they cannot hold the process open
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), event: "shutdown", signal })
  );
  loaded.lnbtc?.breakerRuntime?.stop();
  loaded.replayStore?.close();
  loaded.tokenStore.close();
  mainServer.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Dashboard server
// ---------------------------------------------------------------------------

function railLabel(network: string): string {
  if (network.startsWith("lnbtc:")) return "⚡ Lightning";
  if (network === "eip155:8453") return "Base";
  if (network === "eip155:84532") return "Base Sepolia";
  if (network === "eip155:1") return "Ethereum";
  return network;
}

function formatAmount(rail: { amount: string; network: string; asset: string }): string {
  const n = Number(rail.amount);
  if (rail.network.startsWith("lnbtc:")) {
    const sats = n / 1000;
    return `${sats} sat`;
  }
  const human = n / 1_000_000;
  return `${String(Number(human.toFixed(6)))} USDC`;
}

function buildDashboardHtml(): string {
  const cfg = loaded.config;
  const signals = cfg.signals;
  const sections = cfg.pricing.sections ?? {};

  type Tier = {
    path: string;
    access: string;
    rails: Array<{ amount: string; network: string; asset: string }>;
  };

  const tiers: Tier[] = [
    { path: "(default)", access: cfg.pricing.default.access, rails: cfg.pricing.default.rails },
    ...Object.entries(sections).map(([path, entry]) => ({
      path,
      access: entry.access,
      rails: entry.rails,
    })),
  ];

  const tierRows = tiers
    .map((t) => {
      const price =
        t.rails.length === 0
          ? "free"
          : t.rails.map((r) => `${formatAmount(r)} <span class="subtle">${railLabel(r.network)}</span>`).join(" or ");
      return `
    <tr>
      <td class="td-path"><code>${t.path}</code></td>
      <td class="td-price">${price}</td>
      <td class="td-rail">${t.access === "token" ? `<span class="badge badge-evm">token</span>` : ""}</td>
    </tr>`;
    })
    .join("");

  const configuredRails = new Map<string, string>();
  for (const entry of [cfg.pricing.default, ...Object.values(sections)]) {
    for (const rail of entry.rails) configuredRails.set(rail.network, rail.asset);
  }
  const railTags = [...configuredRails.keys()]
    .map((network) =>
      network.startsWith("lnbtc:")
        ? `<span class="tag tag-lightning">⚡ ${network}</span>`
        : `<span class="tag tag-evm">${network}</span>`
    )
    .join("");

  function sig(val: boolean, name: string): string {
    return `<span class="sig ${val ? "sig-on" : "sig-off"}">${name}</span>`;
  }

  const lnbtc = loaded.lnbtc;
  const lightningRow = lnbtc
    ? `<tr>
        <td class="meta-label">lnbtc rail</td>
        <td><span class="dot ${lnbtc.gate.canOffer() ? "dot-green" : "dot-off"}"></span> ${lnbtc.gate.canOffer() ? "offered" : "degraded"} &nbsp;<code class="subtle">NWC · make_invoice</code></td>
      </tr>
      <tr>
        <td class="meta-label">Invoice expiry</td>
        <td>${lnbtc.invoiceExpirySeconds}s</td>
      </tr>`
    : `<tr><td class="meta-label">lnbtc rail</td><td><span class="dot dot-off"></span> not configured</td></tr>`;

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
    font-size: 13px; line-height: 1.6;
    background: #0d1117; color: #c9d1d9;
    max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem 4rem;
  }
  .header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid #21262d; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .header h1 { font-size: 1.25rem; font-weight: 600; color: #58a6ff; letter-spacing: -.01em; }
  .header .site { color: #8b949e; font-size: .8rem; }
  .header .version { margin-left: auto; color: #3fb950; font-size: .75rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 2rem; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: .9rem 1rem; }
  .card .label { font-size: .7rem; color: #8b949e; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .3rem; }
  .card .value { font-size: 1.5rem; font-weight: 600; color: #58a6ff; }
  .card .sub { font-size: .75rem; color: #8b949e; margin-top: .15rem; word-break: break-all; }
  .section-title { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin: 1.75rem 0 .6rem; border-bottom: 1px solid #21262d; padding-bottom: .4rem; }
  table.tiers { width: 100%; border-collapse: collapse; }
  table.tiers th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; padding: .3rem .5rem; }
  table.tiers td { padding: .4rem .5rem; border-top: 1px solid #21262d; vertical-align: middle; }
  .td-path code { color: #c9d1d9; font-size: .8rem; }
  .td-price { color: #e6edf3; min-width: 100px; }
  .td-rail { text-align: right; }
  table.meta { width: 100%; border-collapse: collapse; }
  table.meta td { padding: .35rem .5rem; border-top: 1px solid #21262d; vertical-align: middle; }
  .meta-label { color: #8b949e; width: 140px; white-space: nowrap; }
  code { font-family: inherit; }
  code.subtle, .subtle { color: #6e7681; font-size: .78rem; }
  .badge { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; font-weight: 600; letter-spacing: .02em; }
  .badge-evm { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb55; }
  .tags { display: flex; flex-wrap: wrap; gap: .3rem; }
  .tag { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; }
  .tag-lightning { background: #f7931a22; color: #f7931a; border: 1px solid #f7931a44; }
  .tag-evm { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb55; }
  .signals { display: flex; flex-wrap: wrap; gap: .4rem; }
  .sig { display: inline-block; border-radius: 4px; padding: .1rem .45rem; font-size: .72rem; }
  .sig-on  { background: #3fb95018; color: #3fb950; border: 1px solid #3fb95033; }
  .sig-off { background: #21262d; color: #6e7681; border: 1px solid #30363d; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .dot-green { background: #3fb950; box-shadow: 0 0 4px #3fb95088; }
  .dot-off   { background: #6e7681; }
  .footer { margin-top: 3rem; color: #21262d; font-size: .7rem; }
</style>
</head>
<body>

<div class="header">
  <h1>mdf-server</h1>
  <span class="site">${cfg.site.url ?? "—"}</span>
  <span class="version">MDF 0.3.1 · server ${SERVER_VERSION}</span>
</div>

<div class="cards">
  <div class="card">
    <div class="label">Configured rails</div>
    <div class="value">${configuredRails.size}</div>
  </div>
  <div class="card">
    <div class="label">Token store</div>
    <div class="value" style="font-size:1.1rem">${loaded.tokenStoreBackend}</div>
  </div>
  <div class="card">
    <div class="label">Content dir</div>
    <div class="sub" style="font-size:.8rem;margin-top:.4rem">${loaded.contentDir}</div>
  </div>
  <div class="card">
    <div class="label">Price entries</div>
    <div class="value">${tiers.length}</div>
  </div>
</div>

<div class="section-title">Pricing</div>
<table class="tiers">
  <thead>
    <tr>
      <th>Path</th>
      <th>Rails</th>
      <th style="text-align:right">Access</th>
    </tr>
  </thead>
  <tbody>${tierRows}</tbody>
</table>

<div class="section-title">Payment</div>
<table class="meta">
  <tr>
    <td class="meta-label">Rails</td>
    <td><div class="tags">${railTags || "—"}</div></td>
  </tr>
  <tr>
    <td class="meta-label">Facilitator legs</td>
    <td><code class="subtle">${loaded.facilitator?.legs.join(" → ") || "—"}</code></td>
  </tr>
  <tr>
    <td class="meta-label">Auth endpoint</td>
    <td><code class="subtle">${(cfg.site.url ?? "") + (cfg.auth?.endpoint ?? "") || "—"}</code></td>
  </tr>
  ${lightningRow}
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
    <td><code class="subtle">${(cfg.site.url ?? "") + (cfg.feed?.url ?? "") || "—"}</code></td>
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
  fetch: (req, server) =>
    handleRequest(req, loaded, { peer: server.requestIP(req)?.address ?? null }),
  error(err) {
    console.error(`[mdf-server] unhandled error: ${err.message}`);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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
    tokenStore: loaded.tokenStoreBackend,
    rails: [...new Set(
      [loaded.config.pricing.default, ...Object.values(loaded.config.pricing.sections ?? {})]
        .flatMap((entry) => entry.rails.map((rail) => rail.network))
    )],
    lnbtc: loaded.lnbtc ? (loaded.lnbtc.gate.canOffer() ? "available" : "degraded") : "disabled",
  })
);

if (loaded.config.dashboard.enabled) {
  Bun.serve({
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
