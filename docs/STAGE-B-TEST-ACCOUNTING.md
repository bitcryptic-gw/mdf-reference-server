# Stage B test migration accounting (#64, server 0.3.0)

Baseline: `feat/x402-v2-spec-0.3.1` @ `d2784de` — **363** `test()` cases,
361 passing, 2 red (`402-schema` fetching spec `main` and comparing a v1 body
against a v2 schema).

After the swap-over: **339** cases, **339 passing**, `bun run test` exits 0.

Nothing was dropped silently: every removed case is listed below with its
replacement, and the two red cases are now green against a vendored schema.

| file | before | after | disposition |
|---|---:|---:|---|
| `src/config/loader.test.ts` | 37 | 42 | rewritten for rails; 12 removed concepts replaced 1:1 or better |
| `src/content/handler.test.ts` | 39 | 40 | 36 kept verbatim; 2 price-header cases rewritten; 1 added |
| `src/router.test.ts` | 23 | 44 | rewritten; also absorbs `auth-pay.test.ts` (13) and gains 8 0.3.0 cases |
| `src/auth/auth-pay.test.ts` | 13 | — | **merged into `router.test.ts`** (token endpoint is router behaviour) |
| `src/health.test.ts` | 3 | 7 | 3 kept; 4 added (rails[], degraded block, replay_store, Kuma substring) |
| `src/source-bytes.test.ts` | 2 | 2 | kept; path moved to `extensions.mdf.info` |
| `src/payment/402-schema.test.ts` | 2 | 8 | rewritten against the **vendored** 0.3.1 schema (was the 2 red) |
| `src/payment/l402-invoice.test.ts` | 23 | — | deleted with the L402 path; see below |
| `src/payment/l402-verify.test.ts` | 17 | — | deleted with the L402 path; see below |
| `src/payment/l402-failure.test.ts` | 18 | — | deleted; 15 rail-degradation intents kept, 3 macaroon-only |
| `src/payment/x402-verify.test.ts` | 14 | — | superseded by `facilitator.test.ts` + `payment.test.ts` |
| `src/payment/payment.test.ts` | — | 24 | **new**: the facade's order of operations and failure classes |
| all other suites | 172 | 172 | unchanged (rails +1: the CAIP-2 id in the summary) |

Arithmetic: 143 (migrated files) + 172 (unchanged) + 24 (new facade suite) = 339.

---

## `l402-invoice.test.ts` (23) — deleted with the rail

The whole file tested the fixed `1000 sats/USD` conversion and the L402
challenge, both deleted by design (item 4: no exchange rates; item 8: no L402).

| removed case | disposition |
|---|---|
| `exact whole satoshi: 1.0000 USD → 1000 sats` | **concept removed.** USD→sats conversion is gone. The lnbtc rail states msat directly; `rails.test.ts` "a valid lnbtc rail needs whole satoshis and BTC" and `loader.test.ts` "a sub-satoshi lnbtc amount refuses to start at load time" pin the replacement invariant. |
| `exact whole satoshi: 0.0010 USD → 1 sat` | as above (`loader.test.ts` "an lnbtc amount below the 1-sat floor refuses to start"). |
| `fractional, below one satoshi: 0.00000001 → 0.00001 sats` | **concept removed**: sub-satoshi prices are a startup error, not a rounding decision (`loader.test.ts`, same two cases). |
| `fractional, just above a whole satoshi: 1.0009 USD → 1000.9 sats` | **concept removed** (no conversion, so no fractional sats to round). |
| `invalid price yields 0 (never a negative or NaN invoice)` | replaced: an invalid amount fails schema/rail validation before any invoice exists (`rails.test.ts` "decimal and zero amounts are refused as non-atomic"). |
| `BTC converts at 1 BTC = 100,000,000 sats` | **concept removed**. |
| `USD and USDC use the fixed 1000 sats/USD rate` | **concept removed** (decision 12/49: the publisher sets each rail's price). |
| `a BTC price is no longer read at the USD rate` | **concept removed**. |
| `an unsupported lightning currency is a hard error, not a silent misread` | replaced: an lnbtc rail must use `asset: BTC` (`loader.test.ts` "an lnbtc rail with a non-BTC asset refuses to start"). |
| `exact whole number: 1000 sats → 1,000,000 msat` | **concept removed** (msat is the configured unit). |
| `just above a whole satoshi rounds up: 1000.9 → 1,001,000 msat` | replaced by the load-time refusal (`rails.test.ts`, "whole satoshis"). |
| `below one satoshi rounds up to 1 sat: 0.00001 → 1000 msat` | replaced by the load-time floor refusal (`loader.test.ts`). |
| `zero/non-finite floors at 1 sat (never a zero invoice)` | replaced: `AtomicAmount` refuses `0` (`rails.test.ts` "decimal and zero amounts are refused as non-atomic"). |
| `/micropayment (0.00000001 BTC = 1 sat) → 1000 msat, not 1` | replaced by `offers.test.ts` "the lnbtc invoice commits to this request's binding" (asserts the mint receives `amountMsat` from the rail). |
| `/premium (1.0000 USDC → 1000 sats) → 1,000,000 msat, not 1000` | **concept removed** (no cross-rail conversion; `/premium` is eip155-only now). |
| `/private (100.00 USDC → 100,000 sats) → 100,000,000 msat` | **concept removed** (same). |
| `/testnet (0.0010 USDC → 1 sat) → 1000 msat` | **concept removed** (same). |
| `/fractional (1.0009 USDC → 1000.9 sats) rounds up → 1,001,000 msat` | **concept removed**. |
| `/micropayment: 402 advertises 0.00000001 BTC = the 1 sat invoiced` | replaced by `402v2.test.ts` "the summary is derived from the offered rails and agrees with them" + `offers.test.ts` binding case: the advertised `amount` is the rail's msat and the invoice is minted for exactly that. |
| `an x402 offer carries no L402 header, invoice field or Alby call` | replaced by `402v2.test.ts` "a 402 is no-store, carries X-MDF-Version 1, and has no L402 challenge" and `router.test.ts` "a 402 carries X-MDF-Version: 1 and no WWW-Authenticate". |
| `a lightning offer still carries the L402 challenge and invoice field` | **obsolete**: there is no L402 challenge. The replacement is `offers.test.ts` "both rails are offered for a dual-rail route" + `402-schema.test.ts` "a dual-rail 402 body validates". |
| `Alby 500 returns a typed rejected failure with the upstream status` | replaced by `lnbtc-nwc.test.ts` (NWC error classification) + `offers.test.ts` "a mint failure omits the rail rather than emitting a broken invoice" + `breaker.test.ts` (9 cases: open, backoff, recovery, snapshot without upstream text). |
| `a suppressed retry does not call Alby while the breaker is open` | replaced by `breaker.test.ts` "does not log per suppressed attempt; reminds only at the cap" and `offer` degradation cases. |

## `l402-verify.test.ts` (17) — deleted with the path

Macaroon-based verification does not exist in 0.3.0. Its *security intents* are
carried by the lnbtc suite (invoice binding + preimage + durable replay), which
is where the equivalent guarantees now live.

| removed case | disposition |
|---|---|
| `valid credential with matching settled invoice is accepted` | replaced by `payment.test.ts` "a correct invoice and preimage is approved…" and `lnbtc.test.ts` "a fully matching invoice passes every check". |
| `scope covers any resource under the paid section` | replaced by `token-store.test.ts` scope cases + `router.test.ts` "the issued token serves its own section, and only its own section". |
| `wrong preimage is rejected (hash mismatch)` | replaced by `payment.test.ts` "a wrong preimage is refused and claims nothing". |
| `macaroon scoped to a different path is rejected` | **concept removed** (no macaroons). Token scope equivalent: `router.test.ts` cross-section case. |
| `tampered macaroon signature is rejected` | **concept removed** (no macaroon signature; the lnbtc equivalent is the recovered signing key check) → `lnbtc.test.ts` "each binding violation is refused with its own reason" (`payee`). |
| `truncated macaroon (no signature separator) is rejected` | **concept removed**; token format equivalent is `router.test.ts` "a wrong secret, or the same id with a short secret, is refused". |
| `malformed L402 header is rejected` | **concept removed** (L402 header no longer exists) → `router.test.ts` malformed `PAYMENT-SIGNATURE` case. |
| `unsettled / pending invoice is rejected` | replaced by `lnbtc.test.ts`/`payment.test.ts` preimage requirement (no preimage, no approval) — "a missing preimage is refused". |
| `unknown invoice (no matching transaction) is rejected` | replaced by the binding rules: an invoice not minted for this request fails the description-hash check (`payment.test.ts` "an invoice bound to another resource is refused"). |
| `expired credential is rejected` | replaced by `payment.test.ts` "an expired invoice is refused as payment_expired". |
| `scope is a path-segment boundary, not a bare string prefix` | replaced by `token-store.test.ts` `pathInScope` cases. |
| `credential for one paid section cannot be reused on another` | replaced by `router.test.ts` cross-section token case. |
| `settled invoice with a mismatched recorded preimage is rejected` | replaced by `payment.test.ts` "a wrong preimage is refused and claims nothing". |
| `router: a valid L402 credential serves a lightning-priced route` | **obsolete** (no credential to present); the equivalent is a paid lnbtc request, covered by `payment.test.ts` approval + `router.test.ts` paid-path shape for eip155. |
| `router: an invalid L402 credential returns 402, not content` | replaced by `router.test.ts` "a v1-shaped payroll is not silently upgraded" (a stale `Authorization: L402 …` is now just a failed Bearer check, refused with the normal offer). |
| `router: X-PAYMENT alone never satisfies a lightning route` | replaced by `router.test.ts` "an X-PAYMENT-only request is unpaid, and logged by header name". |
| `verifyL402 rejects … when lightning is unconfigured` | replaced by `router.test.ts` "an lnbtc-only route with a degraded rail is 503 + Retry-After" (an unconfigured rail is not offered at all). |

## `l402-failure.test.ts` (18) — 15 kept in spirit, 3 macaroon-only

| removed case | disposition |
|---|---|
| `replaces a known secret value with [redacted]` | replaced by `attempt-log.test.ts` "no forbidden field name or secret-shaped value can appear" (the 0.3.0 redaction contract: the record has no free-text field). |
| `replaces Bearer and Authorization values` | replaced by the same test + `router.test.ts` token cases (no token value is ever logged). |
| `replaces long hex (preimages, payment hashes) and long opaque tokens` | replaced by `attempt-log.test.ts` allowlist test; `payment.test.ts` "an lnbtc settlement header … never echoes the preimage". |
| `collapses control characters and caps length` | replaced by `attempt-log.test.ts` "the reason is truncated to the coarse vocabulary's scale". |
| `HTTP 500 with a body maps to rejected and keeps the reason` | replaced by `facilitator.test.ts` "no failover after an HTTP response with no verdict" + `router.test.ts` "a structured /verify denial is a 402 whatever the HTTP status". |
| `HTTP 400 maps to rejected` | as above (any HTTP + `isValid:false` ⇒ denial). |
| `HTTP 401 maps to auth` | replaced by `lnbtc-nwc.test.ts` / `lnbtc-availability.test.ts` "an auth failure from the wallet is a credential problem, not an outage". |
| `HTTP 403 maps to auth` | same. |
| `a connection error maps to unreachable with no status` | replaced by `facilitator.test.ts` "all legs down is an outage, not a denial". |
| `a timeout maps to unreachable` | same case (transport error = the only failover trigger). |
| `an unparseable 200 body maps to unknown` | replaced by `facilitator.test.ts` "no failover after an HTTP response with no verdict". |
| `while degraded, no backend call is made and the rail is not advertised` | replaced by `offers.test.ts` "gate degraded (relay down): eip155 still offered, lnbtc omitted". |
| `the public 503 body never contains the upstream message` | replaced by `router.test.ts` "a structured /verify denial … upstream detail never reaches the wire" and `402v2.test.ts` "the error field is coarse and cannot carry facilitator detail". |
| `/health is 200 ok with a lightning block while degraded, message-free` | replaced by `health.test.ts` "a degraded lnbtc rail is reported in rails[] and in the lightning block". |
| `a healthy /health has no lightning block (0.2.6-compatible)` | replaced by `health.test.ts` "healthy /health returns 200 JSON with status ok and package version" (block absent) + `health.test.ts` "rails[] lists every configured rail". |
| `x402 route 402 is unchanged and carries no lightning fields` | replaced by `402v2.test.ts` "the object is a v2 PaymentRequired …" and `402-schema.test.ts` eip155 case. |
| `lightning route 402 carries the challenge and no degraded flag` | **obsolete** (no challenge). Replaced by `offers.test.ts` dual-rail + degraded-omission cases. |
| `shutdownLightningBreakers clears state and is idempotent` | replaced by `breaker.test.ts` "stop() clears the armed timer and prevents further probes" (the 0.3.0 shutdown path calls `breaker.stop()`). |

## `x402-verify.test.ts` (14) — superseded

v1 envelopes and the v1 fallback. Every intent is carried by the v2 suites.

| removed case | disposition |
|---|---|
| `used nonce (HTTP 500 with isValid:false) → rejected, no settle, no on-chain` | `router.test.ts` "a structured /verify denial is a 402 whatever the HTTP status, and never settles". |
| `used nonce → router 402 with no-store` | same case (asserts 402) + `router.test.ts` no-store case. |
| `expired authorization → rejected` | `facilitator.test.ts` "a settle error is recovered only for the verified (from, nonce)" + `402.ts` `coarseErrorClass` expiry mapping (`402v2.test.ts` "coarseErrorClass maps facilitator reasons to the closed vocabulary"). |
| `under-amount → rejected` | `router.test.ts` "a payment for the wrong amount is refused as wrong_amount, with no settle" and `payment.test.ts` classify cases. |
| `wrong asset / bad signature (isValid:false) → rejected` | `payment.test.ts` "a rail this server does not price for the path is an unsupported_rail refusal" + router denial case. |
| `wrong pay_to → rejected before the facilitator is called` | `payment.test.ts` "a payload whose accepted.payTo is not our wallet is a wrong_recipient refusal" (asserts zero fetches). |
| `facilitator 500 with an unstructured body → error (503), not 402` | `facilitator.test.ts` "no failover after an HTTP response with no verdict" + `router.test.ts` "a facilitator outage is a 503". |
| `facilitator unreachable (transport) → error (503)` | `facilitator.test.ts` "all legs down is an outage, not a denial". |
| `happy path: verify ok + settle ok → approved / 200` | `router.test.ts` "a verified and settled payment serves the content with PAYMENT-RESPONSE". |
| `settle error + on-chain settled → approved / 200` | `facilitator.test.ts` "a settle error is recovered only for the verified (from, nonce)". |
| `settle error + on-chain NOT settled → error (503), no approval` | `facilitator.test.ts` "a settle error with an unused nonce fails closed" + `router.test.ts` "a settle error that cannot be confirmed on-chain fails closed with 503". |
| `settle error + on-chain lookup fails/timeout → error (503), fails closed` | `facilitator.test.ts` "an RPC failure is unknown, never a denial" (+ the pending-path equivalents: no receipt, wrong amount, unrelated Transfer). |
| `invariant: on-chain confirmation is unreachable unless /verify succeeded` | `facilitator.test.ts` "a successful receipt alone never satisfies confirmSettlementOnChain" and the pending cases that require a matching Transfer or nonce. |
| `invariant: a replayed used nonce never reaches settle or the on-chain check` | `router.test.ts` "a structured /verify denial … and never settles". |

## `auth-pay.test.ts` (13) — merged into `router.test.ts`

The token endpoint is router behaviour, so its cases moved rather than
disappearing; the store is `auth/token-store.ts` and has its own suite.

| removed case | replacement in `router.test.ts` |
|---|---|
| `unpaid POST /mdf/auth → 402 offer, no token` | same name |
| `unpaid POST /mdf/pay → 402, no token (alias is gated too)` | same name |
| `GET /mdf/auth → 405` | same name |
| `paid POST /mdf/auth → token scoped to the paid section` | "a paid POST /mdf/auth mints a token scoped to the section, with PAYMENT-RESPONSE" |
| `a token does not authorise another section` | "the issued token serves its own section, and only its own section" |
| `the issued token serves its own section (end to end)` | same case |
| `a replayed (already settled) payment → 402, no token, no settle` | "a replayed payment mints no token and settles nothing" |
| `facilitator failure → 503, no token` | "a facilitator outage is a 503, not a payment denial" (content path) + the token path shares `verifyPayment` |
| `a per-fetch section → 400, no token, nothing settled` | same name |
| `missing resource → 400` | same name |
| `oversized body → 413` | same name |
| `client-asserted txHash/from in the body are ignored` | same name |
| `a token minted for one section cannot be forged for another by reusing the id` | "a wrong secret, or the same id with a short secret, is refused" |

## New in 0.3.0 (not replacements)

`payment.test.ts` (24) — the facade's order of operations, the lnbtc rejection
classes, replay-after-restart with a shared vs private store, and the
settlement-header payer rule. `router.test.ts` +8 — 402 header/body identity,
`X-PAYMENT` inertness, oversized `PAYMENT-SIGNATURE`, v1 payload refusal,
degraded-rail omission end to end, 503 + `Retry-After`, budget exhaustion,
unreachable token store. `health.test.ts` +4, `402-schema.test.ts` +6,
`loader.test.ts` +5.

## The two red tests

`402-schema.test.ts` fetched `mdf-402.schema.json` from spec **main** at test
time, so it compared a v1 body against a v2 schema and failed 2/2. It now
validates the real v2 body against a schema vendored from
`bitcryptic-gw/mdf@v0.3.1` (`31cd49c`), with the file's SHA-256 asserted in the
test. Both original intents are kept (`x402 body` → the eip155 case;
`lightning body` → the dual-rail case), and the suite no longer depends on the
network.
