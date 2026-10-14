import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller, HandlerCtx, HandlerResult, Role } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { openItem } from "../../src/attention/items.ts";
import { READ_CLOSES_STATUSES, READ_RESOLVED_BY, closeReadItems, closesOnRead } from "../../src/attention/read-close.ts";
import { relayBatch } from "../../src/attention/router.ts";
import { parseConfig } from "../../src/config/config.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { REPORT_EFFECT, reportOpensItem } from "../../src/lifecycle/worker.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/** Closing a report item once the leader has read it whole (docs/notes/2026-10-14-auto-close-a-xn.md). */

let h: TestHome;
let db: Db;
const NOW = Date.now();
const SHOW = LEADER_RUN_VERBS.find((v) => v.name === "show")!;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/w', 'main', 'no-mistakes')").run();
    addRun("t-ship", "r1", "ship", "running");
    addRun("t-scout", "r2", "scout", "cleaned");
  });
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function addRun(task: string, run: string, kind: "ship" | "scout", state: string): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', ?2, 'no-mistakes', 0, 'fix', 1)").run(task, kind);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'busy', 'fix', 'build', '/tmp/wt', 'b', 'abc', ?1, 1, 1)`,
  ).run(run, task, state);
}

const caller = (role: Role): Caller => ({ role, runId: null, taskId: null, session: role === "leader" || role === "reader" ? "L1" : null });

function report(status: string, body: string, runId = "r1", taskId = "t-ship"): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "worker.report", runId, taskId, payload: { status, summary: body, body }, ts: NOW });
    return openItem(db, { kind: "worker_report", eventSeq: event.seq, taskId, runId, line: `Report (${status})`, now: NOW });
  });
}

/** A scout's delivered report: the file, its artifact row and its report_ready item. */
function scoutReport(text: string | null): string {
  const path = join(h.home, "report.md");
  if (text !== null) writeFileSync(path, text);
  return tx(db, () => {
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, created_at) VALUES ('a1', 't-scout', 'report', ?1, 1)").run(path);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: "r2", taskId: "t-scout", payload: { outcome: "report" }, ts: NOW });
    return openItem(db, { kind: "report_ready", eventSeq: event.seq, taskId: "t-scout", runId: "r2", line: "Report ready: t-scout (web); flowryn show t-scout --full", now: NOW });
  });
}

function itemState(id: string): { state: string; resolved_by: string | null } {
  return db.query("SELECT state, resolved_by FROM items WHERE id = ?1").get(id) as { state: string; resolved_by: string | null };
}

function readEvents(): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'item.read' ORDER BY seq").all() as { payload: string }[]).map((e) => JSON.parse(e.payload));
}

/** `flowryn show` as the daemon serves it: the read, then its afterRead in its own transaction. */
function show(target: string, role: Role, full = false): HandlerResult {
  const who = caller(role);
  const result = SHOW.read!({ db, config: parseConfig("", h.home), now: NOW, caller: who }, { target, ...(full ? { full: true } : {}) });
  const ctx = { db, caller: who, now: () => NOW } as unknown as HandlerCtx;
  return tx(db, () => SHOW.afterRead!(ctx, result));
}

describe("which reports a read closes", () => {
  test("finding, risk and regression close; every other status that opens an item stays open", () => {
    expect(READ_CLOSES_STATUSES).toEqual(["finding", "risk", "regression"]);
    for (const status of Object.keys(REPORT_EFFECT).filter(reportOpensItem)) {
      expect(closesOnRead("worker_report", status)).toBe(READ_CLOSES_STATUSES.includes(status));
    }
    for (const status of ["blocked", "stuck", "failed", "failing", "error", "broken", "flaky"]) expect(closesOnRead("worker_report", status)).toBe(false);
    expect(closesOnRead("worker_report", null)).toBe(false);
  });

  test("a report_ready closes whatever its decisions; no other kind closes on read", () => {
    expect(closesOnRead("report_ready", null)).toBe(true);
    for (const kind of ["worker_question", "pr_ready", "worker_idle"]) expect(closesOnRead(kind, "finding")).toBe(false);
  });
});

describe("closeReadItems", () => {
  test("the leader's read resolves a finding as read and records one item.read event in the same transaction", () => {
    const id = report("finding", "main fails its own test");
    expect(tx(db, () => closeReadItems(db, caller("leader"), [{ item: id, form: "item" }], NOW))).toEqual([id]);
    expect(itemState(id)).toEqual({ state: "resolved", resolved_by: READ_RESOLVED_BY });
    expect(readEvents()).toEqual([{ item: id, kind: "worker_report", status: "finding", by: "leader", session: "L1", form: "item" }]);
    const event = db.query("SELECT run_id, task_id FROM events WHERE kind = 'item.read'").get() as { run_id: string; task_id: string };
    expect(event).toEqual({ run_id: "r1", task_id: "t-ship" });
  });

  test("a report that asks for action stays open after reading, with no event", () => {
    const ids = ["blocked", "error", "flaky"].map((s) => report(s, `a ${s} report`));
    expect(tx(db, () => closeReadItems(db, caller("leader"), ids.map((item) => ({ item, form: "item" as const })), NOW))).toEqual([]);
    for (const id of ids) expect(itemState(id).state).toBe("open");
    expect(readEvents()).toEqual([]);
  });

  test("only the leader's read closes: a reader's, a human's or a worker's never does", () => {
    const id = report("finding", "x");
    for (const role of ["reader", "human", "worker", "hook", "anonymous"] as const) {
      expect(tx(db, () => closeReadItems(db, caller(role), [{ item: id, form: "item" }], NOW))).toEqual([]);
    }
    expect(itemState(id).state).toBe("open");
    expect(readEvents()).toEqual([]);
  });

  test("an item already dismissed, or read twice, gets no second event", () => {
    const dismissed = report("finding", "one");
    db.query("UPDATE items SET state = 'dismissed', resolved_by = 'dismissed by leader' WHERE id = ?1").run(dismissed);
    const read = report("finding", "two");
    db.query("UPDATE items SET state = 'presented' WHERE id = ?1").run(read);
    const reads = [{ item: dismissed, form: "item" as const }, { item: read, form: "item" as const }, { item: read, form: "run-full" as const }];
    expect(tx(db, () => closeReadItems(db, caller("leader"), reads, NOW))).toEqual([read]);
    expect(tx(db, () => closeReadItems(db, caller("leader"), reads, NOW))).toEqual([]);
    expect(itemState(dismissed)).toEqual({ state: "dismissed", resolved_by: "dismissed by leader" });
    expect(readEvents()).toHaveLength(1);
  });
});

describe("show closes what it printed whole, for the leader", () => {
  test("show <finding item>: the whole body, closed as read, the dismiss hint gone", () => {
    const id = report("finding", "x".repeat(3_000));
    const reply = show(id, "leader");
    expect(reply.data).toMatchObject({ item: id, state: "resolved", read: `closed ${id}`, body: "x".repeat(3_000) });
    expect(reply.hints).not.toContain(`flowryn dismiss ${id}`);
    expect(itemState(id).resolved_by).toBe(READ_RESOLVED_BY);
  });

  test("a reader's and a human's show stay pure reads", () => {
    const id = report("finding", "x");
    for (const role of ["reader", "human"] as const) {
      const reply = show(id, role);
      expect(reply.data.read).toBeUndefined();
      expect(reply.hints).toContain(`flowryn dismiss ${id}`);
    }
    expect(itemState(id).state).toBe("open");
  });

  test("show <blocked item> prints it whole but leaves it open", () => {
    const id = report("blocked", "the staging cache is down");
    const reply = show(id, "leader");
    expect(reply.data).toMatchObject({ state: "open", body: "the staging cache is down" });
    expect(reply.data.read).toBeUndefined();
    expect(itemState(id).state).toBe("open");
  });

  test("show <task> without --full prints no body and closes nothing; with --full each report is printed whole and the closable ones close", () => {
    const finding = report("finding", `a long finding ${"f".repeat(500)} END`);
    const blocked = report("blocked", "waiting on the key");
    const plain = show("t-ship", "leader");
    expect(plain.data.reports).toBeUndefined();
    expect(plain.data.read).toBeUndefined();
    expect(itemState(finding).state).toBe("open");

    const full = show("t-ship", "leader", true);
    expect(full.data.reports).toEqual([
      { item: finding, status: "finding", body: `a long finding ${"f".repeat(500)} END` },
      { item: blocked, status: "blocked", body: "waiting on the key" },
    ]);
    expect(full.data.read).toBe(`closed ${finding}`);
    expect(itemState(finding).state).toBe("resolved");
    expect(itemState(blocked).state).toBe("open");
    expect(readEvents()).toEqual([expect.objectContaining({ item: finding, form: "run-full" })]);
  });

  test("show <report_ready item>: a report that fits is printed whole and closes", () => {
    const id = scoutReport("# Findings\n\nauth is fine\n");
    const reply = show(id, "leader");
    expect(reply.data).toMatchObject({ kind: "report_ready", body: "# Findings\n\nauth is fine", read: `closed ${id}`, state: "resolved" });
    expect(reply.data.truncated).toBeUndefined();
    expect(readEvents()).toEqual([{ item: id, kind: "report_ready", status: null, by: "leader", session: "L1", form: "item" }]);
  });

  test("show <report_ready item>: a cut report does not close; --full prints it whole and closes", () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const id = scoutReport(text);
    const cut = show(id, "leader");
    expect((cut.data.body as string).split("\n")).toHaveLength(60);
    expect(cut.data.truncated).toBe(`flowryn show ${id} --full for the complete text`);
    expect(cut.data.read).toBeUndefined();
    expect(cut.hints).toContain(`flowryn show ${id} --full`);
    expect(itemState(id).state).toBe("open");

    const whole = show(id, "leader", true);
    expect(whole.data.body).toBe(text);
    expect(whole.data.read).toBe(`closed ${id}`);
    expect(readEvents()).toEqual([expect.objectContaining({ item: id, form: "item-full" })]);
  });

  test("show <report_ready item>: a long line cut to fit is not a whole read", () => {
    const id = scoutReport(`one line ${"w".repeat(400)}`);
    expect(show(id, "leader").data.read).toBeUndefined();
    expect(itemState(id).state).toBe("open");
  });

  test("a report file that cannot be read prints why and closes nothing", () => {
    const id = scoutReport(null);
    const reply = show(id, "leader", true);
    expect(String(reply.data.body)).toStartWith(`- (cannot read ${join(h.home, "report.md")}: ENOENT`);
    expect(reply.data.read).toBeUndefined();
    expect(show("t-scout", "leader", true).data.read).toBeUndefined();
    expect(itemState(id).state).toBe("open");
  });

  test("show <scout task> --full prints the report whole and closes its report_ready; without --full it does neither", () => {
    const id = scoutReport("the report\nsecond line");
    const plain = show("t-scout", "leader");
    expect(plain.data.report_body).toBeUndefined();
    expect(itemState(id).state).toBe("open");
    const full = show("t-scout", "leader", true);
    expect(full.data.report_body).toBe("the report\nsecond line");
    expect(full.data.read).toBe(`closed ${id}`);
    expect(itemState(id).state).toBe("resolved");
  });
});

describe("an item closed as read is not surfaced again", () => {
  test("the turn-end relay and the briefing carry an open finding, and neither carries it once read", () => {
    const id = report("finding", "main fails its own test");
    const briefing = () => composeBriefing(db, { session: null, now: NOW, morningHour: 25, ageMs: 60 * 60_000, markMorning: false }).text;
    expect(relayBatch(db, "L1")?.items.map((i) => i.id)).toEqual([id]);
    expect(briefing()).toContain(`[${id}]`);
    show(id, "leader");
    expect(relayBatch(db, "L1")).toBeNull();
    expect(briefing()).not.toContain(`[${id}]`);
  });
});
