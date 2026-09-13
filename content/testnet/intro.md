# MDF x402 Testnet Demo (Base Sepolia)

This content is gated by an x402 payment on **Base Sepolia**, the EVM testnet. It exists so the whole MDF x402 path — 402 offer, standard `X-PAYMENT` payload, facilitator `/verify` + `/settle` — can be exercised end-to-end with testnet USDC.

## What happens

1. An agent requests this path with `Accept: text/markdown` and receives a `402`.
2. The `payment` object in that 402 is a strict superset of x402's `PaymentRequirements` — `pay_to`, `asset`, `scheme`, `max_timeout_seconds` and `extra` alongside MDF's own `amount`, `currency`, `chain`, `rail` and `expires_at`.
3. The agent signs an EIP-3009 `TransferWithAuthorization`, base64-encodes the x402 `PaymentPayload`, and sends it in the standard `X-PAYMENT` header.
4. The server builds `PaymentRequirements` from the offer it issued and calls a standard x402 facilitator's `/verify` then `/settle` endpoints.
5. On successful settlement the Markdown you are reading is returned.

Because this is a testnet, the funds are worthless — which makes it the right place to prove the integration before mainnet value is at stake.
