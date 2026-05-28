import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import matter from "gray-matter";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentEntry {
  urlPath: string;
  title: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * Recursively walk contentDir and collect all .md files.
 * Returns entries sorted: index.md files first within each directory,
 * then alphabetically by path.
 */
function walkContent(contentDir: string): ContentEntry[] {
  const entries: ContentEntry[] = [];

  function walk(dir: string) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    // index.md first, then alphabetical
    names.sort((a, b) => {
      if (a === "index.md") return -1;
      if (b === "index.md") return 1;
      return a.localeCompare(b);
    });

    for (const name of names) {
      const fullPath = join(dir, name);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (extname(name) !== ".md") continue;

      // Derive URL path from filesystem path
      const rel = relative(contentDir, fullPath);
      let urlPath = "/" + rel.replace(/\\/g, "/");

      // /index.md → /,  /docs/index.md → /docs/
      if (name === "index.md") {
        urlPath = urlPath.slice(0, -"index.md".length) || "/";
      } else {
        // Strip .md extension
        urlPath = urlPath.slice(0, -3);
      }

      // Read frontmatter for title and description
      let title = urlPath;
      let description: string | undefined;
      try {
        const raw = readFileSync(fullPath, "utf8");
        const { content, data } = matter(raw);
        title = data.title ?? extractFirstHeading(content) ?? urlPath;
        description = data.description ?? extractFirstParagraph(content);
      } catch {
        // Leave defaults
      }

      entries.push({ urlPath, title, description });
    }
  }

  walk(contentDir);
  return entries;
}

// ---------------------------------------------------------------------------
// Markdown extraction helpers
// ---------------------------------------------------------------------------

function extractFirstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractFirstParagraph(markdown: string): string | undefined {
  // Skip headings and blank lines, return first non-empty non-heading line
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
      // Truncate long descriptions
      return trimmed.length > 120 ? trimmed.slice(0, 117) + "…" : trimmed;
    }
  }
}

// ---------------------------------------------------------------------------
// llms.txt generation
// ---------------------------------------------------------------------------

/**
 * Generate a well-formed llms.txt index from the content directory.
 *
 * Format follows the llms.txt spec (llmstxt.org):
 *   # Site Name
 *   > Optional site description
 *
 *   ## Section
 *   - [Title](URL): description
 */
export function generateLlmsTxt(loaded: LoadedConfig): string {
  const { config, contentDir } = loaded;
  const siteUrl = config.site.url.replace(/\/$/, "");
  const siteName = config.site.name ?? siteUrl;

  const entries = walkContent(contentDir);
  if (entries.length === 0) {
    return `# ${siteName}\n\n> No content available.\n`;
  }

  const lines: string[] = [];

  // Header
  lines.push(`# ${siteName}`);
  lines.push("");
  lines.push(`> This site serves markdown natively via HTTP content negotiation (Accept: text/markdown).`);
  lines.push(`> Capability document: ${siteUrl}/mdf.json`);
  lines.push("");

  // Group entries by top-level section
  const sections = new Map<string, ContentEntry[]>();

  for (const entry of entries) {
    const parts = entry.urlPath.split("/").filter(Boolean);
    const section = parts.length === 0 ? "" : parts[0];
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(entry);
  }

  // Root entries (no section)
  const rootEntries = sections.get("") ?? [];
  if (rootEntries.length > 0) {
    lines.push("## Pages");
    for (const e of rootEntries) {
      const url = `${siteUrl}${e.urlPath === "/" ? "" : e.urlPath}`;
      const desc = e.description ? `: ${e.description}` : "";
      lines.push(`- [${e.title}](${url})${desc}`);
    }
    lines.push("");
  }

  // Sectioned entries
  for (const [section, sectionEntries] of sections) {
    if (section === "") continue;
    const sectionTitle = section.charAt(0).toUpperCase() + section.slice(1);
    lines.push(`## ${sectionTitle}`);
    for (const e of sectionEntries) {
      const url = `${siteUrl}${e.urlPath}`;
      const desc = e.description ? `: ${e.description}` : "";
      lines.push(`- [${e.title}](${url})${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Discovery handler
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Handle requests for /mdf.json and /llms.txt.
 * Returns null if the path is not a discovery endpoint.
 */
export function serveDiscovery(
  urlPath: string,
  loaded: LoadedConfig
): DiscoveryResult | null {
  const path = urlPath.split("?")[0];

  if (path === "/mdf.json") {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "max-age=300",  // 5 min — agents shouldn't hammer this
        "X-MDF-Version": "1",
      },
      body: loaded.mdfJson,
    };
  }

  if (path === "/llms.txt") {
    const body = generateLlmsTxt(loaded);
    return {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "max-age=300",
        "X-MDF-Version": "1",
      },
      body,
    };
  }

  return null;
}
