/**
 * `/mdf.json` is rendered from **configuration**, never from runtime state.
 *
 * This is the "subtraction only" rule read in the direction that is easy to get
 * wrong: a rail that is degraded, breaker-open or rate-limited is still
 * *declared* here and only *omitted* from the 402's `accepts[]`. The document
 * describes what the site sells; the 402 describes what it can settle right now.
 * If this function could see runtime state, the two would disagree precisely when
 * something was wrong — the worst moment to be ambiguous.
 *
 * The one exception is a rail that is not configured at all: `lightning.enabled:
 * false` means the section's rails simply do not contain lnbtc, so it is not
 * declared either. That is a config decision, made before this function is
 * called, which is why this function takes only the configured rails.
 *
 * Deliberately structurally typed, so it cannot reach for a breaker, a gate, a
 * limiter or a clock.
 */

export interface MdfJsonRail {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
}

export interface MdfJsonPriceEntry {
  rails: MdfJsonRail[];
  access?: "per_fetch" | "token";
}

export interface MdfJsonInput {
  site: { url: string; name?: string; contact?: string };
  pricing: {
    default: MdfJsonPriceEntry;
    sections?: Record<string, MdfJsonPriceEntry>;
  };
  auth?: { endpoint: string; token_ttl_seconds?: number };
  signals: { ai_train: boolean; ai_input: boolean; search: boolean; human_only: boolean };
  formats: { dialect: string; frontmatter: boolean; math: boolean };
  feed?: { url: string; format: string; websub_hub?: string; change_types?: string[] };
  /** Specification version this document conforms to. */
  mdfVersion: string;
}

function renderEntry(entry: MdfJsonPriceEntry): Record<string, unknown> {
  return {
    rails: entry.rails.map((rail) => ({
      scheme: rail.scheme,
      network: rail.network,
      asset: rail.asset,
      amount: rail.amount,
    })),
    // `per_fetch` is the default, so it is omitted rather than restated.
    ...(entry.access === "token" ? { access: "token" } : {}),
  };
}

function resolveEndpoint(endpoint: string, siteUrl: string): string {
  if (endpoint.startsWith("https://")) return endpoint;
  return `${siteUrl.replace(/\/$/, "")}${endpoint}`;
}

export function buildMdfJson(input: MdfJsonInput): Record<string, unknown> {
  const siteUrl = input.site.url.replace(/\/$/, "");

  const pricing: Record<string, unknown> = { default: renderEntry(input.pricing.default) };
  if (input.pricing.sections && Object.keys(input.pricing.sections).length > 0) {
    pricing.sections = Object.fromEntries(
      Object.entries(input.pricing.sections).map(([pattern, entry]) => [
        pattern,
        renderEntry(entry),
      ])
    );
  }

  const doc: Record<string, unknown> = {
    mdf_version: input.mdfVersion,
    site: siteUrl,
  };
  if (input.site.name) doc.name = input.site.name;
  doc.pricing = pricing;

  if (input.auth) {
    doc.auth = {
      endpoint: resolveEndpoint(input.auth.endpoint, siteUrl),
      ...(input.auth.token_ttl_seconds !== undefined
        ? { token_ttl_seconds: input.auth.token_ttl_seconds }
        : {}),
    };
  }

  doc.content_signals = { ...input.signals };
  doc.formats = { ...input.formats };

  if (input.feed) {
    doc.feed = {
      url: resolveEndpoint(input.feed.url, siteUrl),
      format: input.feed.format,
      ...(input.feed.websub_hub ? { websub_hub: input.feed.websub_hub } : {}),
      ...(input.feed.change_types?.length ? { change_types: input.feed.change_types } : {}),
    };
  }
  if (input.site.contact) doc.contact = input.site.contact;

  // No `payment` object and no wallet: the authoritative recipient is
  // `accepts[].payTo` in the live offer (decision 19).
  return doc;
}
