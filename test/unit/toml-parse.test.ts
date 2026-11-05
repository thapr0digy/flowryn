import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { loadConfig, parseConfig } from "../../src/config/config.ts";
import { configOverrides } from "../../src/config/effective.ts";
import { mergeDuplicateTables, parseTomlText } from "../../src/config/toml-parse.ts";
import { makeHome } from "../helpers/harness.ts";

const HOME = "/tmp/fw-home";

/** Each case was run through Bun 1.3.8's own parser (2026-11-04); `parseTomlText` must read it the same. */
const BUN_13_READS: [string, string, unknown][] = [
  ["a table defined twice", "[a]\nx=1\n[a]\ny=2\n", { a: { x: 1, y: 2 } }],
  ["a repeat after a subtable", "[a]\nx=1\n[a.b]\nz=1\n[a]\ny=2\n", { a: { x: 1, b: { z: 1 }, y: 2 } }],
  ["a repeated subtable", "[a.b]\nz=1\n[a]\ny=2\n[a.b]\nw=3\n", { a: { b: { z: 1, w: 3 }, y: 2 } }],
  ["a repeat with a comment, and a list of lists over lines", '[a]\nx=1\n[b]\nq=1\n[a] # again\ny=2\n[b]\nr=[\n  ["c"]\n]\n', { a: { x: 1, y: 2 }, b: { q: 1, r: [["c"]] } }],
  ["arrays of tables keep one subtable per element", "[[r]]\nn=1\n[r.s]\nq=1\n[[r]]\nn=2\n[r.s]\nq=2\n[a]\nk=1\n[a]\nj=2\n", { r: [{ n: 1, s: { q: 1 } }, { n: 2, s: { q: 2 } }], a: { k: 1, j: 2 } }],
  ["a quoted, spaced header", 'top=1\n[ a . "b c" ]\nx=1\n[a."b c"]\ny=2\n', { top: 1, a: { "b c": { x: 1, y: 2 } } }],
  ["a header-like line inside a multi-line string", '[a]\ns="""x\n[a]\n"""\n[a]\nt=1\n', { a: { s: "x\n[a]\n", t: 1 } }],
  ["a header-like line inside a list", '[a]\nl=[\n["x"]\n]\n[a]\nm=1\n', { a: { l: [["x"]], m: 1 } }],
];

describe("a table defined twice (Bun 1.4 refuses it; Bun 1.3 merged it)", () => {
  test("assumption: Bun 1.4's parser refuses the second header, naming the table", () => {
    // engines.bun still allows 1.3.x, which merged the two.
    if (Bun.semver.satisfies(Bun.version, ">=1.4.0")) expect(() => Bun.TOML.parse("[a]\nx=1\n[a]\ny=2")).toThrow("Cannot redefine table 'a'");
    else expect(Bun.TOML.parse("[a]\nx=1\n[a]\ny=2")).toEqual({ a: { x: 1, y: 2 } });
  });

  for (const [what, text, want] of BUN_13_READS) {
    test(`read as Bun 1.3 read it: ${what}`, () => {
      expect(parseTomlText(text)).toEqual(want as Record<string, unknown>);
      // The folded text is valid TOML for any parser, with each table once.
      expect(Bun.TOML.parse(mergeDuplicateTables(text))).toEqual(want as Record<string, unknown>);
    });
  }

  test("a key set twice across the repeats is still refused, as Bun 1.3 refused it", () => {
    expect(() => parseTomlText("[a]\nx=1\n[a]\nx=2\n")).toThrow("Cannot redefine key 'x'");
  });

  test("a header whose name it cannot read leaves the text alone, so Bun's refusal stands", () => {
    // Bun 1.3.8 read this as { a: { x: 1, z: 2 }, "k\\x": { y: 1 } }; folding past the escaped header filed z under it.
    const text = '[a]\nx=1\n["k\\\\x"]\ny=1\n[a]\nz=2\n';
    expect(mergeDuplicateTables(text)).toBe(text);
    if (Bun.semver.satisfies(Bun.version, ">=1.4.0")) expect(() => parseTomlText(text)).toThrow("Cannot redefine table 'a'");
  });

  test("text with no repeated table comes back unchanged", () => {
    const text = '# c\ntop = 1\n[a]\nx = 1\n[a.b]\ny = "[a]"\n[[r]]\nn = 1\n[[r]]\nn = 2\n';
    expect(mergeDuplicateTables(text)).toBe(text);
  });

  test("a config.toml that loaded on Bun 1.3 with [notify] twice still loads, keys from both", () => {
    const text = "[notify]\nmacos = false\n[capacity]\nworker = 3\n[notify]\nmin_interval_min = 45\n";
    const config = parseConfig(text, HOME);
    expect(config.extra.notify).toEqual({ macos: false, min_interval_min: 45 });
    expect(config.extra.capacity).toEqual({ worker: 3 });
    expect(configOverrides(text)).toEqual(["capacity.worker", "notify.macos", "notify.min_interval_min"]);
  });

  test("a key repeated across the repeats is a config_invalid error naming the key", () => {
    let error: unknown;
    try {
      parseConfig("[notify]\nmacos = false\n[notify]\nmacos = true\n", HOME);
    } catch (e) {
      error = e;
    }
    expect((error as FlowrynError).code).toBe("config_invalid");
    expect((error as FlowrynError).message).toContain("Cannot redefine key 'macos'");
  });

  test("a test home whose fragments open the same table writes each table once", () => {
    const h = makeHome({ extraConfig: "[leader]\nbusy_lease_ms = 3000\n[notify]\nmacos = false\n[leader]\ninactive_ms = 400\n[herdr]\nsocket = \"/nowhere\"" });
    try {
      const body = readFileSync(join(h.home, "config.toml"), "utf8");
      const headers = body.split("\n").filter((l) => /^\[[^[]/.test(l));
      expect(headers.length).toBe(new Set(headers).size);
      expect((Bun.TOML.parse(body) as { leader: unknown }).leader).toEqual({ busy_lease_ms: 3000, inactive_ms: 400 });
      expect(loadConfig(h.home).config.extra.leader).toEqual({ busy_lease_ms: 3000, inactive_ms: 400 });
    } finally {
      h.cleanup();
    }
  });
});

test("a file read from disk goes through the same reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "fw-toml-"));
  writeFileSync(join(dir, "config.toml"), "[notify]\nmacos = false\n[notify]\nmin_interval_min = 45\n");
  try {
    expect(loadConfig(dir).config.extra.notify).toEqual({ macos: false, min_interval_min: 45 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
