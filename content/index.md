---
title: MDF Demo Site
---

# Welcome to MDF Demo

This site runs the MDF (Markdown First) reference server, spec 0.3.1. The same URL gives people the normal web page and gives agents the markdown, when they ask with `Accept: text/markdown`.

Some sections are priced. For those the server answers with an HTTP 402 and an x402 payment request; the agent pays, and the content comes back. Each section sets its own price for each payment method.

## Sections

- [Documentation](/docs/getting-started) — free access
- [Micropayment sample](/micropayment/intro) — 1 sat over Lightning
- [Premium content](/premium/deep-dive) — 0.01 USDC on Base, per fetch
- [Either payment method](/showcase/dual-rail) — 0.02 USDC on Base **or** 20 sat over Lightning; the agent picks
- [Private internals](/private/internals) — 0.10 USDC on Base, which buys a 24-hour access token instead of paying on every fetch
- [Testnet](/testnet/intro) — 0.001 USDC on Base Sepolia, for testing without real money

Payments are real: Lightning and Base mainnet settle on the live networks. Every price above is also machine-readable in [`/mdf.json`](/mdf.json).

[What is MDF?](https://markdownfirst.com) · [Spec, reference implementation and validator](https://github.com/bitcryptic-gw/mdf)
