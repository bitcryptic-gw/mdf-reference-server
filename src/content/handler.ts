import { existsSync, readFileSync, statSync } from "fs";
import { join, extname, normalize } from "path";
import { createHash } from "crypto";
import { marked } from "marked";
import matter from "gray-matter";
import { prefersMarkdown } from "./accept.ts";
import { estimateTokens } from "./tokens.ts";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a URL path to an absolute filesystem path within contentDir.
 * Handles: /foo → /foo.md, /foo/ → /foo/index.md, /foo.md → /foo.md
 *
 * Returns null if the path resolves outside contentDir (traversal attempt)
 * or if no matching file exists.
 */
function resolveContentPath(
  urlPath: string,
  contentDir: string
): string | null {
  // Strip query string and fragment if present
  const cleanPath = urlPath.split("?")[0].split("#")[0];

  // Normalise and strip leading slash
  const relative = normalize(cleanPath).replace(/^\/+/, "");

  // Candidate paths in preference order
  const candidates: string[] = [];

  if (extname(relative) === ".md") {
    candidates.push(join(contentDir, relative));
  } else if (relative === "" || relative.endsWith("/")) {
    candidates.push(join(contentDir, relative, "index.md"));
  } else {
    candidates.push(join(contentDir, `${relative}.md`));
    candidates.push(join(contentDir, relative, "index.md"));
  }

  for (const candidate of candidates) {
    // Traversal guard — resolved path must remain inside contentDir
    const resolved = normalize(candidate);
    if (!resolved.startsWith(normalize(contentDir) + "/") && resolved !== normalize(contentDir)) {
      continue;
    }
    if (existsSync(resolved)) return resolved;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pricing lookup
// ---------------------------------------------------------------------------

/**
 * Find the most specific price entry for a given URL path.
 * Glob matching: ** matches across segments, * matches within a segment.
 */
function priceForPath(
  urlPath: string,
  config: LoadedConfig["config"]
): { amount: string; currency: string | null | undefined; chain: string | null | undefined } {
  const sections = config.pricing.sections ?? {};

  // Convert glob pattern to regex
  function globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§DOUBLE§")
      .replace(/\*/g, "[^/]+")
      .replace(/§DOUBLE§/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  // Find the most specific matching section — longer pattern = more specific
  let bestPattern: string | null = null;
  let bestLength = -1;

  for (const pattern of Object.keys(sections)) {
    const regex = globToRegex(pattern);
    if (regex.test(urlPath)) {
      if (pattern.length > bestLength) {
        bestPattern = pattern;
        bestLength = pattern.length;
      }
    }
  }

  if (bestPattern) return sections[bestPattern];
  return config.pricing.default;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const HTML_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 800px; margin: 0 auto; padding: 2rem 1rem; font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; }
  pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; border-radius: 4px; }
  code { font-family: ui-monospace, monospace; font-size: 0.9em; }
  img { max-width: 100%; }
  a { color: #0066cc; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// ETag generation
// ---------------------------------------------------------------------------

function computeEtag(content: string): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

// ---------------------------------------------------------------------------
// MDF response headers
// ---------------------------------------------------------------------------

function mdfHeaders(
  urlPath: string,
  markdownContent: string,
  config: LoadedConfig["config"]
): Record<string, string> {
  const price = priceForPath(urlPath, config);
  const tokens = estimateTokens(markdownContent);

  const headers: Record<string, string> = {
    "X-MDF-Version": "1",
    "X-MDF-Tokens": String(tokens),
  };

  if (parseFloat(price.amount) > 0 && price.currency) {
    headers["X-MDF-Price"] = price.amount;
    headers["X-MDF-Currency"] = price.currency;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// 404 response
// ---------------------------------------------------------------------------

function notFound(urlPath: string, wantsMarkdown: boolean): ServeResult {
  if (wantsMarkdown) {
    return {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: `# 404 Not Found\n\nNo content found at \`${urlPath}\`.\n`,
    };
  }
  return {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: HTML_TEMPLATE("404 Not Found", `<h1>404 Not Found</h1><p>No content found at <code>${escapeHtml(urlPath)}</code>.</p>`),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Serve a content request.
 *
 * @param urlPath   - The request path, e.g. "/docs/getting-started"
 * @param acceptHeader - The raw Accept header value from the request
 * @param ifNoneMatch  - The If-None-Match header value (for ETag caching)
 * @param loaded    - The loaded server config
 */
export function serveContent(
  urlPath: string,
  acceptHeader: string | null | undefined,
  ifNoneMatch: string | null | undefined,
  loaded: LoadedConfig
): ServeResult {
  const { config, contentDir } = loaded;
  const wantsMarkdown = prefersMarkdown(acceptHeader);

  // Resolve file
  const filePath = resolveContentPath(urlPath, contentDir);
  if (!filePath) return notFound(urlPath, wantsMarkdown);

  // Read file
  let rawContent: string;
  try {
    rawContent = readFileSync(filePath, "utf8");
  } catch {
    return notFound(urlPath, wantsMarkdown);
  }

  // Parse frontmatter
  const { content: markdownBody, data: frontmatter } = matter(rawContent);

  // Determine title — frontmatter.title, first H1, or filename
  const title: string =
    frontmatter.title ??
    (markdownBody.match(/^#\s+(.+)$/m)?.[1] ?? urlPath.split("/").pop() ?? "Untitled");

  // ETag from raw file content (frontmatter included)
  const etag = computeEtag(rawContent);

  // Conditional GET — 304 Not Modified
  if (ifNoneMatch && ifNoneMatch === etag) {
    return {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "no-cache",
      },
      body: "",
    };
  }

  // Determine what markdown content to serve
  // If frontmatter is enabled in config, include it in the markdown response;
  // strip it for HTML (it's already parsed).
  const markdownForResponse = config.content.frontmatter ? rawContent : markdownBody;
  const mdfHdrs = mdfHeaders(urlPath, markdownBody, config);

  const baseHeaders: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "no-cache",
    "Last-Modified": new Date(statSync(filePath).mtimeMs).toUTCString(),
    ...mdfHdrs,
  };

  if (wantsMarkdown) {
    return {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: markdownForResponse,
    };
  }

  // Render HTML
  const htmlBody = marked.parse(markdownBody) as string;
  const html = HTML_TEMPLATE(title, htmlBody);

  return {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: html,
  };
}
