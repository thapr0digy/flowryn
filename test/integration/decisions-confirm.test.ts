import { afterEach, describe, expect, test } from "bun:test";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

let ship: ShipEnv | null = null;
afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

/** A command's stdout may carry more than one JSON reply (a `tooMany` line runs every sub-command); the last line is the one that matters. */
function lastJson(stdout: string): { ok: boolean; data?: unknown; error?: { code: string } } {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
}

describe("a captain answer needs the user's word", () => {
  test("Claude: the prompt shows the decision and the answer; declined or bypassed, nothing is recorded", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const added = await f.json(["decision", "add", "--key", "drop", "--question", "Delete the old evidence bucket?", "--body-file", "-"], { ...token, stdin: "Frees 2 TB." });
    const { decision } = added.reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();
    // start() claims the lease and rotates its token: read it again.
    const lt = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --body-file - --json <<'EOF'\nyes, delete it\nEOF`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });
    expect(leader.prompts.at(-1)).toContain(`RECORD as the user's own answer to ${decision}`);
    const yes = await leader.runBash(`flowryn decide ${decision} yes --by captain --body-file - --json <<'EOF'\nyes, delete it\nEOF`, { approve: true });
    expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
    expect(JSON.parse(yes.stdout).data).toMatchObject({ decision, by: "captain" });
    const shown = await f.json(["show", decision], lt);
    expect(shown.reply.data).toMatchObject({ by: "captain", via: "claude-ask", rationale: "yes, delete it" });
  });

  test("Claude: undoing a rule's answer is prompted as an undo, and recorded as the user's (docs/notes/2026-10-22-settle-routine-no-2r.md)", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const { task, run } = await f.dispatch("Build\nFAKE: sleep 60000");
    const db = f.h.db();
    db.query(
      `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, answer, answered_via, answered_at, answered_by, rationale, created_at)
       VALUES ('q900', ?1, ?2, 'lint-1 in test/new.test.ts', '["approve","fix","skip"]', 0, 'answered', 'fix', 'rule:lint-warning-added', 1, 'policy', 'Settled by rule lint-warning-added', 1)`,
    ).run(task, run);
    db.close();
    const leader = await ship.claude();
    await leader.start();
    const yes = await leader.runBash("flowryn decide q900 approve --by captain --body-file - --json <<'EOF'\nkeep the import\nEOF", { approve: true });
    expect(leader.prompts.at(-1)).toContain("UNDO the rule's answer fix (rule:lint-warning-added) to q900");
    expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
    const shown = await f.json(["show", "q900"], { env: { FLOWRYN_TOKEN: ship.leaderToken() } });
    expect(shown.reply.data).toMatchObject({ by: "captain", via: "claude-ask", answer: "approve" });
  });

  test("without a prompt (bypassPermissions, or a plain call) a captain answer is refused", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "k", "--question", "Revoke the old token?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();
    leader.permissionMode = "bypassPermissions";
    const bypass = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: true });
    expect(bypass.code).toBe(2);
    expect(JSON.parse(bypass.stdout).error.code).toBe("approval_required");
    const plain = await f.json(["decide", decision, "yes", "--by", "captain"], { env: { FLOWRYN_TOKEN: ship.leaderToken() } });
    expect((plain.reply as { error: { code: string } }).error.code).toBe("approval_required");
  });

  test("your own shell is the user's word", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const { decision } = (await ship.fleet.json(["decision", "add", "--key", "k", "--question", "Revoke the old token?", "--body-file", "-"], { env: { FLOWRYN_TOKEN: ship.leaderToken() }, stdin: "x" })).reply.data as { decision: string };
    const reply = await ship.call("decide", { decision, choice: "yes", body: "revoke it" });
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ by: "captain" });
  });

  test("a human's --rationale is not dropped: decide records it as the answer's words", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "k-rationale", "--question", "Keep the old logs?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const reply = await ship.call("decide", { decision, choice: "yes", rationale: "keep for the audit" });
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ by: "captain" });
    const shown = await f.json(["show", decision], { env: { FLOWRYN_TOKEN: ship.leaderToken() } });
    expect(shown.reply.data).toMatchObject({ by: "captain", rationale: "keep for the audit" });
  });

  // SHELL_GATE (the extension's shell block) cannot be unit-tested by importing the extension module
  // directly: it is a `with { type: "file" }` asset, and a second, dynamic import of the same path
  // breaks that asset resolution elsewhere in the same test process. Drive it through the real
  // extension instead, the way the merge and gate-pass shell gates are tested (m4-exit.test.ts, m5-exit.test.ts).
  test("Pi: the shell is blocked, the flowryn_decide tool shows the question and answer; no leaves it open, yes records it", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "pi-k", "--question", "Rotate the signing key?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const { decision: other } = (await f.json(["decision", "add", "--key", "pi-k2", "--question", "Rotate the backup key too?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.pi();
    await leader.start();
    const lt = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };

    expect((await leader.bash(`flowryn decide ${decision} yes --by captain`)).blocked).toBe(true);
    expect((await leader.bash(`flowryn decide ${decision} yes --by=captain`)).blocked).toBe(true);
    // A leader answer (no --by captain) is not shell-gated; it runs and answers it itself.
    expect((await leader.bash(`flowryn decide ${other} yes --rationale fine`)).blocked).toBe(false);

    const no = await leader.callTool("flowryn_decide", { decision, choice: "yes", words: "go ahead" }, false);
    expect(no).toContain("declined");
    expect(leader.confirms.at(-1)!.message).toContain("Rotate the signing key?");
    expect(leader.confirms.at(-1)!.message).toContain("your words: go ahead");

    const yes = await leader.callTool("flowryn_decide", { decision, choice: "yes", words: "go ahead" }, true);
    expect(yes).toContain(`Recorded your answer to ${decision}`);
    const shown = await f.json(["show", decision], lt);
    expect(shown.reply.data).toMatchObject({ by: "captain", via: "pi-confirm", answer: "yes" });
  });

  test("Claude: an alt spelling is prompted too, not silently run; under bypass it is refused", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "alt", "--question", "Rotate the deploy key?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });
    // The `--by=captain` spelling must be gated and prompted too; it is not silently run.
    const altNo = await leader.runBash(`flowryn decide ${decision} yes --by=captain --json`, { approve: false });
    expect(altNo).toMatchObject({ prompted: true, ran: false });
    const lt = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    expect((await f.json(["show", decision], lt)).reply.data).toMatchObject({ state: "open" });

    // Even approved, under bypassPermissions no attempt is ever trusted.
    leader.permissionMode = "bypassPermissions";
    const altBypass = await leader.runBash(`flowryn decide ${decision} yes --by=captain --json`, { approve: true });
    expect(altBypass.code).toBe(2);
    expect(JSON.parse(altBypass.stdout).error.code).toBe("approval_required");
  });

  test("an attempt for one decision cannot answer another, and answering it twice refuses the second time", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision: d1 } = (await f.json(["decision", "add", "--key", "cross-1", "--question", "Rotate key A?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const { decision: d2 } = (await f.json(["decision", "add", "--key", "cross-2", "--question", "Rotate key B?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    // An attempt is recorded for d1 only (declined, so it stays unmatched).
    await leader.runBash(`flowryn decide ${d1} yes --by captain --json`, { approve: false });
    // A direct captain answer to d2 has no attempt of its own: d1's cannot cross decisions.
    const wrong = await ship.call("decide", { decision: d2, choice: "yes", by: "captain" }, ship.leaderToken());
    expect(wrong.error?.code).toBe("approval_required");

    // d1's own gated answer succeeds.
    const yes = await leader.runBash(`flowryn decide ${d1} yes --by captain --json`, { approve: true });
    expect(yes).toMatchObject({ ran: true, code: 0 });

    // A second captain answer to the now-answered d1 is refused: the decision is no longer open.
    const again = await leader.runBash(`flowryn decide ${d1} yes --by captain --json`, { approve: true });
    expect(again.code).not.toBe(0);
    expect(JSON.parse(again.stdout).error.code).toBe("bad_args");
    // The "no open decision" prompt names the literal command, not just the id.
    expect(leader.prompts.at(-1)).toContain(`flowryn decide ${d1} yes --by captain --json`);
  });

  test("a declined attempt cannot be replayed through a tooMany line: it records none of its own", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "toomany", "--question", "Rotate key C?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} no --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });

    // Two captain decides on one line: gated and prompted, but neither gets an attempt of its own,
    // so neither can answer the decision, no matter what a stale attempt from the declined prompt
    // above might otherwise still let through.
    const tooManyCommand = `flowryn decide ${decision} yes --by captain --json; flowryn decide ${decision} yes --by captain --json`;
    const tooMany = await leader.runBash(tooManyCommand, { approve: true });
    expect(tooMany).toMatchObject({ prompted: true, ran: true });
    // The refusal prompt names the literal command, not just "too many" with no detail.
    expect(leader.prompts.at(-1)).toContain(tooManyCommand);
    const lt = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    expect((await f.json(["show", decision], lt)).reply.data).toMatchObject({ state: "open" });
  });

  test("a declined attempt cannot be replayed by a spelling the gate cannot see (mid-word quoting)", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "capquote", "--question", "Rotate key D?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });

    // cap''tain is "captain" once the shell evaluates it, but the raw text has no contiguous
    // "captain" for the gate to see: it is never prompted, and runs straight through.
    const alt = await leader.runBash(`flowryn decide ${decision} yes --by cap''tain --json`, { approve: true });
    expect(alt).toMatchObject({ prompted: false, ran: true });
    expect(lastJson(alt.stdout).error?.code).toBe("approval_required");
    const lt = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    expect((await f.json(["show", decision], lt)).reply.data).toMatchObject({ state: "open" });
  });

  test("a declined attempt is voided by the very next Bash call, even an unrelated one", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "unrelated", "--question", "Rotate key E?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });

    // An unrelated Bash call in between (an allowed, non-captain flowryn command): it is not gated,
    // but it still voids the stale attempt.
    const unrelated = await leader.runBash("flowryn fleet --json", { approve: true });
    expect(unrelated).toMatchObject({ prompted: false, ran: true, code: 0 });

    // The gate-blind alt spelling (which would otherwise have to do its own voiding) now has
    // nothing left to find even if it ran as the very first replay attempt.
    const alt = await leader.runBash(`flowryn decide ${decision} yes --by cap''tain --json`, { approve: true });
    expect(alt).toMatchObject({ prompted: false, ran: true });
    expect(lastJson(alt.stdout).error?.code).toBe("approval_required");
  });

  test("a declined attempt is voided by a non-Bash tool call, not only by Bash", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "monitor", "--question", "Rotate key F?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });

    // A non-Bash tool (Monitor, Read, PowerShell where enabled): not covered by the Bash(...) ask
    // rules at all, but its PreToolUse still fires and must still void the stale attempt.
    await leader.hook("PreToolUse", { tool_name: "Monitor", tool_input: {} }, "*");

    // The attempt is gone before any shell line ever gets a chance to replay it: a direct call with
    // the leader's own token (as if it somehow ran unprompted) is refused.
    const reply = await ship.call("decide", { decision, choice: "yes", by: "captain" }, ship.leaderToken());
    expect(reply.error?.code).toBe("approval_required");
  });

  test("a declined attempt is voided at Stop, when the decline ends the turn", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const f = ship.fleet;
    const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
    const { decision } = (await f.json(["decision", "add", "--key", "stopvoid", "--question", "Rotate key G?", "--body-file", "-"], { ...token, stdin: "x" })).reply.data as { decision: string };
    const leader = await ship.claude();
    await leader.start();

    const no = await leader.runBash(`flowryn decide ${decision} yes --by captain --json`, { approve: false });
    expect(no).toMatchObject({ prompted: true, ran: false });

    // The turn ends here (a decline with nothing else to do): Stop must void the stale attempt too,
    // not leave it live until whatever Bash call happens to come next.
    await leader.hook("Stop", {});

    const reply = await ship.call("decide", { decision, choice: "yes", by: "captain" }, ship.leaderToken());
    expect(reply.error?.code).toBe("approval_required");
  });
});
