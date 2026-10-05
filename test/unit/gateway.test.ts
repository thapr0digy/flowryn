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
import { inertFleet } from "../../src/lifecycle/fleet-services.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { inertSched } from "../../src/sched/services.ts";
import { inertRestart } from "../../src/daemon/restart.ts";
import { PING_VERB, PROTO_EXEMPT_VERBS, RESTART_VERB, systemVerbs } from "../../src/daemon/system-verbs.ts";
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
const VERBS = new Map([counterVerb, readVerb, humanVerb, workerVerb, ...systemVerbs()].map((v) => [v.name, v]));

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
  const info = () => ({ pid: 1, version: "t", proto: PROTO, instance: "i", startedAt: 0, execPath: "/bin/flowryn", socket: "/s", stateDir: dir });
  const services: DaemonServices = {
    db,
    config: () => config,
    journal,
    watcher,
    now: Date.now,
    log: () => {},
    info,
    requestShutdown: () => {},
    runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fleet: inertFleet(),
    attention: inertAttention(),
    delivery: inertDelivery(),
    sched: inertSched(),
    restart: inertRestart(db, info),
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

  test("the handshake and the restart are served across a protocol bump; nothing else is", async () => {
    expect([...PROTO_EXEMPT_VERBS].toSorted()).toEqual([RESTART_VERB, PING_VERB].toSorted());
    const ping = await gateway.handle(env(PING_VERB, { proto: PROTO + 1 }));
    expect(ping).toMatchObject({ ok: true, data: { proto: PROTO, pid: 1 } });
    // The restart gets past the protocol check to its own rules (here: no supervisor in this process).
    const restart = await gateway.handle(env(RESTART_VERB, { proto: PROTO + 1 }));
    expect(restart.error!.code).toBe("not_supervised");
    expect((await gateway.handle(env("test read", { proto: PROTO + 1 }))).error!.code).toBe("protocol_mismatch");
  });

  test("the restart verb's arguments are frozen: an older or newer CLI must still be understood", () => {
    const restart = systemVerbs().find((v) => v.name === RESTART_VERB)!;
    expect(restart.positionals).toEqual([]);
    expect(Object.fromEntries(Object.entries(restart.flags).map(([k, f]) => [k, f.type]))).toEqual({ "when-idle": "boolean", "wait-min": "int", cancel: "boolean", force: "boolean" });
    expect(systemVerbs().find((v) => v.name === PING_VERB)!.flags).toEqual({});
  });

  test("restart: the leader and a human reach its rules; a worker, a reader and an anonymous caller are refused", async () => {
    expect((await gateway.handle(env(RESTART_VERB))).error!.code).toBe("not_supervised");
    expect((await gateway.handle(env(RESTART_VERB, { token: null, channel: "tty" }))).error!.code).toBe("not_supervised");
    expect((await gateway.handle(env(RESTART_VERB, { token: runToken }))).error!.code).toBe("worker_token");
    expect((await gateway.handle(env(RESTART_VERB, { token: null }))).error!.code).toBe("role_refused");
    const readerToken = mintToken("leader");
    tx(db, () => db.query("INSERT INTO leader_sessions (session_id, harness, token_hash, started_at) VALUES ('L9', 'claude', ?1, 1)").run(hashToken(readerToken)));
    expect((await gateway.handle(env(RESTART_VERB, { token: readerToken }))).error!.code).toBe("not_leader");
  });

  test("restart is never taken from the spool (ephemeral: no stored reply can kick a later daemon)", async () => {
    expect((await gateway.handle(env(RESTART_VERB), "spool")).error!.code).toBe("bad_envelope");
    expect(db.query("SELECT COUNT(*) AS n FROM idempotency WHERE verb = ?1").get(RESTART_VERB)).toEqual({ n: 0 });
  });

  test("restart --wait-min is bounded", async () => {
    expect((await gateway.handle(env(RESTART_VERB, { args: { "when-idle": true, "wait-min": 0 } }))).error!.code).toBe("bad_args");
    expect((await gateway.handle(env(RESTART_VERB, { args: { "when-idle": true, "wait-min": 241 } }))).error!.code).toBe("bad_args");
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

  test("a stdin flag reads - from stdin and keeps any other value literal", () => {
    const piped = parseArgv(["decide", "k3", "sqlite", "--rationale", "-"], CLI_VERBS);
    expect(piped.command!.files).toEqual({ rationale: "-" });
    expect(piped.command!.args).toEqual({ decision: "k3", choice: "sqlite" });
    const literal = parseArgv(["decide", "k3", "sqlite", "--rationale=one process"], CLI_VERBS);
    expect(literal.command!.files).toEqual({});
    expect(literal.command!.args).toMatchObject({ rationale: "one process" });
    expect(() => parseArgv(["decide", "k3", "sqlite", "--rationale", "-", "--body-file", "-"], CLI_VERBS)).toThrow("only one flag can read stdin");
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
