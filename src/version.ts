/**
 * Server release version.
 *
 * Read once from package.json when this module is first loaded (i.e. process
 * startup) and cached for the process lifetime — package.json does not change
 * under a running process, so there is no reason to re-read it per request.
 *
 * This is the reference-server *release* version (e.g. "0.2.3"), which is a
 * different thing from the MDF *protocol* version ("1.0", surfaced elsewhere
 * as `mdf_version` / `X-MDF-Version`). Keeping the two names distinct is the
 * whole point of exposing this.
 */
import { readFileSync } from "fs";
import { join } from "path";

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the explicit unknown marker below — a missing or
    // unreadable package.json must not take the health endpoint down.
  }
  return "unknown";
}

export const SERVER_VERSION = readPackageVersion();
