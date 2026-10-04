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

  test("never throws, always returns a string", () => {
    expect(redactSecrets("")).toBe("");
    const unterminated = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "A".repeat(200_000);
    expect(typeof redactSecrets(unterminated)).toBe("string");
    const binaryish = "\u0000\u0001 café 日本語 password: \u0000secret\u0000";
    expect(typeof redactSecrets(binaryish)).toBe("string");
  });
});
