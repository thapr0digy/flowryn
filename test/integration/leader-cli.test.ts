import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_PERMISSIONS } from "../../src/bridges/claude/settings.ts";
import { writeLeaderFiles } from "../../src/bridges/files.ts";
import { SKILL_DESCRIPTION } from "../../src/bridges/skill.ts";
import { claudeLeaderArgs, leaderEnv, piLeaderArgs } from "../../src/cli/commands/lead.ts";
import { STYLE_BLOCK } from "../../src/harness/contract-text.ts";
import { localDate } from "../../src/lifecycle/dates.ts";
import { cli, cliJson, readText, REPO_ROOT } from "../helpers/harness.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe("flowryn lead", () => {
  test("writes the leader files: settings with the leader hooks and permissions, the skill, the extension, the style block", async () => {
    env = await makeLeaderEnv();
    const { files } = env;
    const settings = JSON.parse(readFileSync(files.claudeSettings, "utf8"));
    expect(settings.permissions).toEqual({ allow: [...LEADER_PERMISSIONS.allow], ask: [...LEADER_PERMISSIONS.ask], deny: [...LEADER_PERMISSIONS.deny] });
    expect(settings.permissions.deny).toEqual(["Bash(flowryn approve*)", "Bash(flowryn hook *)"]);
    expect(Object.keys(settings.hooks).toSorted()).toEqual(["Notification", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
    for (const event of ["SessionStart", "Stop"]) {
      const waiter = settings.hooks[event][0].hooks.find((h: { asyncRewake?: boolean }) => h.asyncRewake);
      expect(waiter).toMatchObject({ asyncRewake: true, timeout: 28_800 });
      expect(waiter.command).toContain("hook wait-p0 --harness claude");
    }
    expect(settings.hooks.Notification[0].matcher).toBe("idle_prompt|quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled");
    expect(settings.sandbox.network.allowUnixSockets).toEqual([join(env.h.home, "run", "flowrynd.sock")]);
    expect(readFileSync(join(files.claudePlugin, ".claude-plugin", "plugin.json"), "utf8")).toContain('"name": "flowryn-leader"');
    expect(readFileSync(join(files.skillDir, "SKILL.md"), "utf8")).toStartWith("---\nname: flowryn\n");
    // The skill description is always loaded: about 60 tokens at most (design section 12).
    expect(SKILL_DESCRIPTION.split(/\s+/).length).toBeLessThanOrEqual(45);
    expect(readFileSync(files.piExtension, "utf8")).toContain("export default function flowrynLeader");
    expect(readFileSync(files.appendPrompt!, "utf8")).toBe(STYLE_BLOCK + "\n");
    expect(statSync(files.bin).mode & 0o777).toBe(0o700);
  });

  test("the append prompt carries the style block and the user's preferences, and preferences survive terse = false", async () => {
    const home = mkdtempSync(join(tmpdir(), "fw-"));
    mkdirSync(join(home, "leader"), { recursive: true });
    writeFileSync(join(home, "leader", "preferences.md"), "# Your preferences\n- Decide autonomously.\n");
    const on = await writeLeaderFiles({ home, command: ["flowryn"], socket: "/tmp/s", style: "Be terse." });
    expect(readFileSync(on.appendPrompt!, "utf8")).toBe("Be terse.\n\n# Your preferences\n- Decide autonomously.\n");
    const off = await writeLeaderFiles({ home, command: ["flowryn"], socket: "/tmp/s", style: null });
    expect(readFileSync(off.appendPrompt!, "utf8")).toBe("# Your preferences\n- Decide autonomously.\n");
    expect(readFileSync(join(home, "leader", "preferences.md"), "utf8")).toContain("Decide autonomously");
    expect(claudeLeaderArgs(off, [])).toContain(off.appendPrompt!);
  });

  test("launches Claude in auto mode with --settings and the plugin, Pi with -e and --skill; your args go last", async () => {
    env = await makeLeaderEnv();
    const { files } = env;
    expect(claudeLeaderArgs(files, ["--model", "haiku"])).toEqual([
      "--settings",
      files.claudeSettings,
      "--permission-mode",
      "auto",
      "--plugin-dir",
      files.claudePlugin,
      "--append-system-prompt-file",
      files.appendPrompt!,
      "--model",
      "haiku",
    ]);
    expect(piLeaderArgs(files, ["--model", "x/y"])).toEqual(["-e", files.piExtension, "--skill", files.skillDir, "--append-system-prompt", files.appendPrompt!, "--model", "x/y"]);
    const launched = leaderEnv({ PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", FLOWRYN_RUN: "r1", HOME: "/h" }, { token: "fwl_x", session: "L7", files, inactiveMs: 60_000 });
    expect(launched).toMatchObject({ FLOWRYN_TOKEN: "fwl_x", FLOWRYN_LEADER_SESSION: "L7", FLOWRYN_BIN: files.bin, PATH: `${files.binDir}:/usr/bin`, HOME: "/h" });
    expect(launched.CLAUDECODE).toBeUndefined();
    expect(launched.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(launched.FLOWRYN_RUN).toBeUndefined();
  });

  test("runs only in your own terminal", async () => {
    env = await makeLeaderEnv();
    // Words after -- belong to the harness, --json included; flowryn's own flags go before it.
    const result = await cli(env.h, ["lead", "--json", "--", "--model", "haiku", "--json"]);
    expect(result.code).toBe(77);
    expect(JSON.parse(result.stdout).error.code).toBe("human_only");
  });
});

describe("leader verbs", () => {
  test("brief, fleet, dismiss, leader status and leader claim through the CLI", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const a = await e.openSession("claude");
    const b = await e.openSession("pi");
    await e.call("hook.session-start", { harness: "claude", input: JSON.stringify({ source: "startup" }) }, a.token);
    const question = await e.openP1("which colour?");
    const brief = await cliJson(e.h, ["brief"], { env: { FLOWRYN_TOKEN: a.token } });
    expect((brief.reply.data as { briefing: string[] }).briefing).toContain(`- [${question}] Worker question q1 on web-billing-q4: "which colour?" [yes | no] blocks: the next step of the task`);
    const readOnly = await cliJson(e.h, ["brief"], { env: { FLOWRYN_TOKEN: b.token } });
    expect((readOnly.reply.data as { briefing: string[] }).briefing[0]).toContain("read-only: leader is claude");
    const fleet = await cliJson(e.h, ["fleet"], { env: { FLOWRYN_TOKEN: b.token } });
    expect((fleet.reply.data as { needs: { id: string }[] }).needs.map((n) => n.id)).toEqual([question]);
    const refused = await cliJson(e.h, ["dismiss", question], { env: { FLOWRYN_TOKEN: b.token } });
    expect(refused.code).toBe(77);
    expect((refused.reply.error as { code: string; help: string }).help).toBe("flowryn leader claim");
    const dismissed = await cliJson(e.h, ["dismiss", question], { env: { FLOWRYN_TOKEN: a.token } });
    expect(dismissed.reply.data).toMatchObject({ item: question, state: "dismissed", decision: "q1" });
    expect(e.withDb((db) => db.query("SELECT state FROM decisions WHERE id = 'q1'").get())).toEqual({ state: "dismissed" });
    expect(e.withDb((db) => (db.query("SELECT body FROM messages ORDER BY created_at DESC LIMIT 1").get() as { body: string }).body)).toContain("question q1 was dismissed");
    const status = await cliJson(e.h, ["leader", "status"], { env: { FLOWRYN_TOKEN: b.token } });
    expect(status.reply.data).toMatchObject({ lease: { session: a.session, harness: "claude", epoch: 1 }, you: b.session });
    const claimed = await cliJson(e.h, ["leader", "claim"], { env: { FLOWRYN_TOKEN: b.token } });
    expect(claimed.reply.data).toMatchObject({ session: b.session, epoch: 2, previous: a.session });
    expect((await cliJson(e.h, ["dismiss", "i999"], { env: { FLOWRYN_TOKEN: a.token } })).code).toBe(77);
  });

  test("board --once prints a frame from the database; it refuses an agent pane", async () => {
    env = await makeLeaderEnv();
    await env.openP0("the migration stopped");
    const frame = await cli(env.h, ["board", "--once"]);
    expect(frame.code).toBe(0);
    expect(frame.stdout).toContain("Flowryn board");
    expect(frame.stdout).toContain("NEEDS YOU (1)");
    expect(frame.stdout).toContain("Worker cannot finish web-billing-q4");
    expect(frame.stdout).toContain("FLEET (1)");
    const agent = await cli(env.h, ["board", "--once"], { env: { FLOWRYN_TOKEN: env.worker.token } });
    expect(agent.code).toBe(77);
  });
});

describe("waiters", () => {
  test("a waiter whose harness is gone stops instead of retrying for hours", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const lead = await e.openSession("pi");
    await e.call("hook.session-start", { harness: "pi", input: JSON.stringify({ source: "startup" }) }, lead.token);
    // Its parent (standing in for Pi) lives a second, then dies, as Pi does when it crashes.
    const spawned = Bun.spawnSync(["sh", "-c", `bun ${JSON.stringify(join(REPO_ROOT, "src/main.ts"))} hook wait-p0 --harness pi --json >/dev/null 2>&1 & echo $!; sleep 1`], {
      env: { ...e.h.env, FLOWRYN_TOKEN: lead.token },
      stdin: "ignore",
    });
    const pid = Number(spawned.stdout.toString().trim());
    expect(pid).toBeGreaterThan(1);
    // Still waiting while its parent lived: it holds the session's long poll.
    expect(e.withDb((db) => db.query("SELECT 1 FROM leader_sessions WHERE session_id = ?1 AND ended_at IS NULL").get(lead.session))).toBeTruthy();
    await waitFor("the orphaned waiter to exit", 15_000, () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe("todo edit and todo rm", () => {
  test("edit keeps the due date; rm removes the to-do; an overdue item closes when its to-do is done", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const lead = await e.openSession("claude");
    await e.call("hook.session-start", { harness: "claude", input: JSON.stringify({ source: "startup" }) }, lead.token);
    const run = (args: string[], stdin?: string) => cliJson(e.h, args, { env: { FLOWRYN_TOKEN: lead.token }, stdin });
    const yesterday = localDate(new Date(Date.now() - 86_400_000));
    const added = await run(["todo", "add", "renew passport", "--due", yesterday]);
    const id = String((added.reply.data as { todo: string }).todo);
    expect((added.reply.data as { intent_state: string }).intent_state).toBe("applied");
    await waitFor("the overdue item", 10_000, () => e.withDb((db) => db.query("SELECT id FROM items WHERE kind = 'overdue_todo' AND task_id = ?1 AND state = 'open'").get(id)));
    const edited = await run(["todo", "edit", id, "--title", "renew the passport", "--body-file", "-"], "bring two photos");
    expect(edited.code).toBe(0);
    const text = readText(e.h.todos);
    expect(text).toContain("renew the passport");
    expect(text).toContain(`due: ${yesterday}`);
    expect(text).toContain("bring two photos");
    expect((await run(["todo", "edit", id])).code).toBe(3);
    await run(["todo", "done", id]);
    expect(e.withDb((db) => db.query("SELECT state FROM items WHERE kind = 'overdue_todo' AND task_id = ?1").get(id))).toEqual({ state: "resolved" });
    const other = String(((await run(["todo", "add", "call bank"])).reply.data as { todo: string }).todo);
    const removed = await run(["todo", "rm", other]);
    expect(removed.reply.data).toMatchObject({ todo: other, removed: true, intent_state: "applied" });
    expect(readText(e.h.todos)).not.toContain("call bank");
    const list = await run(["todo", "list", "--all"]);
    expect((list.reply.data as { todos: { id: string }[] }).todos.map((t) => t.id)).toEqual([id]);
    expect((await run(["todo", "rm", other])).code).toBe(4);
    expect(existsSync(e.h.todos)).toBe(true);
  });
});
