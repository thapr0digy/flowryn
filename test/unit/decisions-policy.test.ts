import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config/config.ts";
import { decisionsConfig, reservedReason } from "../../src/attention/decisions-policy.ts";

const cfg = decisionsConfig(parseConfig("", "/tmp/h"));
const ask = (question: string, extra: Partial<Parameters<typeof reservedReason>[0]> = {}) =>
  reservedReason({ question, context: null, sourceReason: null, blocksYoloOff: false, ...extra }, cfg);

describe("reserved decisions", () => {
  test.each([
    ["Delete the old evidence bucket?", "destructive"],
    ["Drop the legacy table and lose its rows?", "destructive"],
    ["Rotate the signing key and revoke the old one?", "credential"],
    ["Disable TLS verification for the scanner?", "security"],
    ["Publish the release announcement on the blog?", "outward"],
    ["Force-push the rewritten history?", "irreversible"],
  ])("%s is reserved as %s", (question, klass) => {
    expect(ask(question)).toBe(klass);
  });

  test("ordinary design choices are the leader's", () => {
    expect(ask("Profile A or profile B first?")).toBeNull();
    expect(ask("Use SQLite or Postgres for the cache?")).toBeNull();
  });

  test("a source's own reason wins, and a non-yolo merge target is reserved", () => {
    expect(ask("Pick a name", { sourceReason: "mission approval gate" })).toBe("mission approval gate");
    expect(ask("Ready?", { blocksYoloOff: true })).toBe("merge");
  });

  test("[decisions] narrows the classes and rejects unknown ones", () => {
    const narrow = decisionsConfig(parseConfig('[decisions]\nreserved_classes = ["credential"]\n', "/tmp/h"));
    expect(reservedReason({ question: "Delete the bucket?", context: null, sourceReason: null, blocksYoloOff: false }, narrow)).toBeNull();
    expect(() => decisionsConfig(parseConfig('[decisions]\nreserved_classes = ["vibes"]\n', "/tmp/h"))).toThrow(/vibes/);
    expect(() => decisionsConfig(parseConfig("[decisions]\nother = 1\n", "/tmp/h"))).toThrow(/other/);
  });
});
