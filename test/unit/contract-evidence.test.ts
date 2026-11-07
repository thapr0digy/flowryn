import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidencePathFor, MAX_LINE_CHARS, redactEvidence, TRANSCRIPT_TAIL_LINES, transcriptTail, writeEvidence, type StepEvidence } from "../../src/contracts/evidence.ts";
import { END_TURN_NOTE, steerLine, urgentBlockLine, urgentCutLine, workerContract } from "../../src/harness/contract-text.ts";

const dir = mkdtempSync(join(tmpdir(), "fw-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function evidence(over: Partial<StepEvidence> = {}): StepEvidence {
  return {
    step: "idle",
    error: "timed out",
    failed_at: new Date(0).toISOString(),
    run: null,
    events: [],
    steers: [],
    transcript: { path: null, lines: [] },
    screen: { pane: null, text: null },
    ...over,
  };
}

describe("a failed contract step's evidence", () => {
  test("redacts every string as diag export does, and the screen's secrets", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const out = redactEvidence(
      evidence({
        error: `push to https://user:hunter2@example.com/repo failed with ${token}`,
        transcript: { path: "/t.jsonl", lines: [`{"text":"export GITHUB_TOKEN=${token}"}`] },
        screen: { pane: "w:p1", text: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" },
        events: [{ seq: 1, ts: 1, source: "hook", kind: "run.failed", payload: { reason: `token ${token}` } }],
      }),
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(token);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc\\n-----END");
    expect(out.step).toBe("idle");
  });

  test("keeps the transcript's last lines, each cut to a bound", () => {
    const path = join(dir, "t.jsonl");
    const lines = Array.from({ length: TRANSCRIPT_TAIL_LINES + 5 }, (_, i) => `{"n":${i}}`);
    lines.push("x".repeat(MAX_LINE_CHARS + 10));
    writeFileSync(path, lines.join("\n") + "\n");
    const tail = transcriptTail(path);
    expect(tail.lines).toHaveLength(TRANSCRIPT_TAIL_LINES);
    expect(tail.lines.at(-1)).toEndWith(`<cut: ${MAX_LINE_CHARS + 10} chars>`);
    expect(tail.lines[0]).toBe(`{"n":6}`);
  });

  test("says why a transcript is missing rather than failing", () => {
    expect(transcriptTail(null).error).toBe("the run recorded no transcript");
    expect(transcriptTail(join(dir, "missing.jsonl")).error).toStartWith("unreadable:");
  });

  test("goes beside the report at mode 0600", () => {
    const report = join(dir, "claude-1.0.0-x-verify-only.json");
    const path = writeEvidence(evidencePathFor(report), evidence());
    expect(path).toBe(join(dir, "claude-1.0.0-x-verify-only.evidence.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).step).toBe("idle");
  });
});

describe("a steer sent with --end-turn", () => {
  test("tells the worker its turn end asks for no outcome, after the ack", () => {
    expect(steerLine("m2", "reply TWO", true)).toBe(`Flowryn steer [m2]: reply TWO (when done: $FLOWRYN_BIN ack m2) ${END_TURN_NOTE}`);
    expect(steerLine("m2", "reply TWO")).not.toContain(END_TURN_NOTE);
    expect(urgentBlockLine("m4", "stop", true)).toContain(END_TURN_NOTE);
    expect(urgentCutLine("m4", "stop", true)).toContain(END_TURN_NOTE);
  });

  test("is named by the worker contract's outcome rule, so the two never contradict", () => {
    const rule = workerContract("claude", null, { base: null, defaultBranch: "main" })
      .split("\n")
      .find((l) => l.startsWith("- End each turn with an outcome"))!;
    expect(rule).toContain("or as a steer says");
    expect(END_TURN_NOTE).toContain("asks for no outcome");
  });
});
