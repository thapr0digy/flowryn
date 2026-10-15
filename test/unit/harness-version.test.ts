import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessVersion } from "../../src/lifecycle/fleet-services.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in claude that answers its version only once `<binary>.ok` exists, so its mtime never changes between probes. */
function flakyClaude(): { binary: string; heal: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "flowryn-harness-version-"));
  dirs.push(dir);
  const binary = join(dir, "claude");
  writeFileSync(binary, `#!/bin/sh\nif [ -f "$0.ok" ]; then echo "2.1.300 (Claude Code)"; else exit 1; fi\n`);
  chmodSync(binary, 0o755);
  return { binary, heal: () => writeFileSync(`${binary}.ok`, "") };
}

describe("harnessVersion", () => {
  test("a probe that answers no version is not cached: the next call asks again and caches the parsed version", async () => {
    const claude = flakyClaude();
    const mtime = statSync(claude.binary).mtimeMs;
    expect(await harnessVersion("claude", claude.binary)).toBeNull();
    expect(await harnessVersion("claude", claude.binary)).toBeNull();
    claude.heal();
    expect(statSync(claude.binary).mtimeMs).toBe(mtime);
    expect(await harnessVersion("claude", claude.binary)).toBe("2.1.300");
    // Cached now: a probe that would fail is not run while the binary is unchanged.
    rmSync(`${claude.binary}.ok`);
    expect(await harnessVersion("claude", claude.binary)).toBe("2.1.300");
  });

  test("a binary that cannot be found is null, and nothing is cached for it", async () => {
    expect(await harnessVersion("claude", "/nonexistent/claude")).toBeNull();
  });
});
