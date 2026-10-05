import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../src/util/redact.ts";

/** A deterministic, reproducible stand-in for "a random base64url blob": no real randomness needed. */
function base64urlBlob(size: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let seed = 42;
  let out = "";
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}

describe("redactSecrets", () => {
  test.each([
    ["export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "export GH_TOKEN=[redacted]"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "Authorization: Bearer [redacted]"],
    ["key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX", "key [redacted]"],
    ["AWS AKIAIOSFODNN7EXAMPLE here", "AWS [redacted] here"],
    ["password: hunter2", "password: [redacted]"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "[redacted]"],
  ])("%s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  test("a PEM block is removed whole", () => {
    expect(redactSecrets("a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nb")).toBe("a\n[redacted]\nb");
  });

  test("ordinary text is kept", () => {
    expect(redactSecrets("Do you want to proceed? git push --force-with-lease")).toBe("Do you want to proceed? git push --force-with-lease");
  });

  test("a multi-word secret value is redacted to end of line, not just its first word", () => {
    expect(redactSecrets("password: hunter 2 secret phrase")).toBe("password: [redacted]");
  });

  test("redaction stops at the newline, leaving the next line intact", () => {
    expect(redactSecrets("token=abc def\nnext line")).toBe("token=[redacted]\nnext line");
  });

  test.each([
    ["export DB_PASSWORD=hunter2", "export DB_PASSWORD=[redacted]"],
    ["AWS_SECRET_ACCESS_KEY=abcdefghij1234567890EXAMPLE", "AWS_SECRET_ACCESS_KEY=[redacted]"],
    ["OPENAI_API_KEY=abcdefghij1234567890", "OPENAI_API_KEY=[redacted]"],
    ["GITHUB_TOKEN=notarealtoken1234567890", "GITHUB_TOKEN=[redacted]"],
    ['{"password": "x"}', '{"password": [redacted]'],
    ["--password hunter2", "--password [redacted]"],
    ["https://user:pass@host", "https://[redacted]@host"],
    ["postgres://app:s3cret@db", "postgres://[redacted]@db"],
    ["glpat-ABCDEFGHIJKLMNOPQRSTUVWX", "[redacted]"],
    ["Do you want to proceed? git push --force-with-lease", "Do you want to proceed? git push --force-with-lease"],
  ])("%s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  test("a PEM with a BEGIN but no END (the tail cut off the close) redacts from BEGIN to the end of the text", () => {
    expect(redactSecrets("leader:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B")).toBe("leader:\n[redacted]");
  });

  test("a PEM with an END but no BEGIN (the head scrolled off) redacts from the start of the text to END", () => {
    expect(redactSecrets("MIIEvQIBADANBgkqhkiG9w0B\n-----END RSA PRIVATE KEY-----\nmore text")).toBe("[redacted]\nmore text");
  });

  test("an unpaired END that comes before an unpaired BEGIN redacts both (two different cut keys, in either order)", () => {
    const out = redactSecrets("MIIEbodyA\n-----END RSA PRIVATE KEY-----\nmid\n-----BEGIN RSA PRIVATE KEY-----\nbodyB");
    expect(out).not.toContain("MIIEbodyA");
    expect(out).not.toContain("bodyB");
  });

  test("an armored PGP private key block is removed whole", () => {
    expect(redactSecrets("a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\nb")).toBe("a\n[redacted]\nb");
  });

  test("an armored PGP private key with a BEGIN but no END redacts from BEGIN to the end of the text", () => {
    expect(redactSecrets("gpg:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFbody")).toBe("gpg:\n[redacted]");
  });

  test("an armored PGP private key with an END but no BEGIN redacts from the start of the text to END", () => {
    expect(redactSecrets("lQOYBFbody\n-----END PGP PRIVATE KEY BLOCK-----\nmore text")).toBe("[redacted]\nmore text");
  });

  test("text between two whole PEM blocks is kept", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`a\n${key}\nmid\n${key}\nb`)).toBe("a\n[redacted]\nmid\n[redacted]\nb");
  });

  test("a labeled flag's multi-word value is redacted to end of line", () => {
    expect(redactSecrets("--password my pass phrase\nnext line")).toBe("--password [redacted]\nnext line");
  });

  test("whitespace after a flag's = does not leave its value exposed", () => {
    expect(redactSecrets("--token= abc def")).toBe("--token=[redacted]");
  });

  test("a labeled flag at the end of its line does not redact the next line", () => {
    expect(redactSecrets("--token\nnext line")).toBe("--token\nnext line");
  });

  test("an unlabeled flag before a labeled one on the same line does not hide it", () => {
    expect(redactSecrets("cmd --verbose --token hunter2")).toBe("cmd --verbose --token [redacted]");
  });

  test("never throws, always returns a string", () => {
    expect(redactSecrets("")).toBe("");
    const unterminated = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "A".repeat(200_000);
    expect(typeof redactSecrets(unterminated)).toBe("string");
    const binaryish = "\u0000\u0001 café 日本語 password: \u0000secret\u0000";
    expect(typeof redactSecrets(binaryish)).toBe("string");
  });

  test.each([
    ["200 KB of \"a-token-\"", "a-token-".repeat(25_000)],
    ["200 KB of \"--token\"", "--token".repeat(28_572)],
    ["200 KB of \"a.\"", "a.".repeat(100_000)],
    ["200 KB random base64url blob", base64urlBlob(200_000)],
    ["1 MB of repeated PEM BEGIN markers with no END", "-----BEGIN RSA PRIVATE KEY-----\n".repeat(32_768)],
    ["1 MB of repeated PEM END markers", "-----END RSA PRIVATE KEY-----\n".repeat(34_000)],
    ["200 KB of \"--token x \"", "--token x ".repeat(20_000)],
  ])("redacts %s in linear time (no catastrophic backtracking)", (_label, input) => {
    // Quadratic backtracking on these inputs costs ~1e10 steps (tens of seconds); linear is a few ms.
    // The best of three runs under a 1s budget separates the two without failing on a loaded machine.
    const runs = Array.from({ length: 3 }, () => {
      const start = performance.now();
      redactSecrets(input);
      return performance.now() - start;
    });
    expect(Math.min(...runs)).toBeLessThan(1_000);
  });
});
