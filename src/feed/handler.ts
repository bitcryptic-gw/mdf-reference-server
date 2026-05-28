/**
 * handler.ts — serve /feed.xml as an Atom 1.0 feed with mdf: namespace extension
 *
 * Namespace URI: https://github.com/bitcryptic-gw/mdf/ns/1.0
 *
 * Each Atom entry carries:
 *   <mdf:change_type>content_update</mdf:change_type>
 *
 * The feed also declares the WebSub hub link if configured.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { readEvents } from "./events.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MDF_NS = "https://github.com/bitcryptic-gw/mdf/ns/1.0";
const ATOM_NS = "http://www.w3.org/2005/Atom";

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Atom feed builder
// ---------------------------------------------------------------------------

function buildAtomFeed(loaded: LoadedConfig): string {
  const { config } = loaded;
  const siteUrl = config.site.url.replace(/\/$/, "");
  const siteName = config.site.name ?? siteUrl;
  const feedUrl = `${siteUrl}/feed.xml`;
  const selfUrl = feedUrl;

  const events = readEvents(50);

  // Feed updated timestamp — most recent event, or now if no events
  const updatedTs =
    events.length > 0 ? events[0].ts : new Date().toISOString();

  const lines: string[] = [];

  // XML declaration + root element with namespaces
  lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
  lines.push(`<feed`);
  lines.push(`  xmlns="${ATOM_NS}"`);
  lines.push(`  xmlns:mdf="${MDF_NS}">`);
  lines.push(``);

  // Feed metadata
  lines.push(`  <id>${escapeXml(siteUrl)}/</id>`);
  lines.push(`  <title>${escapeXml(siteName)}</title>`);
  lines.push(`  <updated>${updatedTs}</updated>`);
  lines.push(`  <link rel="self" href="${escapeXml(selfUrl)}" type="application/atom+xml"/>`);
  lines.push(`  <link rel="alternate" href="${escapeXml(siteUrl)}/" type="text/html"/>`);

  // WebSub hub
  if (config.feed?.websub_hub) {
    lines.push(`  <link rel="hub" href="${escapeXml(config.feed.websub_hub)}"/>`);
  }

  // Generator
  lines.push(`  <generator uri="https://github.com/bitcryptic-gw/mdf-reference-server">mdf-server</generator>`);

  if (config.site.contact) {
    lines.push(`  <author><name>${escapeXml(siteName)}</name><email>${escapeXml(config.site.contact)}</email></author>`);
  }

  lines.push(``);

  // Entries
  for (const event of events) {
    const entryUrl = `${siteUrl}${event.path === "/" ? "" : event.path}`;
    const atomId = `urn:uuid:${event.id}`;

    lines.push(`  <entry>`);
    lines.push(`    <id>${escapeXml(atomId)}</id>`);
    lines.push(`    <title>${escapeXml(event.summary)}</title>`);
    lines.push(`    <updated>${event.ts}</updated>`);
    lines.push(`    <link rel="alternate" href="${escapeXml(entryUrl)}"/>`);
    lines.push(`    <mdf:change_type>${escapeXml(event.change_type)}</mdf:change_type>`);

    if (event.detail) {
      lines.push(`    <summary>${escapeXml(event.detail)}</summary>`);
    }

    lines.push(`  </entry>`);
    lines.push(``);
  }

  lines.push(`</feed>`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface FeedResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function serveFeed(
  urlPath: string,
  loaded: LoadedConfig
): FeedResult | null {
  const path = urlPath.split("?")[0];

  // Only handle the configured feed URL, defaulting to /feed.xml
  const feedPath = loaded.config.feed?.url ?? "/feed.xml";
  // feedPath may be absolute (https://...) or root-relative (/feed.xml)
  const normalised = feedPath.startsWith("https://")
    ? new URL(feedPath).pathname
    : feedPath;

  if (path !== normalised) return null;

  if (!loaded.config.feed) {
    return {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Feed not configured on this server.",
    };
  }

  const body = buildAtomFeed(loaded);

  return {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "max-age=60",
      "X-MDF-Version": "1",
    },
    body,
  };
}
