import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { interruptRun, type ControlDeps } from "../../src/lifecycle/control.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { createSteer, dueSteers, getMessage, markRung, SteerBus } from "../../src/lifecycle/steers.ts";
import { parsePsLine } from "../../src/runtime/proc.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";

/**
 * The Claude interrupt is the one keystroke Flowryn sends, and Escape on a
 * permission dialog declines it: the key must never go while a dialog may be
 * open. A verified interrupt also loses what it carried unseen and wakes the
 * waiter, so an idle steer goes at once.
 */

/** The worker's process as a stand-in ps reports it, alive throughout. */
const PS_LINE = "4242 Sun Oct  4 10:00:00 2026 claude";

let dir: string;
let db: Db;
let transcript: string;
let keys: string[];
let status: string | null;
/** Herdr's status reads in order; once used up, `status` holds. */
let statusReads: (string | null)[];
let screen: string | null;
let bus: SteerBus;

function deps(): ControlDeps {
  const runtime = {
    agentStatus: async () => (statusReads.length > 0 ? statusReads.shift()! : status),
    readPane: async () => screen,
    sendInterrupt: async (pane: string) => {
      keys.push(pane);
      // The worker's transcript records the interrupt at once (M0 c04).
      appendFileSync(transcript, `${JSON.stringify({ type: "user", message: "[Request interrupted by user for tool use]" })}\n`);
    },
  } as unknown as HerdrRuntime;
  return { db, runtime: () => runtime, bus, timing: () => DEFAULT_TIMING, now: () => Date.now(), ps: async () => PS_LINE, secondReadMs: 20 };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-int-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, "");
  keys = [];
  status = "working";
  statusReads = [];
  screen = "$ perl -e 'sleep 60'";
  bus = new SteerBus();
  const me = parsePsLine(PS_LINE)!;
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'scout', 'local-only', 0, 'scout', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at,
         pane_id, proc_pid, proc_start, proc_exe, transcript_path, busy_until)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'scout', 'investigate', '/w', 'b', 's', 'h', 0, 0, 'w1:p1', ?1, ?2, ?3, ?4, ?5)`,
    ).run(me.pid, me.start, me.exe, transcript, Date.now() + 600_000);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function refusals(): string[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'run.interrupt_refused'").all() as { payload: string }[]).map((e) => String(JSON.parse(e.payload).reason));
}

describe("the Claude interrupt key never answers a dialog", () => {
  test("Herdr reading blocked refuses the interrupt and sends no key", async () => {
    status = "blocked";
    const result = await interruptRun(deps(), "r1", 1_000);
    expect(result).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
    expect(refusals()[0]).toContain("blocked on a dialog");
  });

  test("an open blocked_prompt item refuses it even while Herdr reads working", async () => {
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: 0 }, Date.now()));
    const result = await interruptRun(deps(), "r1", 1_000);
    expect(result).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
  });

  test.each([["unknown"], [null], ["idle"]])("Herdr reading %p is not working: refused, no key", async (read) => {
    status = read as string | null;
    expect(await interruptRun(deps(), "r1", 1_000)).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
  });

  test("Herdr unreadable refuses rather than guessing", async () => {
    const d = deps();
    const runtime = d.runtime()!;
    (runtime as unknown as { agentStatus: () => Promise<string> }).agentStatus = async () => {
      throw new Error("socket closed");
    };
    expect(await interruptRun(d, "r1", 1_000)).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
  });

  test("a dialog that opened just before the first read: the second read sees blocked, so no key", async () => {
    statusReads = ["working", "blocked"];
    expect(await interruptRun(deps(), "r1", 1_000)).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
    expect(refusals()[0]).toContain("blocked on a dialog");
  });

  test("the screen shows a dialog's question while Herdr still reads working: no key", async () => {
    screen = "Bash command\n  git commit --amend\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    expect(await interruptRun(deps(), "r1", 1_000)).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
    expect(refusals()[0]).toContain("confirmation dialog");
  });

  test("the screen unreadable refuses rather than guessing", async () => {
    screen = null;
    expect(await interruptRun(deps(), "r1", 1_000)).toMatchObject({ ok: false, evidence: "refused" });
    expect(keys).toEqual([]);
  });

  test("working: the key goes, verified by the transcript; an unseen carry is lost and the waiter wakes", async () => {
    const carried = tx(db, () => createSteer(db, getRun(db, "r1")!, "carried, never read", Date.now()));
    tx(db, () => markRung(db, carried, getRun(db, "r1")!, "post-tool", Date.now(), false, DEFAULT_TIMING));
    expect(dueSteers(db, "r1", Date.now(), DEFAULT_TIMING)).toEqual([]);
    bus.register("r1", "01W");
    const woken = bus.wait("r1", "01W", 60_000);
    const result = await interruptRun(deps(), "r1", 5_000);
    expect(result).toMatchObject({ ok: true, evidence: "transcript" });
    expect(keys).toEqual(["w1:p1"]);
    expect(await woken).toBe("wake");
    expect(getMessage(db, carried.id)!.ring_state).toBe("lost");
    expect(dueSteers(db, "r1", Date.now(), DEFAULT_TIMING).map((m) => m.id)).toEqual([carried.id]);
    expect(getRun(db, "r1")!.busy_until).toBeNull();
  });
});
