import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { cli, cliJson, makeHome, readText, REPO_ROOT, seedLeader, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

async function setup(): Promise<{ h: TestHome; env: Record<string, string>; d: DaemonProc }> {
  const h = makeHome();
  homes.push(h);
  const token = seedLeader(h);
  const d = await startDaemon(h);
  daemons.push(d);
  return { h, env: { FLOWRYN_TOKEN: token }, d };
}

function gitRepo(dir: string, origin: string | null): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q", "-b", "trunk");
  if (origin) git("remote", "add", "origin", origin);
  return dir;
}

describe("todo verbs", () => {
  test("add, list, due and done go through the journal to todos.md", async () => {
    const { h, env } = await setup();
    const added = await cliJson(h, ["todo", "add", "renew passport", "--due", "2026-09-20"], { env });
    expect(added.code).toBe(0);
    const data = added.reply.data as { todo: string; intent_state: string; due: string };
    expect(data).toMatchObject({ due: "2026-09-20", intent_state: "applied" });
    expect(readText(h.todos)).toContain(`${data.todo} - renew passport (kind: todo)`);
    expect(readText(h.todos)).toContain("  due: 2026-09-20");

    const moved = await cliJson(h, ["todo", "due", data.todo, "2026-10-01"], { env });
    expect(moved.code).toBe(0);
    expect(readText(h.todos)).toContain("  due: 2026-10-01");

    const listed = await cli(h, ["todo", "list"], { env });
    expect(listed.code).toBe(0);
    const parsed = decode(listed.stdout) as { todos: { id: string; due: string; state: string }[] };
    expect(parsed.todos).toEqual([expect.objectContaining({ id: data.todo, due: "2026-10-01", state: "open" })]);

    const done = await cliJson(h, ["todo", "done", data.todo], { env });
    expect(done.code).toBe(0);
    expect(readText(h.todos)).toContain(`- [x] ${data.todo}`);
    expect(((await cliJson(h, ["todo", "list"], { env })).reply.data as { todos: unknown[] }).todos).toEqual([]);
    expect(((await cliJson(h, ["todo", "list", "--all"], { env })).reply.data as { todos: unknown[] }).todos.length).toBe(1);
  });

  test("free text comes in through --body-file -", async () => {
    const { h, env } = await setup();
    const added = await cliJson(h, ["todo", "add", "call bank", "--due", "tomorrow", "--body-file", "-"], { env, stdin: "ask about the fee\nand the card" });
    expect(added.code).toBe(0);
    expect(readText(h.todos)).toContain("  ask about the fee\n  and the card");
  });

  test("validation, not-found and tasks-axi refusals map to exit codes 3 and 4", async () => {
    const { h, env } = await setup();
    expect((await cli(h, ["todo", "add", "x", "--due", "someday"], { env })).code).toBe(3);
    expect((await cli(h, ["todo", "done", "no-such-zz"], { env })).code).toBe(4);
    expect((await cli(h, ["todo", "add", "ends with (kind: todo)"], { env })).code).toBe(3);
    expect((await cli(h, ["todo", "list", "--bogus"], { env })).code).toBe(3);
    const unknown = await cli(h, ["frobnicate"], { env });
    expect(unknown.code).toBe(3);
    expect(unknown.stdout).toContain("code: unknown_verb");
  });
});

describe("project verbs", () => {
  test("add reads origin and the default branch; set changes posture; list shows it", async () => {
    const { h, env } = await setup();
    const repo = gitRepo(join(h.home, "repos", "web-app"), "https://example.test/web-app.git");
    const added = await cliJson(h, ["project", "add", repo, "--priority", "1"], { env });
    expect(added.code).toBe(0);
    expect((added.reply.data as { project: Record<string, unknown> }).project).toMatchObject({
      id: "web-app",
      repo: "https://example.test/web-app.git",
      branch: "trunk",
      mode: "no-mistakes",
      yolo: "off",
      priority: 1,
    });
    expect((await cli(h, ["project", "add", repo], { env })).code).toBe(3);
    const set = await cliJson(h, ["project", "set", "web-app", "--mode", "direct-PR", "--yolo", "on"], { env });
    expect(set.code).toBe(0);
    expect((set.reply.data as { changed: string[] }).changed).toEqual(["delivery_mode", "yolo"]);
    const list = await cliJson(h, ["project", "list"], { env });
    expect((list.reply.data as { projects: Record<string, unknown>[] }).projects).toEqual([expect.objectContaining({ id: "web-app", mode: "direct-PR", yolo: "on" })]);
    expect((await cli(h, ["project", "set", "nope", "--yolo", "on"], { env })).code).toBe(4);
    const db = h.db();
    const kinds = (db.query("SELECT kind FROM events WHERE kind LIKE 'project.%' ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
    db.close();
    expect(kinds).toEqual(["project.added", "project.updated"]);
  });

  test("a checkout without origin needs --mode local-only; a subdirectory is refused", async () => {
    const { h, env } = await setup();
    const repo = gitRepo(join(h.home, "repos", "solo"), null);
    expect((await cliJson(h, ["project", "add", repo], { env })).reply.error).toMatchObject({ code: "invalid_project" });
    expect((await cli(h, ["project", "add", repo, "--mode", "local-only"], { env })).code).toBe(0);
    mkdirSync(join(repo, "sub"));
    expect((await cliJson(h, ["project", "add", join(repo, "sub")], { env })).reply.error).toMatchObject({ code: "invalid_project" });
    expect((await cli(h, ["project", "add", join(h.home, "not-a-repo")], { env })).code).toBe(3);
  });
});

describe("roles", () => {
  test("no token and no terminal is refused (exit 77); a worker token cannot run leader verbs", async () => {
    const { h } = await setup();
    const anonymous = await cliJson(h, ["todo", "list"]);
    expect(anonymous.code).toBe(77);
    expect(anonymous.reply.error).toMatchObject({ code: "role_refused" });
    const run = seedRun(h);
    const worker = await cliJson(h, ["todo", "add", "x"], { env: { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId } });
    expect(worker.code).toBe(77);
    expect(worker.reply.error).toMatchObject({ code: "worker_token" });
    const stale = await cliJson(h, ["todo", "list"], { env: { FLOWRYN_TOKEN: "fwl_old" } });
    expect(stale.reply.error).toMatchObject({ code: "bad_token" });
  });

  test.skipIf(process.platform !== "darwin")("your own terminal is the human channel", async () => {
    const { h } = await setup();
    const proc = Bun.spawn(["script", "-q", "/dev/null", "bun", join(REPO_ROOT, "src/main.ts"), "todo", "add", "from my shell"], {
      cwd: REPO_ROOT,
      env: h.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("title: from my shell");
    expect(readText(h.todos)).toContain("from my shell");
  });
});

describe("when the daemon is down", () => {
  test("reads fall back to read-only SQLite with a banner; leader mutations exit 69", async () => {
    const { h, env, d } = await setup();
    await cli(h, ["todo", "add", "survives"], { env });
    await d.stop();
    const read = await cli(h, ["todo", "list"], { env });
    expect(read.code).toBe(0);
    expect(read.stdout).toStartWith("banner: daemon down");
    expect(read.stdout).toContain("survives");
    const write = await cliJson(h, ["todo", "add", "lost?"], { env });
    expect(write.code).toBe(69);
    expect(write.reply.error).toMatchObject({ code: "daemon_unavailable", help: "flowryn daemon status" });
  });

  test("worker verbs spool (exit 75) and are ingested exactly once at the next start", async () => {
    const { h, d } = await setup();
    const run = seedRun(h);
    const worker = { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId };
    expect((await cli(h, ["report", "progress"], { env: worker })).code).toBe(0);
    await d.stop();
    const spooled = await cli(h, ["report", "blocked", "--body-file", "-"], { env: worker, stdin: "waiting on the API key" });
    expect(spooled.code).toBe(75);
    const ulid = /spooled: ([0-9A-Z]{26})/.exec(spooled.stdout)![1]!;
    const file = join(h.dataDir, "spool", run.runId, `${ulid}.json`);
    expect(existsSync(file)).toBe(true);
    const saved = readText(file);

    daemons.push(await startDaemon(h));
    expect(existsSync(file)).toBe(false);
    // The same call spooled twice (a retry after a lost reply) is dropped by its ULID.
    writeFileSync(file, saved);
    const again = await startDaemonAfterStop(h);
    expect(existsSync(file)).toBe(false);
    const db = h.db();
    const reports = db.query("SELECT payload FROM events WHERE kind = 'worker.report' ORDER BY seq").all() as { payload: string }[];
    db.close();
    expect(reports.map((r) => JSON.parse(r.payload).status)).toEqual(["progress", "blocked"]);
    expect(JSON.parse(reports[1]!.payload)).toMatchObject({ body: "waiting on the API key", via: "spool" });
    expect(readdirSync(join(h.dataDir, "spool", run.runId))).toEqual([]);
    daemons.push(again);
  });

  test("a spooled call the daemon refuses is kept under spool/rejected, not lost", async () => {
    const { h, d } = await setup();
    await d.stop();
    const dir = join(h.dataDir, "spool", "r-ghost");
    mkdirSync(dir, { recursive: true });
    const ulid = "01J8Z0000000000000000000AA";
    writeFileSync(join(dir, `${ulid}.json`), JSON.stringify({ proto: 1, ulid, verb: "report", token: "fwr_unknown", args: { status: "blocked" } }));
    daemons.push(await startDaemon(h));
    expect(existsSync(join(h.dataDir, "spool", "rejected", "r-ghost", `${ulid}.json`))).toBe(true);
    const db = h.db();
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'spool.rejected'").get()).toEqual({ n: 1 });
    db.close();
  });
});

async function startDaemonAfterStop(h: TestHome): Promise<DaemonProc> {
  const running = daemons.pop();
  if (running) await running.stop();
  return startDaemon(h);
}

describe("output", () => {
  test("help lists the registry; --json errors carry a stable code", async () => {
    const h = makeHome();
    homes.push(h);
    const help = await cli(h, ["help"]);
    expect(help.code).toBe(0);
    const parsed = decode(help.stdout) as { commands: { command: string }[] };
    expect(parsed.commands.map((c) => c.command)).toContain("todo add");
    const verb = await cli(h, ["todo", "add", "--help"]);
    expect((decode(verb.stdout) as { usage: string }).usage).toStartWith("flowryn todo add <title>");
    const version = await cliJson(h, ["version"]);
    expect(version.reply.data).toMatchObject({ proto: 1 });
  });
});
