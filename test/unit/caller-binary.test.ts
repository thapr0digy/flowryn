import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_KEPT, callerLink, pinCallerBinary, pinnedLink } from "../../src/daemon/caller-binary.ts";
import { workerBinary } from "../../src/lifecycle/fleet-services.ts";

/**
 * The pinned caller binary: callers run `<state>/bin/flowryn`, a link to a
 * copy of the running daemon's build, so a rebuild of the installed binary
 * changes nothing for them until the daemon restarts onto it.
 */

let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "fw-pin-"));
});

afterEach(() => rmSync(state, { recursive: true, force: true }));

const bytes = (text: string) => new TextEncoder().encode(text);

describe("pinned caller binary", () => {
  test("pins a copy of the running build behind the caller link", () => {
    const link = pinCallerBinary(state, "aaaaaaaaaaaa", bytes("build A"));
    expect(link).toBe(callerLink(state));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("flowryn-aaaaaaaaaaaa");
    expect(readFileSync(link, "utf8")).toBe("build A");
    expect(lstatSync(join(state, "bin", "flowryn-aaaaaaaaaaaa")).mode & 0o777).toBe(0o700);
  });

  test("a restart onto a new build repoints the link; the old copy stays for a caller mid-exec", () => {
    pinCallerBinary(state, "aaaaaaaaaaaa", bytes("build A"));
    pinCallerBinary(state, "bbbbbbbbbbbb", bytes("build B"));
    expect(readFileSync(callerLink(state), "utf8")).toBe("build B");
    expect(existsSync(join(state, "bin", "flowryn-aaaaaaaaaaaa"))).toBe(true);
  });

  test(`keeps the newest ${PINNED_KEPT} copies, the running one always among them`, () => {
    const builds = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
    const base = Date.now() / 1000 - 1000;
    for (const [i, b] of builds.entries()) {
      pinCallerBinary(state, b, bytes(b));
      utimesSync(join(state, "bin", `flowryn-${b}`), base + i, base + i);
    }
    // Back onto the oldest kept one: it is the running build, so it stays whatever its age.
    pinCallerBinary(state, "bbbbbbbbbbbb", bytes("bbbbbbbbbbbb"));
    const copies = readdirSync(join(state, "bin")).filter((f) => f.startsWith("flowryn-")).toSorted();
    expect(copies).toEqual(["flowryn-bbbbbbbbbbbb", "flowryn-cccccccccccc", "flowryn-dddddddddddd"]);
  });

  test("workers of a compiled daemon get the pinned link; with none, the binary itself", () => {
    expect(workerBinary(state, ["/d/flowryn"])).toBe("/d/flowryn");
    pinCallerBinary(state, "aaaaaaaaaaaa", bytes("build A"));
    expect(workerBinary(state, ["/d/flowryn"])).toBe(callerLink(state));
    expect(pinnedLink(state)).toBe(callerLink(state));
  });

  test("a development daemon replaces the link with its wrapper script, leaving the pinned copy intact", () => {
    pinCallerBinary(state, "aaaaaaaaaaaa", bytes("build A"));
    const path = workerBinary(state, ["bun", "/src/main.ts"]);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toContain('exec "bun" "/src/main.ts"');
    expect(readFileSync(join(state, "bin", "flowryn-aaaaaaaaaaaa"), "utf8")).toBe("build A");
    expect(pinnedLink(state)).toBeNull();
  });
});
