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
    const tooMany = await leader.runBash(`flowryn decide ${decision} yes --by captain --json; flowryn decide ${decision} yes --by captain --json`, { approve: true });
    expect(tooMany).toMatchObject({ prompted: true, ran: true });
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
});
