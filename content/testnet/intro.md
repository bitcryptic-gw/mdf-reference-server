# MDF x402 Testnet Demo (Base Sepolia)

This content is gated by an x402 payment on **Base Sepolia**, the EVM testnet. It exists so the whole MDF x402 path — 402 offer, `PAYMENT-SIGNATURE` payload, facilitator `/verify` + `/settle` — can be exercised end-to-end with testnet USDC.

## What happens

1. An agent requests this path with `Accept: text/markdown` and receives a `402`.
2. That `402` is an x402 v2 `PaymentRequired`: the `accepts[]` entry is a standard x402 `PaymentRequirements` (`scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, `extra`), and MDF's own fields sit alongside it under `extensions.mdf` — `version`, a human-readable `price_summary`, and `source_bytes`.
3. The agent signs an EIP-3009 `TransferWithAuthorization`, base64-encodes the x402 v2 `PaymentPayload`, and sends it in the standard `PAYMENT-SIGNATURE` header.
4. The server builds `PaymentRequirements` from the offer it issued and calls a standard x402 facilitator's `/verify` then `/settle` endpoints.
5. On successful settlement the Markdown you are reading is returned.

Because this is a testnet, the funds are worthless — which makes it the right place to prove the integration before mainnet value is at stake.
