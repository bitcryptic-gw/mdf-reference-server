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
  api_token: z.string().min(1),
  invoice_expiry_seconds: z.number().int().min(60).default(300),
  token_secret: z.string().min(32),
});

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
});

export type MdfConfig = z.infer<typeof MdfConfigSchema>;
export type PriceEntry = z.infer<typeof PriceEntry>;
export type LightningConfig = z.infer<typeof LightningSchema>;
