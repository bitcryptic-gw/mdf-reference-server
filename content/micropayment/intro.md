# MDF Micropayment Demo

This content is gated at 1 satoshi — the smallest unit of Bitcoin — paid instantly over the Lightning Network.

If you're reading this, your agent has already done something remarkable: it detected a `402 Payment Required` response, read the Lightning rail and its BOLT11 invoice out of the `PAYMENT-REQUIRED` header, settled the payment in milliseconds, and presented the preimage to gain access. All without human intervention.

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
| ~$0.001 (1 sat) | Micropayment | Capability signal; offsets serving costs |
| $0.01+ | Premium | Gated content; paid directly per request, no token issued |
| $0.10+ | Private | High-value access; token scope-limited to paying path |

Each tier uses the same HTTP content negotiation mechanism — `Accept: text/markdown`. Every priced tier answers with a `402` whose payment request is x402 v2: the 1-sat tier is the Lightning rail (`exact` on `lnbtc`), and the USDC tiers are the Base rail (`exact` on `eip155:8453`). Only the price and the rail change.

## How It Works

Agents discover pricing via `/mdf.json` before making content requests. For this endpoint, the site advertises this entry in `accepts[]`:

```json
{
  "scheme": "exact",
  "network": "lnbtc:000000000019d6689c085ae165831e93",
  "asset": "BTC",
  "amount": "1000"
}
```

That `amount` is millisatoshis: 1000 msat, one satoshi. The `402` for this page carries the same entry plus a freshly minted BOLT11 invoice under `extra.invoice` — a new invoice on every request, valid for five minutes.

The agent pays the invoice, then sends the preimage back in a `PAYMENT-SIGNATURE` header. The server checks the preimage against the invoice's own payment hash, refuses one it has already accepted, and serves the Markdown response.

Total round-trip from first request to authorised content: typically under two seconds.

## Learn More

MDF is an open web standards proposal. The full specification, reference implementation, and validator are available at:

- Spec: `https://github.com/bitcryptic-gw/mdf`
- Live demo: `https://mdf-demo.bitcryptic.com`
- Validator: `https://github.com/bitcryptic-gw/mdf-validator`
