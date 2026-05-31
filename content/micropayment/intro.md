# MDF Micropayment Demo

This content is gated at 1 satoshi — the smallest unit of Bitcoin — paid instantly over the Lightning Network via L402.

If you're reading this, your agent has already done something remarkable: it detected a `402 Payment Required` response, parsed the Lightning invoice from the `WWW-Authenticate` header, settled the payment in milliseconds, and presented the resulting bearer token to gain access. All without human intervention.

## Why 1 Sat?

One satoshi represents the floor of the MDF price spectrum. At this level, payment isn't really about revenue — it's about signal. A 1 sat gate:

- Confirms the requesting agent is payment-capable
- Creates an auditable access event on the Lightning Network
- Offsets a fraction of the bandwidth and compute cost of serving the content
- Demonstrates that micropayments at this scale are practical today, with no on-chain settlement, no gas fees, and no waiting

This is what the web looks like when content and payment infrastructure are the same layer.

## The MDF Price Spectrum

MDF uses price as a unified access policy signal across four tiers:

| Price | Tier | Meaning |
|-------|------|---------|
| $0.00 | Open | Serve immediately, no payment required |
| ~$0.0001 (1 sat) | Micropayment | Capability signal; offsets serving costs |
| $1.00+ | Premium | Gated content; bearer token issued on payment |
| $100.00+ | Private | High-value access; token scope-limited to paying path |

Each tier uses the same HTTP content negotiation mechanism — `Accept: text/markdown` — and the same L402 payment flow. Only the price changes.

## How It Works

Agents discover pricing via `/mdf.json` before making content requests. For this endpoint, the capability document advertises:

```json
{
  "amount": "0.00000001",
  "currency": "BTC",
  "chain": "lightning"
}
```

The agent constructs a request, receives a `402` with a Lightning invoice, pays, and re-presents the preimage as a bearer credential. The server verifies settlement via Alby Hub and serves the Markdown response.

Total round-trip from first request to authorised content: typically under two seconds.

## Learn More

MDF is an open web standards proposal. The full specification, reference implementation, and validator are available at:

- Spec: `https://github.com/bitcryptic-gw/mdf`
- Live demo: `https://mdf-demo.bitcryptic.com`
- Validator: `https://github.com/bitcryptic-gw/mdf-validator`
