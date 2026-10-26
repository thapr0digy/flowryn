import { describe, expect, test } from "bun:test";
import { countSenders, isNotificationPrompt, senderOf } from "../../src/policy/notifications.ts";
import { NOTICE_FIXTURES, TYPED_FIXTURES, transcriptFixture } from "../helpers/transcript-fixtures.ts";

/** The text Claude queued (`attachment.prompt`, or a `user` entry's content) and how it rendered it to the model. */
function textsOf(entry: Record<string, unknown>): string[] {
  const attachment = entry.attachment as { prompt?: string } | undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  const rendered = [...((entry.rendered as { content: string }[] | undefined) ?? []), ...((entry.renderedInHumanTurn as { content: string }[] | undefined) ?? [])].map((r) => r.content);
  return [...(attachment?.prompt !== undefined ? [attachment.prompt] : typeof content === "string" ? [content] : []), ...rendered];
}

describe("assumption: Claude records who sent each message (origin.kind; an older notice only commandMode)", () => {
  for (const name of NOTICE_FIXTURES) {
    test(`${name} is a notice`, () => {
      expect(senderOf(transcriptFixture(name))).toBe("notice");
    });
  }
  for (const name of TYPED_FIXTURES) {
    test(`${name} is you`, () => {
      expect(senderOf(transcriptFixture(name))).toBe("you");
    });
  }

  test("an unknown or missing origin is you; tool results, meta lines and summaries are no message", () => {
    const busy = transcriptFixture("typed-while-busy");
    const attachment = busy.attachment as Record<string, unknown>;
    expect(senderOf({ ...busy, attachment: { ...attachment, origin: { kind: "coordinator" } } })).toBe("you");
    expect(senderOf({ ...busy, attachment: { ...attachment, origin: undefined, commandMode: "prompt" } })).toBe("you");
    expect(senderOf({ type: "user", message: { content: "typed with no origin (claude -p)" } })).toBe("you");
    expect(senderOf({ type: "user", origin: { kind: "auto-continuation" }, message: { content: "go on" } })).toBe("you");
    expect(senderOf({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } })).toBeNull();
    expect(senderOf({ type: "user", isMeta: true, message: { content: "skill text" } })).toBeNull();
    expect(senderOf({ type: "user", isCompactSummary: true, message: { content: "summary" } })).toBeNull();
    expect(senderOf({ type: "user", origin: { kind: "peer", handback: true }, isMeta: true, message: { content: "a hand-back" } })).toBe("notice");
    expect(senderOf({ type: "attachment", attachment: { type: "hook_additional_context", content: ["x"] } })).toBeNull();
    expect(senderOf({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBeNull();
  });

  test("countSenders counts each, skipping lines that are not JSON", () => {
    const lines = [...NOTICE_FIXTURES, ...TYPED_FIXTURES].map((n) => JSON.stringify(transcriptFixture(n)));
    expect(countSenders([...lines, "not json", ""])).toEqual({ you: TYPED_FIXTURES.length, notices: NOTICE_FIXTURES.length });
  });
});

describe("assumption: the prompt hook sees a notice as its queued text or Claude's rendered reminder", () => {
  for (const name of NOTICE_FIXTURES) {
    test(`${name}: every form is a notification prompt`, () => {
      const texts = textsOf(transcriptFixture(name));
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) expect(isNotificationPrompt(text)).toBe(true);
    });
  }
  for (const name of ["typed-while-busy", "typed-while-idle"] as const) {
    test(`${name}: no form is a notification prompt`, () => {
      for (const text of textsOf(transcriptFixture(name))) expect(isNotificationPrompt(text)).toBe(false);
    });
  }

  test("anything beside the notice blocks, or no notice block at all, is you", () => {
    const notice = (transcriptFixture("monitor-event").attachment as { prompt: string }).prompt;
    expect(isNotificationPrompt(`${notice}\n${notice}`)).toBe(true);
    expect(isNotificationPrompt(`${notice}\nand please merge it`)).toBe(false);
    expect(isNotificationPrompt(`merge it\n${notice}`)).toBe(false);
    expect(isNotificationPrompt("<system-reminder>only a reminder</system-reminder>")).toBe(false);
    expect(isNotificationPrompt("<task-notification>unclosed")).toBe(false);
    expect(isNotificationPrompt("")).toBe(false);
    expect(isNotificationPrompt(undefined)).toBe(false);
    expect(isNotificationPrompt("Another Claude session sent a message:\nhi")).toBe(false);
    expect(isNotificationPrompt('Another Claude session sent a message:\n<agent-message from="a1">\nreport\n</agent-message>')).toBe(true);
  });
});
