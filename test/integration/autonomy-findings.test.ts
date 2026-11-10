import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliJson, daemonCall, makeHome, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Unattended mode's finding rule through the real daemon and CLI
 * (docs/notes/2026-11-10-unattended-mode-decide-8k.md): under a live grant and
 * `[decisions] unattended_findings = "credential"`, a q196-shaped `ask --nomistakes`
 * (a test gate's warning whose text says "secret scan") is decided as recommended,
 * answered_via autonomous; the same words through a plain ask park; the morning
 * report names the rule and the undo, and the user's undo steers the worker again.
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
  const lines = ["run:", '  id: "01NMDEAD"', "  branch: fm/x", "  status: awaiting_approval", `  head: ${head.slice(0, 8)}`, `  head_sha: ${head}`, "gate:", `  step: ${step}`, "  status: awaiting_approval", `  findings[${rows.length}]{id,severity,file,line,action,description}:`, ...rows.map((r) => `    ${r}`), ""];
  writeFileSync(join(h.home, "nm-status"), lines.join("\n"));
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return check();
}

const QUESTION = 'no-mistakes test gate, ask-user finding test-1 (warning, test/new.test.ts), verbatim: "Live evidence is missing. The gate-questions secret scan does not fail when the daemon removes a state/owned file." Approve the test step?';

describe("unattended mode's finding rule", () => {
  test("a q196-shaped no-mistakes question is decided under the grant; the same words in a plain ask park; the report lists it with its undo", async () => {
    const h = makeHome({ extraConfig: '[projects.web]\nverify = ["true"]\n\n[decisions]\nunattended_findings = "credential"\n' });
    homes.push(h);
    daemons.push(await startDaemon(h));
    const run = seedRun(h);
    const { wt, head } = worktree(h);
    const db = h.db();
    db.query("UPDATE runs SET worktree_path = ?2 WHERE id = ?1").run(run.runId, wt);
    db.close();
    const worker = { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId };
    const ask = async (extra: string[]) => {
      const asked = await cliJson(h, ["ask", ...extra, "--options", "fix,approve,skip", "--recommend", "approve", "--why", "the evidence gap is the test runner's, not this change's", "--blocks", "the test gate of the pipeline", "--body-file", "-"], { env: worker, stdin: QUESTION });
      expect(asked.code).toBe(0);
      return (asked.reply.data as { decision: string }).decision;
    };
    const row = (id: string) => {
      const scratch = h.db();
      const r = scratch.query("SELECT state, answer, answered_by, answered_via, reserved_class, autonomy_state, nm_record IS NOT NULL AS recorded FROM decisions WHERE id = ?1").get(id) as Record<string, string | number | null>;
      scratch.close();
      return r;
    };

    parkAt(h, head, "test", ['test-1,warning,test/new.test.ts,1,ask-user,"Live evidence is missing. The gate-questions secret scan does not fail when the daemon removes a state/owned file."']);
    const gated = await ask(["--nomistakes"]);
    const plain = await ask([]);
    expect(row(gated)).toMatchObject({ state: "open", reserved_class: "credential", recorded: 1 });
    expect(row(plain)).toMatchObject({ state: "open", reserved_class: "credential", recorded: 0 });

    const begun = await daemonCall(h.home, "autonomy.begin", { projects: "web", until: "+2h" });
    expect(begun.ok).toBe(true);
    const challenge = begun.data as { challenge: string; code: string };
    expect((await daemonCall(h.home, "autonomy.confirm", { challenge: challenge.challenge, code: challenge.code, actor: "tester" })).ok).toBe(true);

    expect(await until(() => row(gated).state === "answered" && row(plain).autonomy_state === "parked", 10_000)).toBe(true);
    expect(row(gated)).toMatchObject({ answer: "approve", answered_by: "worker", answered_via: "autonomous", autonomy_state: "decided" });
    expect(row(plain)).toMatchObject({ state: "open", autonomy_state: "parked" });
    const check = h.db();
    const decided = check.query("SELECT payload FROM events WHERE kind = 'autonomy.decided'").all() as { payload: string }[];
    const parked = check.query("SELECT payload FROM events WHERE kind = 'autonomy.parked'").all() as { payload: string }[];
    const steer = check.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1").get(run.runId) as { body: string };
    check.close();
    expect(decided.map((e) => JSON.parse(e.payload))).toEqual([expect.objectContaining({ decision: gated, choice: "approve", rule: "finding-credential", classes: ["credential"] })]);
    expect(parked.map((e) => JSON.parse(e.payload))).toEqual([expect.objectContaining({ decision: plain, class: "credential", why: expect.stringContaining("no no-mistakes record") })]);
    expect(steer.body).toContain(gated);

    const back = await daemonCall(h.home, "back", {});
    expect(back.ok).toBe(true);
    const brief = (back.data as { brief: string[] }).brief.join("\n");
    expect(brief).toContain(`[${gated}]`);
    expect(brief).toContain("was credential, decided by the finding-credential rule");
    expect(brief).toContain(`undo: flowryn decide ${gated} <choice> --by captain`);

    const undone = await daemonCall(h.home, "decide", { decision: gated, choice: "fix", by: "captain", body: "fix it" });
    expect(undone.ok).toBe(true);
    expect(row(gated)).toMatchObject({ answer: "fix", answered_by: "captain" });
  });
});
