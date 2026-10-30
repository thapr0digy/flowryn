import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliJson, daemonCall, makeHome, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * Deadline defaults through the real daemon and CLI
 * (docs/notes/2026-10-30-deadline-defaults-for-gg.md): `ask --nomistakes`
 * records each question's kind, the daemon's attention tick answers an
 * opted-in one as recommended once it is due and the user is away, the
 * return brief lists it, and the user's undo steers the worker again.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

const HOUR = 3_600_000;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A worktree on fm/x off origin/main: it adds test/new.test.ts and changes line 3 of src/old.ts. */
function worktree(h: TestHome): { wt: string; head: string } {
  const wt = join(h.home, "wt");
  mkdirSync(join(wt, "src"), { recursive: true });
  git(h.home, "init", "-q", "-b", "main", wt);
  writeFileSync(join(wt, "src/old.ts"), "a\nb\nc\nd\ne\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "base");
  git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(wt, "checkout", "-qb", "fm/x");
  mkdirSync(join(wt, "test"));
  writeFileSync(join(wt, "test/new.test.ts"), "x\n");
  writeFileSync(join(wt, "src/old.ts"), "a\nb\nC\nd\ne\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "work");
  return { wt, head: git(wt, "rev-parse", "HEAD") };
}

/** The test home's stand-in no-mistakes prints $FLOWRYN_HOME/nm-status for `axi status`. */
function parkAt(h: TestHome, head: string, step: string, rows: string[]): void {
  const lines = ["run:", '  id: "01NMDEAD"', "  branch: fm/x", "  status: awaiting_approval", `  head: ${head.slice(0, 8)}`, `  head_sha: ${head}`, "gate:", `  step: ${step}`, "  status: awaiting_approval", `  findings[${rows.length}]{id,severity,file,line,action,description}:`, ...rows.map((r) => `    ${r}`), ""];
  writeFileSync(join(h.home, "nm-status"), lines.join("\n"));
}

async function setup() {
  const h = makeHome({ extraConfig: '[decisions]\ndefault_classes = ["nomistakes"]\n' });
  homes.push(h);
  daemons.push(await startDaemon(h));
  const run = seedRun(h);
  const { wt, head } = worktree(h);
  const db = h.db();
  db.query("UPDATE runs SET worktree_path = ?2 WHERE id = ?1").run(run.runId, wt);
  db.close();
  const worker = { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId };
  const ask = async (question: string, extra: string[] = []) => {
    const asked = await cliJson(h, ["ask", "--nomistakes", "--options", "fix,approve,skip", "--recommend", "fix", "--blocks", "the gate of the pipeline", ...extra, "--body-file", "-"], { env: worker, stdin: question });
    expect(asked.code).toBe(0);
    return (asked.reply.data as { decision: string }).decision;
  };
  const row = (id: string) => {
    const scratch = h.db();
    const r = scratch.query("SELECT state, answer, answered_by, answered_via, reserved_class FROM decisions WHERE id = ?1").get(id) as Record<string, string | null>;
    scratch.close();
    return r;
  };
  const backdate = (...ids: string[]) => {
    const scratch = h.db();
    for (const id of ids) scratch.query("UPDATE decisions SET created_at = created_at - ?2 WHERE id = ?1").run(id, 5 * HOUR);
    scratch.close();
  };
  return { h, run, head, ask, row, backdate };
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return check();
}

describe("deadline defaults", () => {
  test("ask records the kind: no rule is nomistakes, a floor is nomistakes-floor, unread facts nomistakes-unread, the worker's own reason none", async () => {
    const { h, head, ask, row } = await setup();
    parkAt(h, head, "lint", ['lint-1,warning,src/old.ts,1,ask-user,"unused import"']);
    expect(row(await ask("lint-1 in a touched file"))).toMatchObject({ state: "open", reserved_class: "nomistakes" });
    parkAt(h, head, "review", ['r-2,warning,src/elsewhere.ts,9,ask-user,"pre-existing"']);
    expect(row(await ask("r-2 outside the diff"))).toMatchObject({ reserved_class: "nomistakes-floor" });
    parkAt(h, head, "lint", ['lint-2,error,src/old.ts,3,ask-user,"type error"']);
    expect(row(await ask("an error finding"))).toMatchObject({ reserved_class: "nomistakes-floor" });
    parkAt(h, head, "lint", ['lint-3,warning,src/old.ts,1,ask-user,"unused"']);
    expect(row(await ask("worker reserved it", ["--reserved", "a scope call"]))).toMatchObject({ reserved_class: null });
    writeFileSync(join(h.home, "nm-status"), "");
    expect(row(await ask("nothing parked"))).toMatchObject({ reserved_class: "nomistakes-unread" });
  });

  test("away: the due opted-in question is answered via deadline and steered, the floored one waits, the brief lists it, the user's undo steers again", async () => {
    const { h, run, head, ask, row, backdate } = await setup();
    parkAt(h, head, "lint", ['lint-1,warning,src/old.ts,1,ask-user,"unused import"']);
    const eligible = await ask("lint-1 in a touched file");
    parkAt(h, head, "review", ['r-2,warning,src/elsewhere.ts,9,ask-user,"pre-existing"']);
    const floored = await ask("r-2 outside the diff");
    backdate(eligible, floored);

    // Present: nothing is taken, however old.
    await Bun.sleep(2_000);
    expect(row(eligible).state).toBe("open");

    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => row(eligible).state === "answered")).toBe(true);
    expect(row(eligible)).toMatchObject({ answer: "fix", answered_by: "policy", answered_via: "deadline" });
    expect(row(floored).state).toBe("open");
    const db = h.db();
    const steer = db.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1").get(run.runId) as { body: string };
    expect(steer.body).toContain(`Answer to your question ${eligible}`);
    expect(steer.body).toContain(": fix.");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE decision_id = ?1 AND state IN ('open','presented')").get(eligible)).toEqual({ n: 0 });
    db.close();

    const back = await daemonCall(h.home, "back", {});
    expect(back.ok).toBe(true);
    const brief = (back.data as { brief: string[] }).brief.join("\n");
    expect(brief).toContain("Decided for you (1):");
    expect(brief).toContain(`undo: flowryn decide ${eligible} <choice> --by captain`);

    const undone = await daemonCall(h.home, "decide", { decision: eligible, choice: "approve", by: "captain", body: "leave it" });
    expect(undone.ok).toBe(true);
    expect(row(eligible)).toMatchObject({ answer: "approve", answered_by: "captain", answered_via: "shell" });
    const after = h.db();
    const undoSteer = after.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1").get(run.runId) as { body: string };
    after.close();
    expect(undoSteer.body).toContain("from fix (deadline) to approve");
    expect(undoSteer.body).toContain("the deadline default's answer");
  });
});
