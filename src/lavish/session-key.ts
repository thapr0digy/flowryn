import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * How lavish-axi names a page (read from lavish-axi 0.1.65, dist/cli.mjs:
 * `sessionKey(canonicalFile(file))`): the first 16 hex digits of the SHA-256
 * of the file's real path. Its URL is `http://<link host>:<port>/session/<key>`,
 * where the host is loopback, the Tailscale MagicDNS name or an env override,
 * so a review URL is recognised by its key, never by its host.
 */

/** A lavish review URL; group 1 is the session key. */
export const LAVISH_URL = /^https?:\/\/[^/\s?#]{1,253}\/session\/([0-9a-f]{16})$/;

/** How deep and how many entries the search for a page under the report directory looks. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

/** The lavish session key of a page, given its real path. */
export function lavishSessionKey(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 16);
}

/** The session key a lavish review URL names, or null when it is not one. */
export function lavishUrlKey(url: string): string | null {
  return LAVISH_URL.exec(url)?.[1] ?? null;
}

/**
 * The .html page under a real directory whose lavish key is `key`, or null.
 * Symlinks are never followed, so every path it builds is already real.
 */
export function findPageForKey(realRoot: string, key: string): string | null {
  let seen = 0;
  const walk = (dir: string, depth: number): string | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return null;
      const path = join(dir, entry.name);
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".html" && lavishSessionKey(path) === key) return path;
      if (entry.isDirectory() && depth < MAX_DEPTH) {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(realRoot, 1);
}
