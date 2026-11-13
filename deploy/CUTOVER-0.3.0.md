# Cutover to 0.3.0 — checklist and config diffs

**Not executed.** Everything below is for the later cutover brief. Stage B has
produced the files; nothing is on a host.

Deliverable index:

| artifact | file |
|---|---|
| demo node templates | `deploy/reference/my-mdf-server-syd.0.3.0.xml`, `my-mdf-server-prod.0.3.0.xml` |
| Valkey template + config | `deploy/reference/my-mdf-valkey.xml`, `valkey.conf` |
| server image | `bitcryptic/mdf-reference-server@sha256:60afaa2732304116369ae761009a0ca00f69c65c6c4054da723ad9f3a6815e44` (tag `0.3.0-rc.2`) |
| Valkey image | `valkey/valkey@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a` |
| live `mdf.yaml` | the repo's `mdf.yaml` is the reference; per-host differences are only the facilitator leg order and `site.url` is unchanged |

---

## 1. Production `mdf.yaml` diff (0.2.9 → 0.3.0)

The shape changes; the demo's tiers, prices and networks are preserved, plus the
new `/showcase/**` dual-rail route at Gary's prices (0.02 USDC / 20 sat).

```diff
 pricing:
-  default:   { amount: "0.0001", currency: USDC, chain: base }
-  sections:
-    /:                 { amount: "0.0000" }
-    /docs/**:          { amount: "0.0000" }
-    /micropayment/**:  { amount: "0.00000001", currency: BTC, chain: lightning }
-    /premium/**:       { amount: "0.01",   currency: USDC, chain: base }
-    /private/**:       { amount: "0.10",   currency: USDC, chain: base }
-    /testnet/**:       { amount: "0.0010", currency: USDC, chain: base_sepolia }
+  default:
+    rails: [ { scheme: exact, network: "eip155:8453", asset: "0x8335…2913", amount: "100" } ]
+  sections:
+    /:                 { rails: [] }
+    /docs/**:          { rails: [] }
+    /micropayment/**:  { rails: [ { scheme: exact, network: "lnbtc:0000…93", asset: BTC, amount: "1000" } ] }
+    /premium/**:       { rails: [ { scheme: exact, network: "eip155:8453", asset: "0x8335…2913", amount: "10000" } ] }
+    /private/**:       { access: token, rails: [ { scheme: exact, network: "eip155:8453", asset: "0x8335…2913", amount: "100000" } ] }
+    /testnet/**:       { rails: [ { scheme: exact, network: "eip155:84532", asset: "0x036C…CF7e", amount: "1000" } ] }
+    /showcase/**:      { rails: [ { scheme: exact, network: "eip155:8453", asset: "0x8335…2913", amount: "20000" },
+                                  { scheme: exact, network: "lnbtc:0000…93", asset: BTC, amount: "20000" } ] }

-payment: { endpoint: /mdf/pay, accepted_chains: […], accepted_currencies: […] }
+token_store: valkey                     # REQUIRED, no default; `memory` warns
+valkey: { url: "redis://mdf-valkey:6379", connect_timeout_ms: 2000, command_timeout_ms: 2000 }
+server: { trusted_proxies: ["100.76.221.87"] }   # caddy-linode
+payment: { max_timeout_seconds: 300 }    # also the BOLT11 expiry, exactly

 auth:
   endpoint: /mdf/auth
   token_ttl_seconds: 86400
-  price_threshold: "0.10"                # removed: `access: token` replaces it

 lightning:
-  api_url: http://10.61.21.97:8021/api
-  invoice_expiry_seconds: 3600
+  enabled: true
+  network: "lnbtc:000000000019d6689c085ae165831e93"
+  # node_pubkey omitted: resolved from get_info at startup
+  mint: { global_per_minute: 180, global_burst: 60, per_client_per_minute: 24, per_client_burst: 8 }
+  breaker_initial_backoff_seconds: 5
+  breaker_max_backoff_seconds: 300

 facilitator:
-  url: https://x402.bitcryptic.com         # v1 pool — 0.3.0 NEVER calls it
-  scheme: exact
-  max_timeout_seconds: 300
-  timeout_ms: 15000
-  chains: { base: { asset, decimals, extra, rpc_url }, base_sepolia: { … } }
+  legs: ["http://mdf-facilitator-syd:8080", "http://mdf-facilitator-public:8080"]   # mdf-server-syd
+  # MDF-Server-Prod reverses these two lines — per-instance primary/failover
+  timeout_ms: 15000
+  rpc: { "eip155:8453": "https://mainnet.base.org", "eip155:84532": "https://sepolia.base.org" }
```

Per-host values that differ:

| host | container | `facilitator.legs` order |
|---|---|---|
| unraid-syd | `mdf-server-syd` | `[syd, public]` |
| unraid-public | `MDF-Server-Prod` | `[public, syd]` |

New secret files on both hosts, mounted read-only. **Ownership matters as much as
mode: the 0.3.0 server runs as `bun` (uid 1000, gid 1000), so a mode-600 root-owned
file is unreadable and the container refuses to start.** Use mode `640`, owner
`root`, group `1000` (`bun`); mode `644` root:root also works and is what the
0.2.9 files use, but it is world-readable inside the container.

- `secrets/nwc_uri` — the instance's own dedicated NWC connection, Alby Hub's
  "Read your node info" + "Create invoices" scope (see step 3 of §3 for the exact
  tolerated method set). `mdf-server-syd` → app `mdf-server-syd`;
  `MDF-Server-Prod` → app `MDF-Server-Prod`. Created by Gary **before** the
  recreate; without it the container refuses to start while
  `lightning.enabled: true`.
- `secrets/valkey_password` — same 64-hex value as the Valkey ACL entry. The file
  ends with a newline (65 bytes); the loader trims it, so what is sent as AUTH is
  the same 64 hex characters the ACL holds.

Removed from the hosts: `secrets/alby_api_token`, `secrets/lightning_token_secret`
(the mounts are gone from the templates; the files can be deleted after the
recreate is verified).

## 2. Kuma

Monitors are auth-gated and Gary creates them. Three scopes, and they must not be
mixed up:

| scope | base URL | why |
|---|---|---|
| **per host** | `http://mdf-server-syd.pygmy-bramble.ts.net:3000`, `http://mdf-server-prod.pygmy-bramble.ts.net:3000` | Caddy's `lb_policy first` sends the public URL to prod, so a public-URL monitor labelled "syd" would actually test prod and syd could fail unnoticed. This is how the existing #48 monitors already reach the nodes. |
| **public** | `https://mdf-demo.bitcryptic.com` | what a user sees, through Caddy |
| **per leg** | `http://mdf-facilitator-syd.pygmy-bramble.ts.net:8080`, `…-public…` | the x402 v2 facilitator legs |

No new tailnet grant is needed for the per-host monitors: Kuma already reaches
both nodes on `tcp:3000` — the #48 monitors have been up against those exact
FQDNs, and were re-checked with live heartbeats on 2026-11-13. The per-leg
monitors need `uptimekuma → both legs tcp:8080`, which also exists.

`/health` answers **200 even while a rail is degraded or a store is down**, so
every check below is a body match, never a status code. All keyword strings are
substrings of the compact JSON the server emits, in the order shown; each was
matched against a live body before being written down.

### Per host — `syd` (`mdf-server-syd`) and `prod` (`mdf-server-prod`)

| monitor | path | type | keyword / expression |
|---|---|---|---|
| `MDF Demo (<host>) mdf.json 0.3.1` | `/mdf.json` | keyword | `"mdf_version": "0.3.1"` — with the space: the document is pretty-printed |
| `MDF Demo (<host>) rail 8453 ok` | `/health` | keyword | `"rail":"eip155:8453","status":"ok"` |
| `MDF Demo (<host>) rail 84532 ok` | `/health` | keyword | `"rail":"eip155:84532","status":"ok"` |
| `MDF Demo (<host>) lnbtc ok` | `/health` | keyword | `"rail":"lnbtc:000000000019d6689c085ae165831e93","status":"ok"` |
| `MDF Demo (<host>) lightning health` | `/health` | keyword, **inverted** | `degraded` |
| `MDF Demo (<host>) token store ok` | `/health` | keyword, **inverted** | `"token_store":{"status":"unavailable"` |
| `MDF Demo (<host>) replay store ok` | `/health` | keyword, **inverted** | `"replay_store":{"status":"unavailable"` |
| `MDF Demo (<host>) valkey unreachable (token)` | `/health` | keyword, **inverted** | `"token_store":{"status":"unavailable","category":"unreachable"` |
| `MDF Demo (<host>) valkey unreachable (replay)` | `/health` | keyword, **inverted** | `"replay_store":{"status":"unavailable","category":"unreachable"` |
| `MDF Demo (<host>) lnbtc offered` | `/micropayment/intro` | keyword, 402 accepted | `lnbtc:000000000019d6689c085ae165831e93` — mints one invoice per probe: keep it at 300 s (§4) |

`inverted` alerts when the keyword **is present**. The two `valkey unreachable`
monitors overlap the two plain `store ok` ones deliberately: the plain ones page
on *any* store fault, the anchored pair distinguishes "Valkey is not answering"
from "Valkey answers but rejects us", which is the difference between a
container-down page and a credential page.

### Public — one set, named `MDF public …`

| monitor | path | type | keyword |
|---|---|---|---|
| `MDF public mdf.json 0.3.1` | `/mdf.json` | keyword | `"mdf_version": "0.3.1"` |
| `MDF public rail 8453 ok` | `/health` | keyword | `"rail":"eip155:8453","status":"ok"` |
| `MDF public lnbtc offered` | `/micropayment/intro` | keyword, 402 accepted | `lnbtc:000000000019d6689c085ae165831e93` (mints — 300 s) |
| `MDF public home` — rename of `MDF Demo (live via caddy)` | `/` | keyword | `Micropayment sample` |

### Per leg — `MDF v2 (syd leg)` and `MDF v2 (pub leg)`

| monitor | path | type | keyword / expression |
|---|---|---|---|
| `MDF v2 (<leg>) supported` | `/supported` | keyword | that leg's signer: `0x0eebFF43652C205B51116C8E98dc1Ce2dC03ed2E` (syd), `0x496517b27772935895bcc17B98c8a5DbB541b648` (pub) |
| `MDF v2 (<leg>) health live` | `/health` | keyword | `"stale":false` |
| `MDF v2 (<leg>) gas 8453` | `/health` | **json-query** | `$number(signers[network='eip155:8453'].balanceWei) >= 200000000000000`, expected value `true` |
| `MDF v2 (<leg>) sepolia empty` | `/health` | keyword, **inverted** | `"network":"eip155:84532","address":"<that leg's signer>","balanceWei":"0"` |

### Why the gas check is a JSON Query and not a zero check

A keyword alert on `"balanceWei":"0"` fires only once settlements have already
started failing. Kuma 1.23.17 ships `jsonata` 2.1.0 and compares the expression's
result with `result.toString() === expectedValue`, so a boolean expression with
the expected value `true` is a proper "healthy while above the threshold" check.

Two details that make or break it:

- `balanceWei` is a **string** in the body, so `$number(...)` is required. A bare
  comparison would compare text.
- `>=` at the threshold rather than `>`: at exactly `200000000000000` wei the
  leg is still healthy, and `>` would page there.

Measured in Kuma's own runtime (Node 18.20.3, jsonata 2.1.0) on 2026-11-13, with
the same `toString()` comparison Kuma uses:

| body | result | monitor |
|---|---|---|
| live syd, `1000000000000000` | `true` | UP |
| live pub, `999410182020393` | `true` | UP |
| `0` | `false` | DOWN |
| `199999999999999` | `false` | DOWN |
| `200000000000000` (exactly) | `true` | UP |
| no `eip155:8453` entry | `undefined` | DOWN |

`200000000000000` wei is 0.0002 ETH, 20% of the 0.001 ETH each signer was
funded with, and at the measured 0.00000059 ETH per settle it is about 340
settles of runway before the page — early enough to top up, late enough not to
page on a single busy day. Gary can change the number.

### Two monitors are already red because of the upgrade

`MDF Demo (syd) wallet` and `MDF Demo (public) wallet` are json-query monitors on
`payment.wallet`: the 0.3.1 `/mdf.json` has no `payment` block, so both fail with
`Cannot read properties of undefined (reading 'toString')` and the group
`MDF Demo servers` is red only because of them.

Replace them with the same intent in the new shape — the payee now lives in the
402, not in `/mdf.json`:

| monitor | path | type | keyword |
|---|---|---|---|
| `MDF Demo (<host>) evm payTo` | `/premium/deep-dive` | keyword, 402 accepted | `"payTo":"0xa7D911138322aF8823642beA2b174dFaC2725fB7"` |

Keep the `mdf-v2-staging` tag on the new monitors; notifications stay off until
they have been green for a soak.

## 3. Order (server and pool are independent now)

1. **Valkey on unraid-private**: template applied, AOF directory present, ACL
   file in place, `PING` works with the password and fails without it. Paths on
   that host are under `/mnt/localdata/appdata/mdf-valkey/` — unraid-private has
   no `cache` pool (see `deploy/reference/README.md`, host-path note).

   **The ACL file must be owned by the uid Valkey runs as: `999:1000`, mode
   `600`.** `valkey/valkey:8.1-alpine` starts as root, then its entrypoint drops
   to the `valkey` user *before* reading `aclfile`, and it only chowns `/data`.
   A root-owned `600` ACL file makes the server abort immediately with
   `Aborting Valkey startup because of ACL errors … Permission denied` (verified
   against the pinned digest; `640` with group `1000` also works, and the
   directory holding it must be traversable — Docker creates `/run/secrets`
   `755`, so it is).

   **The config path goes in the template's `<PostArgs>`, not in `ORG_CMD`.**
   Unraid overwrites `ORG_*` with the image's own entrypoint and command for any
   Tailscale-enabled container, so an `ORG_CMD` carrying
   `valkey-server /etc/valkey/valkey.conf` is discarded: Valkey then starts with
   no config file, which means **no ACL (no password), no AOF and default
   settings** — it logs `Warning: no config file specified, using the default
   config`. `PostArgs` becomes `ORG_POSTARGS`, which the hook appends to the exec
   line. Confirm on the running container that `CONFIG GET appendonly` is `yes`
   and that an unauthenticated `PING` answers `-NOAUTH`; if either is wrong, the
   config was not loaded.

   Generate the password, build the ACL from it, **copy it to both demo hosts'
   password files first, and only then** remove the temporary plaintext on
   unraid-private: the copy is what must not be lost. The copies go on the demo
   hosts as `640 root:1000`, not `600 root` — see §1.
2. **Tailnet ACL**: the two demo nodes → `mdf-valkey` `tcp:6379`; the same two →
   both facilitator legs `tcp:8080`; `tag:caddy` → the two nodes `tcp:3000`
   (already exists). The nodes' names in the tailnet are `mdf-server-syd` and
   `mdf-server-prod`; `mdf-syd`, `mdf-prod`, `mdf-fac-syd` and `mdf-fac-pub` are
   **not** defined, so a policy written with them matches nothing. See the
   fragment in §3a.

   Verify from **inside** both current containers — the server image is
   `oven/bun:alpine` and has **no** `curl` and **no** `valkey-cli`, so use bun.
   `nc -z` is present and proves reachability only:

   ```sh
   # reachability
   docker exec mdf-server-syd nc -z mdf-valkey 6379
   # HTTP, without curl
   docker exec mdf-server-syd bun -e 'for (const u of ["http://mdf-facilitator-syd:8080/supported","http://mdf-facilitator-public:8080/supported"]) { try { const r = await fetch(u, {signal: AbortSignal.timeout(5000)}); console.log(r.status, u); } catch (e) { console.log("ERR", u, e.name); } }'
   # AUTH + PING. The 0.2.9 containers do not mount the password file yet (that
   # mount is added by the 0.3.0 template), so feed it on stdin from the host's
   # file — never in argv, an env var or a log line:
   #   cat <host password file> | docker exec -i mdf-server-syd bun -e '<check>'
   ```

   After the recreate, `/health`'s `replay_store.status` is the authoritative
   AUTH+PING check from that node.

   **2a. The ACL fragment, written against what exists.** The policy needs
   `hosts` entries (node names are not addressable directly) and a `grants` list.
   IPs are the nodes' current tailnet addresses; `mdf-valkey`'s is only known
   after it first starts (`tailscale ip -4` on unraid-private). If any of these
   hosts is already defined under another name, reuse that name instead of adding
   a second one.

   ```jsonc
   "hosts": {
     "mdf-syd":     "100.83.122.107",   // mdf-server-syd
     "mdf-prod":    "100.126.109.83",   // mdf-server-prod
     "mdf-fac-syd": "100.73.117.54",    // mdf-facilitator-syd
     "mdf-fac-pub": "100.72.0.21",      // mdf-facilitator-public
     "mdf-valkey":  "100.109.72.118"    // observed 2026-11-13; read it back with `tailscale ip -4` in the container
   },
   "grants": [
     { "src": ["mdf-syd", "mdf-prod"], "dst": ["mdf-valkey"], "ip": ["tcp:6379"] },
     { "src": ["mdf-syd", "mdf-prod"], "dst": ["mdf-fac-syd", "mdf-fac-pub"], "ip": ["tcp:8080"] },
     { "src": ["tag:caddy"], "dst": ["mdf-syd", "mdf-prod"], "ip": ["tcp:3000"] }
   ]
   ```

   The third grant already exists and is listed for completeness only. As of the
   2026-11-13 preflight the two demo nodes **could not** reach either
   `mdf-facilitator-*:8080` (TCP connect failure, not DNS), which is the missing
   second grant — the same pattern seen on 2026-11-10, when `tag:misc-services`
   accepted `:8080` only from explicitly granted sources. The Kuma node
   (`uptimekuma`, `100.67.151.96`) needs the same `:8080` treatment if its
   facilitator monitors read over the tailnet.

   **2b. Mainnet gas for the v2 signers — before the cutover goes public.**
   `/premium/**` and `/private/**` settle on `eip155:8453`, so a signer with zero
   mainnet ETH fails every mainnet payment at `/settle`. As of 2026-11-13 both
   signers read `0x0` on Base mainnet: `0x0eebFF43652C205B51116C8E98dc1Ce2dC03ed2E`
   (syd leg) and `0x496517b27772935895bcc17B98c8a5DbB541b648` (public leg). Fund
   both on **chain id 8453** — a signer only needs gas, never USDC — with a small
   amount sized for a few hundred settlements at current Base fees, and verify the
   balance on-chain before recreating anything. Until it is funded, `/health`
   reports `eip155:8453` as not `ok` and overall `status: degraded`; that is
   expected and is not a rail failure.
3. **Gary creates the production NWC connections** (`mdf-server-syd`,
   `MDF-Server-Prod`) and writes each `nwc_uri` file. Use Alby Hub's narrowest
   scope — **"Read your node info" + "Create invoices"** — which is what the
   server expects: it tolerates exactly `make_invoice`, `get_info`,
   `make_hold_invoice`, `settle_hold_invoice`, `cancel_hold_invoice` and
   `get_budget`, and refuses to start on anything else (including `pay_invoice`,
   `lookup_invoice`, `get_balance`). A make_invoice-only connection cannot be
   created in Alby Hub; do not try. Startup logs `lnbtc_credential` with the set
   the wallet actually reports — check it matches. Revoke the Stage B
   `mdf-server-dev` connection (already done 2026-11-13).
4. **Validate the new `mdf.yaml` offline** with the 0.3.0 loader — call the
   loader only, do not start the server. Do it with a **dummy secrets directory**
   holding correctly formatted fake values (a `0x`-address `wallet_address`, a
   well-formed `nostr+walletconnect://` `nwc_uri`, a 64-hex `valkey_password`),
   never the production secrets; and run it from the repo root, because
   `content.dir: ./content` is resolved against the working directory:

   ```sh
   # from the repo root, with a dummy secrets dir prepared elsewhere
   MDF_SECRETS_DIR=<dummy dir> bun -e 'import {loadConfig} from "./src/config/loader.ts"; const c = loadConfig(process.argv[1]); console.log(c.mdfJson)' <mdf.yaml>
   ```

   It exits non-zero on any config error, including a missing or malformed secret
   file, so a green exit also proves the three secret files are shaped correctly.
   Running `src/index.ts` would also work (it refuses before binding on a bad
   config) but it *serves* on a good one and opens NWC, which is not what an
   offline check should do.
4b. **Deploy the content as well as the config.** The release adds
   `content/showcase/dual-rail.md`; `/showcase/**` is priced, but the router 404s
   a path with no page *before* pricing is consulted, so a missing page turns the
   new dual-rail tier into a 404 instead of a 402. Content is read per request, so
   copying the file needs no restart — but a config-only deploy looks fine on
   `/health` and fails on the tier. Compare the repo's `content/` against the
   host's with hashes before staging.
5. **Recreate `mdf-server-syd`** (the failover) while `MDF-Server-Prod` serves
   public traffic. Verify directly over the tailnet: `/health` reports
   `version: 0.3.0`, `/mdf.json` says `0.3.1`, a 402 carries both rails on
   `/showcase/dual-rail`.
6. **Recreate `MDF-Server-Prod`** (exact mixed-case name). Caddy's
   `lb_policy first` falls through to syd on a failed dial, so no Caddy change
   is needed. If a 5xx appears in that window, stop and treat an upstream-order
   flip as a separate approved step.
7. **Verify through the public URL**: `/mdf.json` (0.3.1), a 402 with
   `PAYMENT-REQUIRED`, an lnbtc rail present, `/health` rails.
7b. **A live human payment has a 5-minute window.** `max_timeout_seconds: 300`
   is also the BOLT11 expiry, so the invoice, the wallet round trip and the
   preimage all have to happen inside five minutes; the server additionally
   tolerates 60 s of clock skew past the invoice's expiry (verified live: a proof
   submitted 34 s past the window settled). Mint immediately before the payer is
   ready rather than at the start of the step, and treat a lapsed invoice as a
   re-mint, not a failure.
8. **Kuma**: create/rename the monitors in §2; enable notifications after a
   10-minute green soak.
9. **Retire the v1 pool** (`x402.bitcryptic.com`) and 0.2.9 in a separate
   cleanup, after the soak.

**No Caddy change** at any point: the upstreams are MagicDNS names and the
containers keep their tailnet identity (state is under `/app/data`).

## 4. Mint-budget numbers, as deployed

Global 180/min burst 60; per client 24/min burst 8 (per client is keyed on the
caller's address, and every Kuma probe comes from the one `uptimekuma` node, so
they share a single bucket).

Only `lnbtc offered` mints an invoice; every other monitor just reads
`/health`, `/mdf.json`, `/`, `/supported` or a 402 on another tier.

| probes | rate at 300 s | share of global | share of one client |
|---|---|---|---|
| 2 per-host `lnbtc offered` (the #48 monitors) | 0.4/min | 0.2% | 1.7% |
| **3** with `MDF public lnbtc offered` added | **0.6/min** | **0.33%** | **2.5%** |

At 60 s the three would be 3/min: 1.7% global but **12.5% of one client**, over
the 10% ceiling — so the minting probes stay at 300 s. 90 s is the fastest
interval that still fits (2/min, 8.3% of one client) if faster lnbtc alerting is
ever wanted.

A probe that exhausted its own bucket would see the rail omitted from its 402 and
alert on itself; it cannot starve a real user.

## 5. Rollback

| layer | rollback |
|---|---|
| server image | recreate both containers on `bitcryptic/mdf-reference-server@sha256:38571c38532f97f304533b2a9214a569986e589462ccd1f30294e2e23ca3423b` (0.2.9) |
| config | restore the previous `mdf.yaml` from the host copy |
| templates | the 0.2.9 reference copies in `deploy/reference/*.redacted.xml` |
| Valkey | nothing to roll back: it holds ephemeral claims and token digests only, and 0.2.9 does not read it. Leave it running for the next attempt, or stop the container |
| Caddy | no change was made |

Order for a rollback: recreate the containers, then confirm `/health` reports
0.2.9, then the public URL. The v1 pool is untouched until step 9 of the
cutover, so an abandoned cutover can still fall back to it.

## 6. Known follow-ups (not this release)

- The dashboard on `:9090` is unauthenticated over the tailnet (0.2.7 note,
  still true). Bind it to loopback or drop it in a later release.
- Per-call WebSocket dials for NWC could hit public-relay throttling at high
  mint rates. If acceptance shows slow mints or intermittent `unreachable`,
  reuse connections with an idle timeout.
- `oracle_pubkey` is still mounted on both nodes with nothing reading it.
