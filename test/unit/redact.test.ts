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
});
