import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const HttpsUri = z
  .string()
  .url()
  .refine((v) => v.startsWith("https://"), "must use https://");

const EndpointUri = z
  .string()
  .refine(
    (v) => v.startsWith("https://") || v.startsWith("/"),
    "must be an absolute https:// URL or a root-relative path starting with /"
  );

/** Atomic integer amount: no sign, decimal point, exponent or separator. */
const AtomicAmount = z
  .string()
  .regex(/^[1-9][0-9]*$/, "must be a positive atomic integer string, e.g. '10000'");

/** CAIP-2 network identifier. */
const Caip2 = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "must be a CAIP-2 network identifier");

/** A single IP literal (v4 or v6), for the trusted-proxy list. */
const IpLiteral = z
  .string()
  .min(2)
  .max(45)
  .refine((v) => /^[0-9a-fA-F:.]+$/.test(v.replace(/^\[|\]$/g, "")), "must be an IP literal, not a hostname");

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const RailSchema = z.object({
  scheme: z.literal("exact"),
  network: Caip2,
  asset: z.string().min(1).max(128),
  amount: AtomicAmount,
});

const PriceEntrySchema = z
  .object({
    rails: z.array(RailSchema).default([]),
    access: z.enum(["per_fetch", "token"]).default("per_fetch"),
  })
  .strict();

const PricingSchema = z.object({
  default: PriceEntrySchema,
  sections: z.record(z.string(), PriceEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

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

const AuthSchema = z.object({
  endpoint: EndpointUri,
  token_ttl_seconds: z.number().int().min(60).default(86400),
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

/**
 * Valkey, shared by the replay store and (when configured) the token store.
 *
 * The password is resolved from `/run/secrets/valkey_password`; it is never a
 * config value, an env var or an argv entry.
 */
const ValkeySchema = z.object({
  url: z
    .string()
    .url()
    .refine((v) => v.startsWith("redis://") || v.startsWith("rediss://"), "must be redis:// or rediss://"),
  connect_timeout_ms: z.number().int().min(100).max(30000).default(2000),
  command_timeout_ms: z.number().int().min(100).max(30000).default(2000),
});

const LightningSchema = z
  .object({
    /** Off means no NWC connection is read and no lnbtc rail is declared. */
    enabled: z.boolean().default(false),
    /** Concrete lnbtc network. */
    network: Caip2.default("lnbtc:000000000019d6689c085ae165831e93"),
    /**
     * Receiver node pubkey (accepts[].payTo for the lnbtc rail). Optional: when
     * omitted it is read from `get_info` at startup, and the lnbtc rail stays
     * unavailable until it is known.
     */
    node_pubkey: z
      .string()
      .regex(/^(02|03)[0-9a-f]{64}$/, "must be a compressed secp256k1 pubkey (66 lowercase hex)")
      .optional(),
    mint: z
      .object({
        global_per_minute: z.number().int().min(1).max(100000).default(180),
        global_burst: z.number().int().min(1).max(100000).default(60),
        per_client_per_minute: z.number().int().min(1).max(100000).default(24),
        per_client_burst: z.number().int().min(1).max(100000).default(8),
      })
      .default({}),
    nwc: z
      .object({
        connect_timeout_ms: z.number().int().min(500).max(60000).default(5000),
        response_timeout_ms: z.number().int().min(500).max(120000).default(10000),
      })
      .default({}),
    breaker_initial_backoff_seconds: z.number().int().min(1).max(3600).default(5),
    breaker_max_backoff_seconds: z.number().int().min(1).max(86400).default(300),
  })
  .strict();

const FacilitatorSchema = z
  .object({
    /** Ordered v2 legs. The first that answers serves the whole request. */
    legs: z.array(z.string().url()).min(1),
    timeout_ms: z.number().int().min(500).max(60000).default(15000),
    /** JSON-RPC per CAIP-2 network, used by the on-chain confirmations. */
    rpc: z.record(z.string(), z.string().url()).default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const MdfConfigSchema = z
  .object({
    site: SiteSchema,
    content: ContentSchema.default({}),
    pricing: PricingSchema,
    auth: AuthSchema.optional(),
    /**
     * Explicit, with no default: a silent "memory" would reintroduce tokens that
     * only work on the instance that minted them.
     */
    token_store: z.enum(["valkey", "memory"]),
    valkey: ValkeySchema.optional(),
    server: z
      .object({
        trusted_proxies: z.array(IpLiteral).default([]),
      })
      .default({}),
    signals: SignalsSchema.default({}),
    feed: FeedSchema.optional(),
    dashboard: DashboardSchema.default({}),
    payment: z
      .object({
        /** Offer window for every rail; on lnbtc it is also the invoice expiry. */
        max_timeout_seconds: z.number().int().min(1).max(86400).default(300),
      })
      .default({}),
    lightning: LightningSchema.optional(),
    facilitator: FacilitatorSchema.optional(),
  })
  .strict();

export type MdfConfig = z.infer<typeof MdfConfigSchema>;
export type PriceEntry = z.infer<typeof PriceEntrySchema>;
export type RailConfigInput = z.infer<typeof RailSchema>;
export type LightningConfig = z.infer<typeof LightningSchema>;
export type FacilitatorConfigInput = z.infer<typeof FacilitatorSchema>;
export type ValkeyConfig = z.infer<typeof ValkeySchema>;
