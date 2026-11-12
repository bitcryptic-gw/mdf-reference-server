# Changelog

## 0.3.0 — x402 v2, spec 0.3.1

The payment layer is rewritten for x402 v2. This is a **hard cut**: there is no
v1 mode, `X-PAYMENT` is not read, and the L402 JSON/HMAC token is gone.

### Added

- **Multi-rail pricing.** A price entry is a list of rails, each with its own
  atomic amount in its own units (micro-USDC on `eip155`, millisatoshis on
  `lnbtc`). Every configured rail for a path appears in the 402's `accepts[]`;
  a degraded rail is omitted and the others are unaffected. If no rail can be
  offered the response is `503` + `Retry-After`, never a 402 with an empty
  `accepts[]`. (`src/payment/{rails,offers}.ts`)
- **`/mdf.json` generated from `mdf.yaml`**, so the document and the 402 agree by
  construction. It is rendered from *configured* rails only: a degraded or
  rate-limited rail stays declared and is omitted only from the offer.
  (`src/config/mdf-json.ts`)
- **lnbtc rail** (`exact` on `lnbtc:000000000019d6689c085ae165831e93`):
  NWC `make_invoice` with a description hash and an exact expiry, NIP-44 v2,
  request binding (`http:1`), local preimage verification, and a **shared,
  durable replay store** (`SET network:payment_hash NX EX …` in Valkey) — the
  scheme's requirement for one receiver served by more than one instance.
- **Valkey-backed token store** (hash-only: `SHA-256("mdf-token-v1:"‖id‖secret)`,
  256-bit secret, constant-time compare). `token_store: valkey | memory` is
  required with no default; `memory` logs a startup warning.
- **Trusted-proxy client keying** for the invoice-mint budget: `X-Real-IP` is
  trusted only from `server.trusted_proxies`, must be a single IP literal, and
  `X-Forwarded-For` is never read.
- **Per-rail `/health`**: `rails[]`, `replay_store`, and the 0.2.7 `lightning`
  block while that rail is degraded. HTTP stays 200 while a rail is degraded.
- **Payment-attempt log** (`payment_attempt`): one JSON line per priced request,
  fixed field set, header names only, coarse outcome classes.
- **Vendored 402 schema** (`src/payment/schemas/mdf-402.schema.json`, from
  `bitcryptic-gw/mdf@v0.3.1`, hash recorded in the test) replacing the test-time
  fetch from spec `main`.

### Changed

- **402 is an x402 v2 `PaymentRequired`**: MDF fields live under
  `extensions.mdf.info` (`version`, `source_bytes`, `expires_at`,
  `price_summary`, `auth_endpoint` for a token tier). The body **is** the
  object and `PAYMENT-REQUIRED` is the base64 of its exact bytes.
- **Facilitator topology**: an ordered list of v2 legs called directly over the
  tailnet (`facilitator.legs`), never the v1 pool at `x402.bitcryptic.com`.
  Failover only on a transport error before `/verify` answers; the answering leg
  is pinned for `/settle`, which never fails over and is never retried.
- **`settlement_pending`** is reconciled against the transaction the facilitator
  returned, and accepted only with a matching USDC `Transfer` (asset, `from`,
  `payTo`, exact `value`) or `authorizationState(from, nonce) == true`; anything
  else fails closed with 503.
- **Config model**: `{amount, currency, chain}` and the fixed sats/USD rate are
  gone; secrets are file-mounted only (`/run/secrets/{wallet_address,nwc_uri,valkey_password}`,
  directory overridable with `MDF_SECRETS_DIR` for local runs); an eip155 asset
  must be in the vendored per-network table, which also supplies the EIP-712
  domain (`"USD Coin"` on 8453, `"USDC"` on 84532).
- **Order of operations** in `verifyPayment`: offer → `PAYMENT-SIGNATURE` →
  rail match → verify → settle → serve. A mismatch is classified
  (`unsupported_rail`, `wrong_amount`, `wrong_recipient`) without calling the
  facilitator.
- `X-MDF-Price` / `X-MDF-Currency` now report the **first configured rail** in
  its atomic unit; the authoritative price set is `accepts[]` / `/mdf.json`.

### Removed

- The L402 path: `WWW-Authenticate: L402`, macaroon parsing, the HMAC token
  secret, and `payment.endpoint` (use `auth.endpoint`).
- `src/auth/auth.ts` (replaced by `src/auth/token-store.ts`).
- The fixed `1000 sats/USD` conversion and `auth.price_threshold`.
- The v1 facilitator `chains` registry and the settled-payment fallback that
  ignored expiry, resource or amount (#52).

### Routes

- New `/showcase/**` → `content/showcase/dual-rail.md`: Base mainnet USDC
  `20000` (0.02) **and** lnbtc `20000` msat (20 sat). Config-only to change.

### Tests

**339 passing, 0 failing** (baseline `d2784de`: 363 cases, 361 passing, 2 red).
Every removed case is mapped to its replacement in
`docs/STAGE-B-TEST-ACCOUNTING.md`, including all 58 L402 cases and the 14 v1
x402 cases. The 2 known `402-schema` failures are fixed, not carried forward.
