import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../src/util/redact.ts";

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

  test("never throws, always returns a string", () => {
    expect(redactSecrets("")).toBe("");
    const unterminated = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "A".repeat(200_000);
    expect(typeof redactSecrets(unterminated)).toBe("string");
    const binaryish = "\u0000\u0001 café 日本語 password: \u0000secret\u0000";
    expect(typeof redactSecrets(binaryish)).toBe("string");
  });
});
