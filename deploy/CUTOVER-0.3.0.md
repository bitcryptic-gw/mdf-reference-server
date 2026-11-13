# Cutover to 0.3.0 — checklist and config diffs

**Not executed.** Everything below is for the later cutover brief. Stage B has
produced the files; nothing is on a host.

Deliverable index:

| artifact | file |
|---|---|
| demo node templates | `deploy/reference/my-mdf-server-syd.0.3.0.xml`, `my-mdf-server-prod.0.3.0.xml` |
| Valkey template + config | `deploy/reference/my-mdf-valkey.xml`, `valkey.conf` |
| server image | `bitcryptic/mdf-reference-server@sha256:60afaa2732304116369ae761009a0ca00f69c65c6c4054da723ad9f3a6815e44` (tag `0.3.0-rc.1`) |
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

New secret files on both hosts (mode 600, owner root, mounted read-only):

- `secrets/nwc_uri` — the instance's own dedicated NWC connection,
  `make_invoice` + `get_info` only. `mdf-server-syd` → app `mdf-server-syd`;
  `MDF-Server-Prod` → app `MDF-Server-Prod`. Created by Gary **before** the
  recreate; without it the container refuses to start while
  `lightning.enabled: true`.
- `secrets/valkey_password` — same 64-hex value as the Valkey ACL entry.

Removed from the hosts: `secrets/alby_api_token`, `secrets/lightning_token_secret`
(the mounts are gone from the templates; the files can be deleted after the
recreate is verified).

## 2. Kuma

Monitors are auth-gated and Gary creates them. Keyword checks are substrings over
`/health`'s documented, fixed-order encoding; `/health` stays HTTP 200 while a
rail is degraded, so a monitor must look at the body, not the status code.

| monitor (per host) | before | after | keyword |
|---|---|---|---|
| `mdf <host> lnbc` | `lnbc` on `/micropayment/intro`, 402 accepted | **rename `mdf <host> lnbtc offered`** | `lnbtc:000000000019d6689c085ae165831e93`, 402 accepted (it mints one invoice per probe — budgeted, see §4) |
| `mdf <host> lightning health` | inverted `degraded` on `/health` | **keep name and meaning** | inverted `degraded` (now only the lnbtc rail can produce it) |
| — | — | **new `mdf <host> rail 8453 ok`** | `"rail":"eip155:8453","status":"ok"` |
| — | — | **new `mdf <host> rail 84532 ok`** | `"rail":"eip155:84532","status":"ok"` |
| — | — | **new `mdf <host> lnbtc ok`** | `"rail":"lnbtc:000000000019d6689c085ae165831e93","status":"ok"` |
| — | — | **new `mdf <host> replay store ok`** | inverted `"replay_store":{"status":"unavailable"}` |
| — | — | **new `mdf <host> token store ok`** | inverted `"token_store":{"status":"unavailable"}` |
| — | — | **new `mdf <host> mdf.json 0.3.1`** | `"mdf_version": "0.3.1"` on `/mdf.json` |

The store checks now probe the way a request does (AUTH plus a cheap command on
the authenticated connection) and name the failure kind, so the body reads
`"token_store":{"status":"unavailable","category":"auth"}` when the password is
wrong and `…"category":"unreachable"` when nothing answers. The design note's
flat `"replay_store":"unavailable"` shape is superseded by this one, because a
category is what makes the failure actionable.

If Kuma has JSON Query with an expected value, prefer
`$.rails[?(@.rail=='eip155:8453')].status` → `ok`. Keep the `mdf-v2-staging`
tag; notifications stay off until the cutover is verified.

## 3. Order (server and pool are independent now)

1. **Valkey on unraid-private**: template applied, AOF directory present, ACL
   file in place, `PING` works with the password and fails without it.
2. **Tailnet ACL**: `mdf-syd`, `mdf-prod` → `mdf-valkey` `tcp:6379`; both →
   `mdf-fac-syd`, `mdf-fac-pub` `tcp:8080`; `tag:caddy` → the two nodes
   `tcp:3000` (already exists). Verify from **inside** both server containers:
   `valkey-cli -h mdf-valkey -a $(cat …) PING` and
   `curl http://mdf-facilitator-syd:8080/supported`.
3. **Gary creates the production NWC connections** (`mdf-server-syd`,
   `MDF-Server-Prod`), each `make_invoice` + `get_info` only, and writes each
   `nwc_uri` file. Revoke the Stage B `mdf-server-dev` connection.
4. **Validate the new `mdf.yaml` offline** with the 0.3.0 loader
   (`bun run src/index.ts` against the file with the secrets dir pointing at the
   host copy — it exits non-zero on any config error before binding a port).
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
8. **Kuma**: create/rename the monitors in §2; enable notifications after a
   10-minute green soak.
9. **Retire the v1 pool** (`x402.bitcryptic.com`) and 0.2.9 in a separate
   cleanup, after the soak.

**No Caddy change** at any point: the upstreams are MagicDNS names and the
containers keep their tailnet identity (state is under `/app/data`).

## 4. Mint-budget numbers, as deployed

Global 180/min burst 60; per client 24/min burst 8. The two `lnbtc offered`
probes at one per 5 minutes are 0.4/min: 0.2% of global, 1.7% of one client's
budget. Retuned to 60 s (as §2 suggests) it is 1.1% global and **8.3% of one
client's** — under the 10% ceiling, which is why the per-client refill is 24
rather than 12. A probe that exhausted its own bucket would see the rail omitted
and alert on itself; it cannot starve a real user.

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
