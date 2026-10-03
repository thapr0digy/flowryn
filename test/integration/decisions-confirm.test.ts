import { afterEach, describe, expect, test } from "bun:test";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

let ship: ShipEnv | null = null;
afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

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
});
