import { afterEach, describe, expect, test } from "bun:test";
import { LANE_TABLE, openItem } from "../../src/attention/items.ts";
import { tx } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { failRun, getRun } from "../../src/lifecycle/runs.ts";
import { REPORT_EFFECT, reportLine, reportOpensItem } from "../../src/lifecycle/worker.ts";
import { MAX_LINE_CHARS } from "../../src/util/sanitize.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

let home: TestHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

describe("the report status table", () => {
  test("finding, blocked and failed open an item; progress is only recorded", () => {
    for (const status of ["finding", "blocked", "failed"]) expect(reportOpensItem(status)).toBe(true);
    for (const status of ["progress", "started", "update", "note", "info", "done", "ok"]) expect(reportOpensItem(status)).toBe(false);
  });

  test("a word outside the table opens an item", () => {
    expect(REPORT_EFFECT.flaky).toBeUndefined();
    expect(reportOpensItem("flaky")).toBe(true);
  });

  test("a report item is a P1 the leader acts on, so the digest, the briefing and fleet needs carry it", () => {
    expect(LANE_TABLE.worker_report).toEqual({ lane: "P1", class: "actionable" });
  });
});

describe("the report item's line", () => {
  test("a short body is quoted whole, with no pointer", () => {
    expect(reportLine("Fix login", "blocked", "waiting on the API key")).toBe('Report (blocked) from Fix login: "waiting on the API key"');
    expect(reportLine("Fix login", "blocked", "")).toBe("Report (blocked) from Fix login");
  });

  test("a long body or title is cut to fit the item line limit, ending with the show pointer", () => {
    const line = reportLine("t".repeat(150), "finding", "word ".repeat(400));
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(line).toEndWith('…" (flowryn show for the full text)');
  });
});

describe("a report item closes when its run ends", () => {
  test("a failed run resolves its open report items", () => {
    home = makeHome();
    const { runId, taskId } = seedRun(home);
    const db = home.db();
    try {
      const item = tx(db, () => {
        const event = appendEvent(db, { source: "cli", kind: "worker.report", runId, taskId, payload: { status: "blocked", body: "x" } });
        return openItem(db, { kind: "worker_report", eventSeq: event.seq, line: "Report (blocked)", taskId, runId });
      });
      tx(db, () => failRun(db, getRun(db, runId)!, "dead", "daemon", Date.now()));
      expect(db.query("SELECT state, resolved_by FROM items WHERE id = ?1").get(item)).toEqual({ state: "resolved", resolved_by: "run.failed" });
    } finally {
      db.close();
    }
  });
});
