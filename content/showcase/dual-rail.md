---
title: Dual-Rail Showcase
---

# Dual-Rail Showcase

This page is priced on **two rails at once**: Base mainnet USDC over x402, or a
Lightning invoice denominated in satoshis. Either payment buys exactly this
document — no exchange rate links the two prices, and no rail is a fallback for
the other.

## Why two rails

An agent holding a funded EVM wallet should not have to open a Lightning
channel, and a human with a Lightning wallet should not have to bridge to Base.
MDF treats access as a set of payment options for one resource:

- every rail the publisher configured appears in the 402's `accepts[]`;
- a rail that cannot be settled *right now* — an open Lightning circuit
  breaker, an exhausted invoice-mint budget, an unreachable replay store — is
  omitted, and the remaining rails are unaffected;
- `/mdf.json` keeps declaring both, because it describes what the site sells,
  not what it can settle this second.

## What to look for

Request this page with no payment and read the 402:

```
accepts[0]  exact / eip155:8453    20000 atomic (0.02 USDC)  payTo = wallet
accepts[1]  exact / lnbtc:0000…93  20000 msat  (20 sat)      payTo = node pubkey
```

The `PAYMENT-REQUIRED` header is the base64 of the body you just read: one
object, two transport encodings. Pay with either rail and the 200 carries a
`PAYMENT-RESPONSE` naming the settlement (a transaction hash for USDC, the
payment hash for Lightning — and, for Lightning, no `payer`, because the
protocol reveals none).
