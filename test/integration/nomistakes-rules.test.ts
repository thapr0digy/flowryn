import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliJson, daemonCall, makeHome, seedLeader, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * `ask --nomistakes` through the real daemon and CLI (docs/notes/2026-10-22-settle-routine-no-2r.md):
 * a gate the default rules cover is settled at once with its steer and no
 * item; any other is reserved for the user; the briefing lists what a rule
 * settled, and only the user may undo it, while the run is live.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

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
  const lines = ["run:", '  id: "01NMRULES"', "  branch: fm/x", "  status: awaiting_approval", `  head: ${head.slice(0, 8)}`, `  head_sha: ${head}`, "gate:", `  step: ${step}`, "  status: awaiting_approval", `  findings[${rows.length}]{id,severity,file,line,action,description}:`, ...rows.map((r) => `    ${r}`), ""];
  writeFileSync(join(h.home, "nm-status"), lines.join("\n"));
}

async function setup() {
  const h = makeHome();
  homes.push(h);
  daemons.push(await startDaemon(h));
  const run = seedRun(h);
  const { wt, head } = worktree(h);
  const db = h.db();
  db.query("UPDATE runs SET worktree_path = ?2 WHERE id = ?1").run(run.runId, wt);
  db.close();
  const worker = { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId };
  const ask = (blocks: string, question: string, options = "approve,fix,skip") => cliJson(h, ["ask", "--nomistakes", "--options", options, "--blocks", blocks, "--body-file", "-"], { env: worker, stdin: question });
  return { h, run, head, ask };
}

describe("ask --nomistakes", () => {
  test("a lint warning in a file the branch added is settled by rule: answered by policy, steered, no item, listed in the briefing, undone only by the user", async () => {
    const { h, run, head, ask } = await setup();
    parkAt(h, head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"unused import; the lint pass may not edit tests"']);
    const asked = await ask("the lint gate of the pipeline", "lint-1, warning, test/new.test.ts, ask-user: unused import");
    expect(asked.code).toBe(0);
    const data = asked.reply.data as { decision: string; answered: string; rule: string; steer: string };
    expect(data).toMatchObject({ answered: "fix", rule: "lint-warning-added" });
    expect(data.steer).toMatch(/^m\d+$/);

    let db = h.db();
    const row = db.query("SELECT state, answer, answered_by, answered_via, reserved_reason, rationale FROM decisions WHERE id = ?1").get(data.decision) as Record<string, string | null>;
    expect(row).toMatchObject({ state: "answered", answer: "fix", answered_by: "policy", answered_via: "rule:lint-warning-added", reserved_reason: null });
    expect(row.rationale).toContain("lint-1 (warning, test/new.test.ts, added)");
    const steer = db.query("SELECT body FROM messages WHERE id = ?1").get(data.steer) as { body: string };
    expect(steer.body).toContain("no-mistakes axi respond --action fix --findings lint-1");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE decision_id = ?1").get(data.decision)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'decision.settled_by_rule'").get()).toEqual({ n: 1 });
    db.close();

    const leader = { FLOWRYN_TOKEN: seedLeader(h) };
    const brief = await cliJson(h, ["brief"], { env: leader });
    const lines = (brief.reply.data as { briefing: string[] }).briefing;
    expect(lines.some((l) => l.startsWith("Settled by rule since the last briefing (1; undo: flowryn decide <id> <choice> --by captain)"))).toBe(true);
    expect(lines.some((l) => l.startsWith(`- [${data.decision}]`) && l.includes("→ fix (rule:lint-warning-added)"))).toBe(true);

    const byLeader = await cliJson(h, ["decide", data.decision, "approve", "--rationale", "I prefer it"], { env: leader });
    expect(byLeader.code).not.toBe(0);
    expect(JSON.stringify(byLeader.reply)).toContain("only the user may change it");

    // Your own terminal is the user's word (channel tty).
    const undone = await daemonCall(h.home, "decide", { decision: data.decision, choice: "approve", by: "captain", body: "leave the import" });
    expect(undone.ok).toBe(true);
    db = h.db();
    const after = db.query("SELECT answer, answered_by, answered_via, rationale FROM decisions WHERE id = ?1").get(data.decision) as Record<string, string>;
    expect(after).toMatchObject({ answer: "approve", answered_by: "captain", answered_via: "shell" });
    expect(after.rationale).toBe("(undid fix (rule:lint-warning-added))\nleave the import");
    const undoSteer = db.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1").get(run.runId) as { body: string };
    expect(undoSteer.body).toContain("from fix (rule:lint-warning-added) to approve");
    expect(undoSteer.body).toContain("git revert");
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'decision.overridden'").get()).toEqual({ n: 1 });
    db.close();

    // Once the user has answered, it is no longer a rule's answer: a second decide refuses.
    const again = await daemonCall(h.home, "decide", { decision: data.decision, choice: "fix", by: "captain" });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again)).toContain("already answered");
  });

  test("a review warning outside the branch's diff is reserved for the user, with an item and the reason", async () => {
    const { h, head, ask } = await setup();
    parkAt(h, head, "review", ['r-1,warning,src/old.ts,3,ask-user,"tighten"', 'r-2,warning,src/elsewhere.ts,9,ask-user,"pre-existing"']);
    const asked = await ask("the review gate of the pipeline", "two review findings");
    expect(asked.code).toBe(0);
    const data = asked.reply.data as { decision: string; reserved: string; answered?: string };
    expect(data.answered).toBeUndefined();
    expect(data.reserved).toBe("nomistakes: r-2 is outside the diff");
    const db = h.db();
    expect(db.query("SELECT state, answered_by, reserved_reason FROM decisions WHERE id = ?1").get(data.decision)).toEqual({ state: "open", answered_by: null, reserved_reason: "nomistakes: r-2 is outside the diff" });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE decision_id = ?1").get(data.decision)).toEqual({ n: 1 });
    db.close();
    const leader = { FLOWRYN_TOKEN: seedLeader(h) };
    const byLeader = await cliJson(h, ["decide", data.decision, "fix", "--rationale", "looks fine"], { env: leader });
    expect(JSON.stringify(byLeader.reply)).toContain("reserved for the user");
  });

  test("a ci gate, an options list without the rule's answer, and no parked gate are each the user's", async () => {
    const { h, head, ask } = await setup();
    parkAt(h, head, "ci", ['ci-1,warning,test/new.test.ts,1,ask-user,"flaky check"']);
    expect(((await ask("the ci gate of the pipeline", "ci finding")).reply.data as { reserved: string }).reserved).toBe("nomistakes: ci gate");
    parkAt(h, head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"unused"']);
    expect(((await ask("the lint gate of the pipeline", "lint finding", "accept,live-run-first")).reply.data as { reserved: string }).reserved).toBe("nomistakes: the rules' answer fix is not one of the options");
    writeFileSync(join(h.home, "nm-status"), "");
    expect(((await ask("the lint gate of the pipeline", "lint finding")).reply.data as { reserved: string }).reserved).toBe("nomistakes: no parked gate of this worktree's run");
  });

  test("a rule's answer cannot be undone once its run is over", async () => {
    const { h, run, head, ask } = await setup();
    parkAt(h, head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"unused"']);
    const { decision } = (await ask("the lint gate of the pipeline", "lint finding")).reply.data as { decision: string };
    const db = h.db();
    db.query("UPDATE runs SET state = 'cancelled', ended_at = ?2 WHERE id = ?1").run(run.runId, Date.now());
    db.close();
    const undone = await daemonCall(h.home, "decide", { decision, choice: "approve", by: "captain" });
    expect(undone.ok).toBe(false);
    expect(JSON.stringify(undone)).toContain("its run is over");
  });

  test("an ask without --nomistakes is unchanged: never settled, never reserved by the rules", async () => {
    const { h, run, head } = await setup();
    parkAt(h, head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"unused"']);
    const asked = await cliJson(h, ["ask", "--options", "approve,fix,skip", "--blocks", "the lint gate of the pipeline", "--body-file", "-"], { env: { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId }, stdin: "lint finding" });
    expect(asked.code).toBe(0);
    const db = h.db();
    expect(db.query("SELECT state, answered_by, reserved_reason FROM decisions WHERE id = ?1").get((asked.reply.data as { decision: string }).decision)).toEqual({ state: "open", answered_by: null, reserved_reason: null });
    db.close();
  });
});
