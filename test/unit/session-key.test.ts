import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPageForKey, lavishSessionKey, lavishUrlKey } from "../../src/lavish/session-key.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-key-")));
  dirs.push(dir);
  return dir;
}

describe("lavish session keys (assumption: the key is sha256(realpath)[:16])", () => {
  test("matches the key lavish-axi 0.1.65 printed for a real page", () => {
    // Observed: `lavish-axi <this page>` printed http://127.0.0.1:4387/session/254ed28a675a185f.
    expect(lavishSessionKey("/Users/pr0digy/.flowryn/data/gates-lavish-review-2p/design/design.html")).toBe("254ed28a675a185f");
  });

  test("reads the key from loopback, Tailscale and https URLs, and nothing else", () => {
    expect(lavishUrlKey("http://127.0.0.1:4387/session/254ed28a675a185f")).toBe("254ed28a675a185f");
    expect(lavishUrlKey("http://mac.tail1234.ts.net:4387/session/0123456789abcdef")).toBe("0123456789abcdef");
    expect(lavishUrlKey("https://[::1]:9000/session/0123456789abcdef")).toBe("0123456789abcdef");
    for (const bad of [
      "http://127.0.0.1:4387/session/254ED28A675A185F",
      "http://127.0.0.1:4387/session/254ed28a675a185",
      "http://127.0.0.1:4387/session/254ed28a675a185f/",
      "http://127.0.0.1:4387/session/254ed28a675a185f?x=1",
      "http://127.0.0.1:4387/other/254ed28a675a185f",
      "file:///tmp/session/254ed28a675a185f",
      "https://example.com/review",
    ]) {
      expect(lavishUrlKey(bad)).toBeNull();
    }
  });
});

describe("findPageForKey", () => {
  test("finds the .html page with the key, in a subdirectory", () => {
    const root = scratch();
    mkdirSync(join(root, "design"));
    writeFileSync(join(root, "design", "design.html"), "<html></html>");
    writeFileSync(join(root, "design", "notes.md"), "x");
    const page = join(root, "design", "design.html");
    expect(findPageForKey(root, lavishSessionKey(page))).toBe(page);
    expect(findPageForKey(root, "0123456789abcdef")).toBeNull();
  });

  test("never follows a symlink, to a file or a directory", () => {
    const root = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "page.html"), "<html></html>");
    symlinkSync(join(outside, "page.html"), join(root, "link.html"));
    symlinkSync(outside, join(root, "linked"));
    expect(findPageForKey(root, lavishSessionKey(join(root, "link.html")))).toBeNull();
    expect(findPageForKey(root, lavishSessionKey(join(root, "linked", "page.html")))).toBeNull();
  });

  test("looks at most four levels deep", () => {
    const root = scratch();
    const deep = join(root, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "ok.html"), "");
    writeFileSync(join(deep, "too-deep.html"), "");
    expect(findPageForKey(root, lavishSessionKey(join(root, "a", "b", "c", "ok.html")))).not.toBeNull();
    expect(findPageForKey(root, lavishSessionKey(join(deep, "too-deep.html")))).toBeNull();
  });
});
