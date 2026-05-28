/**
 * events.ts — persistent feed event log
 *
 * Events are stored as newline-delimited JSON (NDJSON) at DATA_DIR/feed-events.ndjson.
 * Each line is a FeedEvent object. Append-only — never mutate existing entries.
 *
 * DATA_DIR is resolved from:
 *   1. MDF_DATA_DIR env var
 *   2. /app/data (container default)
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeType =
  | "content_update"
  | "new_page"
  | "retraction"
  | "pricing_change"
  | "signal_change"
  | "mdf_capability";

export interface FeedEvent {
  /** UUID v4 — stable identifier for this event, used as Atom entry id */
  id: string;
  /** ISO 8601 timestamp */
  ts: string;
  /** MDF change type */
  change_type: ChangeType;
  /** URL path this event relates to, e.g. /docs/getting-started */
  path: string;
  /** Human-readable summary for the Atom entry title */
  summary: string;
  /** Optional additional detail */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function resolveDataDir(): string {
  return process.env.MDF_DATA_DIR ?? "/app/data";
}

function eventsPath(): string {
  return join(resolveDataDir(), "feed-events.ndjson");
}

/**
 * Ensure the data directory exists. Called once at startup.
 */
export function ensureDataDir(): void {
  const dir = resolveDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a single event to the log. Atomic at the line level — each
 * appendFileSync call writes a complete JSON line.
 */
export function appendEvent(event: FeedEvent): void {
  const line = JSON.stringify(event) + "\n";
  appendFileSync(eventsPath(), line, "utf8");
}

/**
 * Read all events from the log, newest first.
 * Returns empty array if the log does not exist yet.
 * Skips malformed lines silently — log should never have them, but
 * we don't want a single corrupt line to break the feed.
 */
export function readEvents(limit = 100): FeedEvent[] {
  const path = eventsPath();
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const events: FeedEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as FeedEvent;
      events.push(event);
    } catch {
      // Skip malformed line
    }
  }

  // Newest first, capped at limit
  return events.reverse().slice(0, limit);
}

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

export function createEvent(
  change_type: ChangeType,
  path: string,
  summary: string,
  detail?: string
): FeedEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    change_type,
    path,
    summary,
    detail,
  };
}

/**
 * Emit and persist an event in one call.
 */
export function emitEvent(
  change_type: ChangeType,
  path: string,
  summary: string,
  detail?: string
): FeedEvent {
  const event = createEvent(change_type, path, summary, detail);
  appendEvent(event);
  console.log(JSON.stringify({ ts: event.ts, event: "feed_event", change_type, path, id: event.id }));
  return event;
}
