/**
 * watcher.ts — detect content and config changes, emit feed events
 *
 * Uses a polling approach (hash manifest comparison) rather than inotify/Bun.watch.
 * This avoids Bun.watch instability on Linux and works identically in Docker.
 *
 * Poll interval: MDF_WATCH_INTERVAL_MS env var, default 30000 (30s).
 *
 * On first run at startup, does NOT emit events for all existing files —
 * instead it builds the initial manifest silently. This prevents a flood of
 * new_page events on every container restart.
 *
 * The startup mdf_capability event is emitted separately by index.ts.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, extname, relative } from "path";
import { createHash } from "crypto";
import { emitEvent } from "./events.ts";
import type { LoadedConfig } from "../config/loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of absolute file path → SHA-256 hex digest */
type FileManifest = Map<string, string>;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

function walkMarkdown(dir: string): string[] {
  const paths: string[] = [];

  function walk(current: string) {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (extname(name) === ".md") {
          paths.push(full);
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }

  walk(dir);
  return paths;
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

function buildManifest(contentDir: string): FileManifest {
  const manifest: FileManifest = new Map();
  for (const path of walkMarkdown(contentDir)) {
    const hash = hashFile(path);
    if (hash !== null) manifest.set(path, hash);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Path → URL
// ---------------------------------------------------------------------------

function filePathToUrlPath(absPath: string, contentDir: string): string {
  const rel = relative(contentDir, absPath).replace(/\\/g, "/");
  if (rel === "index.md") return "/";
  if (rel.endsWith("/index.md")) return "/" + rel.slice(0, -"/index.md".length) + "/";
  if (rel.endsWith(".md")) return "/" + rel.slice(0, -3);
  return "/" + rel;
}

// ---------------------------------------------------------------------------
// Config hash (detect pricing/signal changes)
// ---------------------------------------------------------------------------

function hashConfig(loaded: LoadedConfig): string {
  // Hash only the parts that produce feed events — pricing and signals
  const relevant = {
    pricing: loaded.config.pricing,
    signals: loaded.config.signals,
  };
  return createHash("sha256")
    .update(JSON.stringify(relevant))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

interface WatcherState {
  contentManifest: FileManifest;
  configHash: string;
  timer: ReturnType<typeof setInterval> | null;
}

const state: WatcherState = {
  contentManifest: new Map(),
  configHash: "",
  timer: null,
};

// ---------------------------------------------------------------------------
// Diff and emit
// ---------------------------------------------------------------------------

function checkForChanges(contentDir: string, loaded: LoadedConfig): void {
  const newManifest = buildManifest(contentDir);

  // Detect new files and updates
  for (const [path, hash] of newManifest) {
    const oldHash = state.contentManifest.get(path);
    if (!oldHash) {
      // New file
      const urlPath = filePathToUrlPath(path, contentDir);
      emitEvent("new_page", urlPath, `New page: ${urlPath}`);
    } else if (oldHash !== hash) {
      // Modified file
      const urlPath = filePathToUrlPath(path, contentDir);
      emitEvent("content_update", urlPath, `Content updated: ${urlPath}`);
    }
  }

  // Detect deletions
  for (const [path] of state.contentManifest) {
    if (!newManifest.has(path)) {
      const urlPath = filePathToUrlPath(path, contentDir);
      emitEvent("retraction", urlPath, `Page retracted: ${urlPath}`);
    }
  }

  state.contentManifest = newManifest;

  // Config change detection
  const newConfigHash = hashConfig(loaded);
  if (state.configHash && state.configHash !== newConfigHash) {
    // Determine what changed — pricing or signals
    // Re-hash just pricing and signals separately for a more specific event
    const pricingHash = createHash("sha256")
      .update(JSON.stringify(loaded.config.pricing))
      .digest("hex");
    const signalsHash = createHash("sha256")
      .update(JSON.stringify(loaded.config.signals))
      .digest("hex");

    // We can't easily compare against previous individual hashes without
    // storing them separately — emit pricing_change as the catch-all for
    // config changes since pricing is the more significant signal.
    // A future iteration can track sub-hashes independently.
    emitEvent("pricing_change", "/", "Pricing or signals configuration changed");
  }
  state.configHash = newConfigHash;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the watcher. Builds the initial manifest silently (no events).
 * Call once at startup after ensureDataDir().
 */
export function initWatcher(loaded: LoadedConfig): void {
  const contentDir = loaded.contentDir;
  state.contentManifest = buildManifest(contentDir);
  state.configHash = hashConfig(loaded);

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "watcher_init",
    files: state.contentManifest.size,
  }));
}

/**
 * Start the polling loop. Call after initWatcher().
 */
export function startWatcher(loaded: LoadedConfig): void {
  if (state.timer) return;

  const intervalMs = parseInt(process.env.MDF_WATCH_INTERVAL_MS ?? "30000", 10);

  state.timer = setInterval(() => {
    try {
      checkForChanges(loaded.contentDir, loaded);
    } catch (err) {
      console.error(`[mdf:watcher] poll error: ${(err as Error).message}`);
    }
  }, intervalMs);

  // Don't prevent process exit
  if (typeof state.timer === "object" && "unref" in state.timer) {
    (state.timer as NodeJS.Timeout).unref();
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "watcher_start",
    intervalMs,
  }));
}

export function stopWatcher(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
