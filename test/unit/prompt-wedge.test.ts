import { describe, expect, test } from "bun:test";
import { promptLineOf } from "../../src/lifecycle/prompt-wedge.ts";

describe("promptLineOf", () => {
  test("anchors on the dialog question and takes the command above it, not the Yes/No footer", () => {
    const screen = ["some earlier output", "$ git push --force-with-lease origin HEAD", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", ""].join("\n");
    expect(promptLineOf(screen)).toBe("some earlier output $ git push --force-with-lease origin HEAD Do you want to proceed?");
  });

  test("takes at most 3 non-empty lines above the question", () => {
    const screen = ["l1", "l2", "l3", "l4", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(promptLineOf(screen)).toBe("l2 l3 l4 Do you want to proceed?");
  });

  test("falls back to the last-lines heuristic when there is no dialog question", () => {
    const screen = ["first", "second", "allow this tool to run?"].join("\n");
    expect(promptLineOf(screen)).toBe("allow this tool to run?");
  });

  test("a null screen yields no prompt text", () => {
    expect(promptLineOf(null)).toBe("");
  });

  test("uses the LAST dialog question, not a stale one earlier in the scrollback", () => {
    const screen = [
      "$ git push --force-with-lease origin HEAD",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "(declined)",
      "$ rm -rf build",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ].join("\n");
    const result = promptLineOf(screen);
    expect(result).toContain("rm -rf build");
    expect(result).not.toContain("git push");
  });
});
