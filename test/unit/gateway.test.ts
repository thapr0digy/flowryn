import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { Gateway } from "../../src/api/gateway.ts";
import type { Envelope } from "../../src/api/envelope.ts";
import type { DaemonServices, VerbSpec } from "../../src/api/verbs.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { Journal } from "../../src/journal/journal.ts";
import { BacklogWatcher } from "../../src/journal/watcher.ts";
import { parseArgv } from "../../src/cli/argv.ts";
import { notHumanReason } from "../../src/cli/human.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { CLI_VERBS } from "../../src/cli/registry.ts";

let dir: string;
let db: Db;
let gateway: Gateway;
let applied: number;
let leaderToken: string;
let runToken: string;

const counterVerb: VerbSpec = {
  name: "test bump",
  summary: "a mutation for tests",
  positionals: [{ name: "label", required: true, help: "" }],
  flags: { times: { type: "int", help: "" }, "body-file": { type: "string", help: "", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human", "worker"],
  apply(ctx, args) {
    applied++;
    const { seq } = appendEvent(ctx.db, { source: "cli", kind: "test.bump", payload: args });
    return { data: { applied, seq, role: ctx.caller.role, run: ctx.caller.runId }, hints: ["a", "b", "c"] };
  },
};
const readVerb: VerbSpec = { name: "test read", summary: "", positionals: [], flags: {}, kind: "read", roles: ["leader", "human"], read: (ctx) => ({ data: { role: ctx.caller.role } }) };
const humanVerb: VerbSpec = { name: "test human", summary: "", positionals: [], flags: {}, kind: "read", roles: ["human"], read: () => ({ data: {} }) };
const workerVerb: VerbSpec = { name: "test worker", summary: "", positionals: [], flags: {}, kind: "read", roles: ["worker"], read: () => ({ data: {} }) };
const VERBS = new Map([counterVerb, readVerb, humanVerb, workerVerb].map((v) => [v.name, v]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-gw-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  applied = 0;
  leaderToken = mintToken("leader");
  runToken = mintToken("run");
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO leader_lease (id, epoch, token_hash) VALUES (1, 1, ?1)").run(hashToken(leaderToken));
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', ?1, ?2, ?2)`,
    ).run(hashToken(runToken), now);
  });
  const config = defaultConfig(dir);
  const journal = new Journal({ db, files: () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") }), runner: () => null });
  const watcher = new BacklogWatcher({ db, journal, files: () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") }), runner: () => null });
  const services: DaemonServices = {
    db,
    config: () => config,
    journal,
    watcher,
    now: Date.now,
    log: () => {},
    info: () => ({ pid: 1, version: "t", proto: PROTO, instance: "i", startedAt: 0, execPath: "/bin/flowryn", socket: "/s", stateDir: dir }),
    requestShutdown: () => {},
    runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  gateway = new Gateway({ services, lookup: (v) => VERBS.get(v) });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function env(verb: string, extra: Partial<Envelope> = {}): Envelope {
  return { proto: PROTO, ulid: ulid(), verb, token: leaderToken, args: {}, ...extra };
}

describe("gateway", () => {
  test("refuses a protocol mismatch before anything else, naming the daemon's binary", async () => {
    const reply = await gateway.handle(env("no such verb", { proto: PROTO + 1 }));
    expect(reply).toMatchObject({ ok: false, proto: PROTO, error: { code: "protocol_mismatch" } });
    expect(reply.error!.help).toContain("/bin/flowryn");
  });

  test("rejects malformed envelopes and unknown verbs", async () => {
    expect((await gateway.handle({ proto: PROTO })).error!.code).toBe("bad_envelope");
    expect((await gateway.handle(env("nope"))).error!.code).toBe("unknown_verb");
  });

  test("resolves the leader, a worker bound to its run, a human and an anonymous caller", async () => {
    const leader = await gateway.handle(env("test bump", { args: { label: "x" } }));
    expect(leader.data).toMatchObject({ role: "leader", run: null });
    const worker = await gateway.handle(env("test bump", { token: runToken, args: { label: "x" } }));
    expect(worker.data).toMatchObject({ role: "worker", run: "r1" });
    const human = await gateway.handle(env("test read", { token: null, channel: "tty" }));
    expect(human.data).toEqual({ role: "human" });
    const anonymous = await gateway.handle(env("test read", { token: null }));
    expect(anonymous.error!.code).toBe("role_refused");
  });

  test("an unknown token is refused, never downgraded", async () => {
    const reply = await gateway.handle(env("test read", { token: "fwl_stale", channel: "tty" }));
    expect(reply.error!.code).toBe("bad_token");
  });

  test("maps role refusals to the section 12 codes", async () => {
    expect((await gateway.handle(env("test read", { token: runToken }))).error!.code).toBe("worker_token");
    expect((await gateway.handle(env("test human"))).error!.code).toBe("human_only");
    expect((await gateway.handle(env("test worker"))).error!.code).toBe("role_refused");
  });

  test("validates arguments against the verb spec", async () => {
    expect((await gateway.handle(env("test bump"))).error).toMatchObject({ code: "bad_args", message: "missing <label>" });
    expect((await gateway.handle(env("test bump", { args: { label: "x", times: "many" } }))).error!.code).toBe("bad_args");
    expect((await gateway.handle(env("test bump", { args: { label: "x", sneaky: 1 } }))).error!.message).toContain("unknown argument");
    expect((await gateway.handle(env("test bump", { args: { label: "x", times: "3" } }))).ok).toBe(true);
  });

  test("a mutation needs a ULID; a retried ULID returns the original reply without re-applying", async () => {
    expect((await gateway.handle(env("test bump", { ulid: "x", args: { label: "x" } }))).error!.code).toBe("bad_envelope");
    const call = env("test bump", { args: { label: "once" } });
    const first = await gateway.handle(call);
    const second = await gateway.handle(call);
    expect(applied).toBe(1);
    expect(second).toEqual(first);
    expect(first.hints).toEqual(["a", "b"]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'test.bump'").get()).toEqual({ n: 1 });
  });

  test("a spooled call is recorded as ingested in the same transaction, and a duplicate is dropped", async () => {
    const call = env("test bump", { token: runToken, args: { label: "spooled" } });
    const first = await gateway.handle(call, "spool");
    expect(first.ok).toBe(true);
    expect(db.query("SELECT run_id FROM spool_ingested WHERE ulid = ?1").get(call.ulid)).toEqual({ run_id: "r1" });
    await gateway.handle(call, "spool");
    expect(applied).toBe(1);
  });

  test("sweeps stored replies older than seven days", async () => {
    await gateway.handle(env("test bump", { args: { label: "old" } }));
    expect(gateway.sweepIdempotency(Date.now() + 8 * 24 * 3600 * 1000)).toBe(1);
  });
});

describe("argv", () => {
  test("matches multi-word verbs and maps positionals and flags", () => {
    const parsed = parseArgv(["todo", "add", "buy milk", "--due", "today", "--json"], CLI_VERBS);
    expect(parsed.json).toBe(true);
    expect(parsed.command!.spec.name).toBe("todo add");
    expect(parsed.command!.args).toEqual({ title: "buy milk", due: "today" });
  });

  test("supports --flag=value, booleans, file flags and --", () => {
    const parsed = parseArgv(["project", "add", "/repo", "--yolo", "--priority=1", "--mode", "local-only"], CLI_VERBS);
    expect(parsed.command!.args).toEqual({ path: "/repo", yolo: true, priority: "1", mode: "local-only" });
    const body = parseArgv(["todo", "add", "t", "--body-file", "-"], CLI_VERBS);
    expect(body.command!.files).toEqual({ body: "-" });
    const dashed = parseArgv(["todo", "add", "--", "--not-a-flag"], CLI_VERBS);
    expect(dashed.command!.args).toEqual({ title: "--not-a-flag" });
  });

  test("rejects unknown flags and extra arguments", () => {
    expect(() => parseArgv(["todo", "list", "--bogus"], CLI_VERBS)).toThrow("unknown flag");
    expect(() => parseArgv(["todo", "done", "a", "b"], CLI_VERBS)).toThrow("too many arguments");
  });

  test("help and unknown commands", () => {
    expect(parseArgv(["help", "todo", "add"], CLI_VERBS)).toMatchObject({ help: true, words: ["todo", "add"] });
    expect(parseArgv(["frobnicate"], CLI_VERBS)).toMatchObject({ command: null, words: ["frobnicate"] });
  });

  test("the registry has no duplicate names and internal verbs stay out of argv", () => {
    const names = CLI_VERBS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => n.includes("."))).toBe(false);
    for (const verb of ["todo add", "todo list", "todo done", "todo due", "project add", "project set", "project list", "report", "init", "doctor", "daemon start", "daemon stop", "daemon status", "daemon install"]) {
      expect(names).toContain(verb);
    }
  });
});

describe("the human channel", () => {
  test("is your own terminal: no FLOWRYN identity and a TTY on stdin or stdout", () => {
    expect(notHumanReason({ env: {}, stdinIsTty: true, stdoutIsTty: false })).toBeNull();
    expect(notHumanReason({ env: {}, stdinIsTty: false, stdoutIsTty: true })).toBeNull();
    expect(notHumanReason({ env: {}, stdinIsTty: false, stdoutIsTty: false })).toContain("terminal");
    expect(notHumanReason({ env: { FLOWRYN_RUN: "r1" }, stdinIsTty: true, stdoutIsTty: true })).toContain("FLOWRYN_RUN");
    expect(notHumanReason({ env: { FLOWRYN_TOKEN: "t" }, stdinIsTty: true, stdoutIsTty: true })).toContain("agent pane");
  });
});
