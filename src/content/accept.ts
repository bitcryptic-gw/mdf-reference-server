/**
 * RFC 7231 Accept header parsing.
 *
 * Parses "text/markdown, text/html;q=0.9, *\/*;q=0.8" into a sorted list
 * of accepted media types with their quality values.
 */

export interface AcceptEntry {
  type: string;    // e.g. "text/markdown"
  q: number;       // 0.0–1.0, default 1.0
}

/**
 * Parse an Accept header value into a quality-sorted list.
 * Higher q = more preferred. Entries with equal q retain their original order.
 */
export function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header || header.trim().length === 0) return [];

  const entries: AcceptEntry[] = [];

  for (const part of header.split(",")) {
    const segments = part.trim().split(";");
    const type = segments[0].trim().toLowerCase();
    if (!type) continue;

    let q = 1.0;
    for (let i = 1; i < segments.length; i++) {
      const param = segments[i].trim();
      if (param.startsWith("q=")) {
        const parsed = parseFloat(param.slice(2));
        if (!isNaN(parsed)) q = Math.min(1.0, Math.max(0.0, parsed));
      }
    }

    entries.push({ type, q });
  }

  // Stable sort — higher q first
  return entries.sort((a, b) => b.q - a.q);
}

/**
 * Returns true if the Accept header indicates a preference for markdown
 * over HTML (or accepts markdown and does not accept HTML at all).
 *
 * An explicit q=0 for text/markdown means "not acceptable" — returns false.
 */
export function prefersMarkdown(header: string | null | undefined): boolean {
  const entries = parseAccept(header);
  if (entries.length === 0) return false;

  let markdownQ = -1;
  let htmlQ = -1;

  for (const e of entries) {
    if (e.type === "text/markdown" && markdownQ === -1) markdownQ = e.q;
    if ((e.type === "text/html" || e.type === "*/*" || e.type === "text/*") && htmlQ === -1) {
      htmlQ = e.q;
    }
  }

  // Explicitly excluded
  if (markdownQ === 0) return false;
  // Accepts markdown at all
  if (markdownQ > 0) return markdownQ >= htmlQ;

  return false;
}
