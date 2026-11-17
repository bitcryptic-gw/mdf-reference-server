# mdf-reference-server

Reference implementation of the [MDF (Markdown First)](https://github.com/bitcryptic-gw/mdf) spec, **v0.3.1**.

A self-hostable server that serves markdown natively to AI agents via HTTP content negotiation, with structured discovery (`/mdf.json`, `/llms.txt`), payment-gated content over **x402 v2**, and a bearer-token tier. Built with Bun and configured from a single YAML file. The container starts as root only for the Tailscale-in-container hook, then drops to an unprivileged user (`bun`, uid 1000) via su-exec.

**Live demo:** https://mdf-demo.bitcryptic.com
**Spec:** https://github.com/bitcryptic-gw/mdf (v0.3.1)
**Status:** server **0.3.0** — the x402 v2 hard cut. Two rails are live in production: USDC on Base (`exact`, `eip155:8453`) settled through x402 v2 facilitators, and Bitcoin Lightning (`exact`, `lnbtc`) with invoices minted over NWC and preimages verified locally. There is no v1 mode: `X-PAYMENT` and L402 are not supported. See [CHANGELOG.md](CHANGELOG.md).

---

## Quick start

```bash
git clone https://github.com/bitcryptic-gw/mdf-reference-server.git
cd mdf-reference-server

# Secrets are files, never environment variables or argv entries.
mkdir -p secrets
# TESTNET ONLY (see below). The burn address is a valid EIP-55 example so this
# runs as written — replace it with your own. Startup refuses anything that is
# not checksummed.
echo -n 0x000000000000000000000000000000000000dEaD > secrets/wallet_address
openssl rand -hex 32 | tr -d '\n' > secrets/valkey_password

# The server drops to uid 1000; Valkey runs as uid 999, gid 1000. root:1000 mode
# 640 is readable by both. (Docker Desktop on macOS normalises bind-mount
# ownership, so on macOS this step is a no-op rather than a requirement.)
sudo chown root:1000 secrets/wallet_address secrets/valkey_password
sudo chmod 640 secrets/wallet_address secrets/valkey_password

docker compose up --build
```

Then check it from another terminal:

```bash
curl -s localhost:3030/health | python3 -m json.tool   # token_store and replay_store both "ok"
curl -s localhost:3030/mdf.json | python3 -m json.tool # "mdf_version": "0.3.1"
curl -i localhost:3030/premium/deep-dive               # 402 + PAYMENT-REQUIRED, accepts[] = eip155:84532
```

The server listens on host port 3030 → container 3000. The dashboard (port 9090) is not mapped to the host and has no authentication: reach it only over Tailscale or an internal network.

### What the compose stack is, and is not

`docker-compose.yml` runs a single-host stack from **`mdf.compose.yaml`**, not from the demo hosts' `mdf.yaml` (that file is drift-tracked on the demo servers, so the quick start gets its own).

**It is Base Sepolia only.** Every priced rail in `mdf.compose.yaml` is `eip155:84532` with Base Sepolia USDC, and there is no mainnet rail anywhere in the file. That is deliberate: the quick start ships a placeholder wallet, and a forgotten placeholder must only ever be able to waste test funds. **Replace `secrets/wallet_address` before any real use**, and for a mainnet configuration start from `mdf.yaml` (the demo file) with a real EIP-55 wallet — do not edit `mdf.compose.yaml` in place to add an `eip155:8453` rail.

It also runs with **Lightning off** — an `lnbtc` rail needs a funded Nostr Wallet Connect connection — so no `nwc_uri` secret is involved. The token store and the `lnbtc` replay store share a local **Valkey 8** service: AOF `everysec`, `noeviction`, `requirepass` read from the mounted `valkey_password` file, no host port.

The stack **mints real 402s but settles nothing**: `facilitator.legs` in `mdf.compose.yaml` is a placeholder. To settle test-USDC, point it at a reachable, Sepolia-capable x402 v2 facilitator you control. To enable Lightning, mount `nwc_uri`, set `lightning.enabled: true`, and add the `lnbtc` rail back to a section — see [Lightning](#lightning-lnbtc).

One cosmetic wrinkle: `site.url` must start with `https://` (the config schema refuses anything else), so `mdf.compose.yaml` declares `https://localhost:3030` while the listener is plain HTTP. That URL is what 402 bodies, `/mdf.json` and the feed advertise.

---

## Try it (live demo)

```bash
# Discovery
curl https://mdf-demo.bitcryptic.com/mdf.json
curl https://mdf-demo.bitcryptic.com/llms.txt

# Markdown by content negotiation
curl -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/
curl -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/docs/getting-started

# Priced content: 402 with an x402 v2 PaymentRequired body and PAYMENT-REQUIRED header
curl -i -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/premium/deep-dive     # 0.01 USDC on Base
curl -i -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/micropayment/intro    # 1 sat over Lightning
curl -i -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/showcase/dual-rail    # Base USDC or Lightning
curl -i -H "Accept: text/markdown" https://mdf-demo.bitcryptic.com/testnet/intro         # Base Sepolia test USDC

# Token tier: 402 with an auth_endpoint hint; one payment buys a 24 h bearer token
curl -i https://mdf-demo.bitcryptic.com/private/internals

# Atom feed with mdf:change_type metadata
curl https://mdf-demo.bitcryptic.com/feed.xml
```

To pay, an x402 v2 client retries the request with a `PAYMENT-SIGNATURE` header built from one entry of `accepts[]`. A successful paid response carries `PAYMENT-RESPONSE`.

---

## Configuration

All configuration lives in one YAML file: `mdf.yaml` by default, or whatever `MDF_CONFIG` points at. The repo ships two: `mdf.yaml` for the demo hosts (both rails, shared Valkey, per-host facilitator order) and `mdf.compose.yaml` for the quick start (Base Sepolia only, no Lightning, local Valkey).

Pricing is per path, and each path lists the **rails** it accepts. Every rail states its own atomic amount in its own unit (micro-USDC on `eip155`, millisatoshis on `lnbtc`). There is no exchange rate anywhere.

```yaml
pricing:
  default:
    rails:
      - scheme: exact
        network: "eip155:8453"
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   # USDC on Base
        amount: "100"                                          # 0.0001 USDC
  sections:
    /docs/**:
      rails: []                                                # free
    /micropayment/**:
      rails:
        - scheme: exact
          network: "lnbtc:000000000019d6689c085ae165831e93"
          asset: BTC
          amount: "1000"                                       # 1 sat
    /private/**:
      access: token                                            # pay once, get a 24 h bearer token
      rails:
        - scheme: exact
          network: "eip155:8453"
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          amount: "100000"                                     # 0.10 USDC
```

`/mdf.json` is generated from this block at startup, so the published document and every 402's `accepts[]` agree by construction. A degraded or rate-limited rail stays **declared** in `/mdf.json` and is omitted only from the 402.

**Secrets** are read only from files: `<MDF_SECRETS_DIR>/wallet_address` (default `/run/secrets`; required once an `eip155` rail is priced), `…/nwc_uri` (required when `lightning.enabled: true`), and `…/valkey_password` (used when a `[valkey]` block is configured). There is deliberately no env-var fallback for a secret value. Startups fail closed on: a priced `eip155` rail with no wallet, an address that is not EIP-55 checksummed, an `eip155` asset missing from the built-in per-network table, a missing required secret file, and an `lnbtc` rail with `lightning.enabled: false`. A missing `valkey_password` does **not** abort startup — if that Valkey requires a password it then answers `NOAUTH`, and `/health` reports the store as unavailable.

**`token_store`** is required and has no default: `valkey` for anything with more than one instance, `memory` for a single local process only (it logs a startup warning, because tokens are instance-local and a restart drops them).

**Environment variables** — paths and ports only, never values:

| Variable | Purpose | Default |
|---|---|---|
| `MDF_CONFIG` | config file path | `./mdf.yaml` |
| `MDF_PORT` | main HTTP port | `3000` |
| `MDF_DASHBOARD_PORT` | overrides `dashboard.port` | config value (`9090`) |
| `MDF_DATA_DIR` | writable dir for `feed-events.ndjson` | `/app/data` |
| `MDF_SECRETS_DIR` | directory holding secret files | `/run/secrets` |
| `MDF_WATCH_INTERVAL_MS` | content poll interval | `30000` |

---

## Payment rails

**USDC on Base (`exact`, `eip155:8453`; Base Sepolia `eip155:84532` for testing).** The server builds the payment requirements from the offer it issued and calls an ordered list of x402 v2 facilitator legs (`facilitator.legs`). Failover happens only on a transport error before `/verify` answers; a leg that answers at all is pinned for the rest of the request, and `/settle` is never retried. A `settlement_pending` result is reconciled against the transaction the facilitator returned and accepted only with a matching USDC `Transfer` (asset, `from`, `payTo`, exact `value`) or `authorizationState(from, nonce) == true`; anything else fails closed with 503.

**Lightning (`exact`, `lnbtc`).** Invoices are minted over Nostr Wallet Connect (`make_invoice`) with the request's description hash and an expiry equal to `payment.max_timeout_seconds`, and preimages are verified locally. Replays are refused across instances and restarts through the shared Valkey store. The NWC connection must not hold a spending permission: a credential that reports `pay_invoice`, `pay_keysend`, or any method outside the invoice-minting allowlist makes the process **exit 1** at startup. An unreachable relay or wallet is different — the process starts with the rail degraded and re-checks on the invoice breaker's backoff. The rail is advertised only once the receiver node key is known (from `get_info` or `lightning.node_pubkey`).

A degraded rail is left out of `accepts[]` and the other rails are unaffected. If no rail can be offered, the response is `503` with `Retry-After`, never a 402 with an empty `accepts[]`.

### Lightning (lnbtc)

Set `lightning.enabled: true`, mount `nwc_uri`, and add an `lnbtc` rail to a section. The connection needs invoice minting (`make_invoice`), not a spending scope. See `mdf.yaml` for a complete example, including the mint rate limits and breaker backoff.

### Token tier

A section with `access: token` does not serve content on payment; it sells a bearer token. `POST` to `auth.endpoint` (`/mdf/auth`; `/mdf/pay` is an accepted alias) with the section path as `resource` and a `PAYMENT-SIGNATURE` for that section:

```bash
curl -X POST https://mdf-demo.bitcryptic.com/mdf/auth \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64 PaymentPayload>" \
  -d '{"resource":"/private/internals"}'
# → {"token":"…","expires_at":"…","ttl_seconds":86400}
```

The token is scoped to that section and sent as `Authorization: Bearer <token>`. Issuance is idempotent on the payment: if a settlement succeeds but the token write fails, retrying the **same** signature inside a 15-minute window issues the token without verifying or settling again (`503` + `Retry-After: 5` while the store is down). One payment can never mint two credentials, and it cannot be re-targeted at another section.

---

## Health and reverse proxy

`/health` on the **main port** returns 200 while the content directory is readable and the data directory writable, 503 otherwise, with:

- `status` — `ok` / `unavailable`
- `version` — the server release version (`0.3.0`)
- `rails[]` — one `{"rail":"<network>","status":"ok|degraded"}` per configured rail
- `token_store` — `{"status":"ok"}` or `{"status":"unavailable","category":"auth|unreachable"}`
- `replay_store` — same shape, present only when Valkey is configured
- `lightning` — breaker/gate detail, present only while that rail is degraded

A single degraded rail does not change the HTTP status, so a load balancer does not pull an instance that is still selling its other rails. The image's Docker `HEALTHCHECK` probes `/health`.

The dashboard serves a *different* `/health` on its own port (`{"ok":true,"ts":"…"}`). Do not point a load balancer at it: the dashboard has no authentication, which is why compose maps 3000 and not 9090.

A Caddy snippet is in `caddy/Caddyfile`. Inside the compose network, proxy to `mdf-server:3000`; from outside Docker, to the published host port 3030. `X-Real-IP` is trusted only from `server.trusted_proxies`, and `X-Forwarded-For` is never read.

---

## Feature status

| Feature | State |
|---|---|
| Content negotiation (`Accept: text/markdown`), `Vary: Accept`, per-representation ETag | ✅ |
| `/mdf.json` (spec 0.3.1) and `/llms.txt` generation | ✅ |
| Atom feed with `mdf:change_type`, WebSub hub | ✅ |
| x402 v2 `PaymentRequired` 402 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) | ✅ |
| USDC on Base via v2 facilitator legs, on-chain confirmation | ✅ |
| Lightning `lnbtc` via NWC, shared replay store | ✅ |
| Multi-rail sections (`/showcase/**`) | ✅ |
| Token tier (`access: token`, Valkey-backed, idempotent issuance) | ✅ |
| Per-rail `/health` | ✅ |
| Dashboard | ✅ (unauthenticated, keep internal) |

Conformance: the [MDF validator](https://github.com/bitcryptic-gw/mdf-validator) v0.3.0 reported **56/56 checks passing, 0 warnings** against the live demo on 2026-11-13.

---

## Development

```bash
bun install
bun run test        # 358 tests, 0 failures, as of c56651a

# Manual walk-through: starts its own server with throwaway config and secrets,
# prints each response, never pays anything.
bash smoke-test.sh
```

To run the server yourself, give it a config and the secrets that config names:

```bash
MDF_CONFIG=./mdf.compose.yaml MDF_SECRETS_DIR=./secrets MDF_DATA_DIR=./data \
  bun run dev       # bun --watch; or: bun run src/index.ts
```

`mdf.compose.yaml` expects a Valkey service at `valkey:6379` (the compose stack provides one) and a `valkey_password` file; a config with `token_store: memory` and no `[valkey]` block is the simplest way to run without one. `smoke-test.sh` generates exactly that and is the reference for a self-contained local config.

`smoke-test.sh` is a walk-through, not an assertion suite: it prints each response and has no pass/fail verdict. It covers discovery, content negotiation, a free page's headers, an unpaid 402 and a malformed `PAYMENT-SIGNATURE` 402, the token tier's 402 with its `auth_endpoint`, a conditional 304, `/health` on both ports, and 404s. It cannot show token issuance, because a token cannot be minted without paying.

## Authors

**Gary Walker** / [BitCryptic™](https://bitcryptic.com)
**Graham Hall** / [Slepner](https://slepner.com.au)

## License

MIT
