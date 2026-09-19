import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const DecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a decimal string e.g. '0.0001'");

const HttpsUri = z
  .string()
  .url()
  .refine((v) => v.startsWith("https://"), "must use https://");

// A URL that is either absolute (https://) or a root-relative path (/foo)
const EndpointUri = z
  .string()
  .refine(
    (v) => v.startsWith("https://") || v.startsWith("/"),
    "must be an absolute https:// URL or a root-relative path starting with /"
  );

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const PriceEntry = z.object({
  amount: DecimalString,
  currency: z.string().nullable().optional(),
  chain: z.string().nullable().optional(),
});

const SiteSchema = z.object({
  url: HttpsUri,
  name: z.string().min(1).optional(),
  contact: z.string().optional(),
});

const ContentSchema = z.object({
  dir: z.string().min(1).default("./content"),
  dialect: z.enum(["commonmark", "gfm", "pandoc", "other"]).default("commonmark"),
  frontmatter: z.boolean().default(false),
  math: z.boolean().default(false),
});

const PricingSchema = z.object({
  default: PriceEntry,
  sections: z.record(z.string(), PriceEntry).optional(),
});

const PaymentSchema = z.object({
  endpoint: EndpointUri,
  accepted_chains: z.array(z.string()).min(1),
  accepted_currencies: z.array(z.string()).min(1),
  // wallet is optional here — may be supplied via secret
  wallet: z.string().optional(),
});

const AuthSchema = z.object({
  endpoint: EndpointUri,
  token_ttl_seconds: z.number().int().min(60).default(86400),
  price_threshold: DecimalString,
});

const SignalsSchema = z.object({
  ai_train: z.boolean().default(false),
  ai_input: z.boolean().default(true),
  search: z.boolean().default(true),
  human_only: z.boolean().default(false),
});

const FeedSchema = z.object({
  url: EndpointUri,
  format: z.enum(["rss2", "atom"]).default("atom"),
  websub_hub: z.string().url().optional(),
  change_types: z
    .array(
      z.enum([
        "content_update",
        "new_page",
        "retraction",
        "pricing_change",
        "signal_change",
        "mdf_capability",
      ])
    )
    .optional(),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535).default(9090),
});

// ---------------------------------------------------------------------------
// Root config schema
// ---------------------------------------------------------------------------

const LightningSchema = z.object({
  api_url: z.string().url(),
  // api_token / token_secret are optional and inert: when present they are
  // never read or logged. loader.ts resolves both from a mounted secret file
  // or env var and throws if they cannot be resolved (Vikunja #27).
  api_token: z.string().optional(),
  invoice_expiry_seconds: z.number().int().min(60).default(300),
  token_secret: z.string().optional(),
});

/**
 * Per-chain data needed to build standard x402 `PaymentRequirements` and to
 * confirm settlement on-chain independently of the facilitator's report.
 */
export const FacilitatorChainSchema = z.object({
  /** ERC-20 token contract address for this chain, e.g. USDC. */
  asset: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte EVM address"),
  /** Token decimals, used to convert MDF amounts to atomic units. */
  decimals: z.number().int().min(0).max(36).default(6),
  /** Scheme-specific extra data passed through opaquely to the facilitator. */
  extra: z.record(z.string(), z.unknown()).optional(),
  /** JSON-RPC endpoint used for on-chain settlement confirmation. */
  rpc_url: z.string().url().optional(),
});

export const FacilitatorSchema = z.object({
  /** Base URL of a standard x402 facilitator exposing /verify and /settle. */
  url: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://"), "must use https://"),
  /** x402 scheme name (e.g. "exact"). */
  scheme: z.string().min(1).default("exact"),
  /** Offer validity window in seconds, shared by expires_at. */
  max_timeout_seconds: z.number().int().min(1).max(86400).default(300),
  /** Per-request HTTP timeout for facilitator calls. */
  timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  /** Per-MDF-chain asset metadata, keyed by the MDF chain name. */
  chains: z.record(z.string(), FacilitatorChainSchema).default({}),
}).optional();

export const MdfConfigSchema = z.object({
  site: SiteSchema,
  content: ContentSchema.default({}),
  pricing: PricingSchema,
  payment: PaymentSchema.optional(),
  auth: AuthSchema.optional(),
  signals: SignalsSchema.default({}),
  feed: FeedSchema.optional(),
  dashboard: DashboardSchema.default({}),
  lightning: LightningSchema.optional(),
  facilitator: FacilitatorSchema,
});

export type MdfConfig = z.infer<typeof MdfConfigSchema>;
export type PriceEntry = z.infer<typeof PriceEntry>;
export type LightningConfig = z.infer<typeof LightningSchema>;
export type FacilitatorConfig = NonNullable<z.infer<typeof FacilitatorSchema>>;
export type FacilitatorChainConfig = z.infer<typeof FacilitatorChainSchema>;
