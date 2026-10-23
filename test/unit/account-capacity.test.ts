import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExplanations } from "../../src/attention/explanations.ts";
import { accountOfTranscript, accountsConfig, defaultAccount, type Account } from "../../src/config/accounts.ts";
import { parseConfig } from "../../src/config/config.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { getMeta, migrate, openDb, setMeta, tx, type Db } from "../../src/db/db.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { moveLegacyCapacity } from "../../src/sched/legacy.ts";
import { parseQuota, probeQuota, quotaHolds, quotaState } from "../../src/sched/quota.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { noteUsageLimit, usageGate, usagePause } from "../../src/sched/usage.ts";
import { quotaJson } from "../helpers/harness.ts";

/**
 * The quota floor and the usage pause per account
 * (docs/notes/2026-10-22-multiple-ai-provider-u9.md): two Claude logins in
 * one work scope, driven through the real scheduler with quota-axi and the
 * sign-in check stood in per account.
 */

const HOME = "/tmp/fw-account-capacity";
const ACCOUNTS = (overflow: boolean) => `[tools]
claude = "/bin/true"
[scopes]
default = "work"
[scopes.work]
accounts = ["work-a"]
[accounts.work-a]
harness = "claude"
scope = "work"
config_dir = "/x/work-a"
model = "opus"
${overflow ? 'overflow = ["work-b"]' : ""}
[accounts.work-b]
harness = "claude"
scope = "work"
config_dir = "/x/work-b"
model = "sonnet"
effort = "low"
`;
const BACKOFF = { usage_backoff_ms: 60_000, usage_backoff_max_ms: 120_000 };

let dir: string;
let db: Db;
let dirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-acap-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(dir);
    for (const h of ["claude", "pi"] as const) db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES (?1, '1', ?2, 0)").run(h, contractRevision(h));
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run waiting for its launch on an account: a fresh first launch, or a resume. */
function waiting(run: string, account: string, mode: "fresh" | "resume" = "fresh", at = 1, harness = "claude"): void {
  const task = run.replace("r", "t");
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'scout', 'local-only', 0, 'scout', 0)").run(task);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, model, state, liveness, workflow, stage, agent_session, worktree_path, branch, base_sha,
         token_hash, started_at, updated_at, stage_state, waiting_since, pending_launch, account)
       VALUES (?1, ?2, ?7, '1', 'opus', 'launching', 'starting', 'scout', 'scout', 'sess', ?3, 'b', 'abc', 'h', ?4, ?4, 'waiting', ?4, ?5, ?6)`,
    ).run(run, task, join(dir, task), at, mode, account, harness);
  });
}

interface Stand {
  quota: Record<string, number>;
  signedOut: Set<string>;
  launches: string[];
  probed: string[];
}

function scheduler(stand: Stand, overflow = false, now = () => 1_000_000) {
  const config = parseConfig(ACCOUNTS(overflow), HOME);
  return new Scheduler({
    db,
    config: () => config,
    now,
    log: () => {},
    launch: (runId, mode) => {
      stand.launches.push(`${runId}:${mode}`);
      db.query("UPDATE runs SET pending_launch = NULL WHERE id = ?1").run(runId);
    },
    isLaunching: () => false,
    exitWorker: async () => ({ ok: true }),
    notify: () => {},
    startDeps: {
      db,
      config: () => config,
      runtime: () => null,
      harnessVersion: async () => "1",
      git: async () => null,
      signIn: async (account) => (stand.signedOut.has(account.id) ? `account ${account.id} (${account.config_dir}): not signed in; sign in with CLAUDE_CONFIG_DIR=${account.config_dir} claude, then /login` : null),
      now,
    },
    kickJournal: () => {},
    host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
    quota: async (account) => {
      stand.probed.push(account.id);
      return { state: "known", percent: stand.quota[account.id] ?? 80, window: "five_hour", resets_at: null };
    },
  });
}

async function pass(stand: Stand, overflow = false): Promise<void> {
  const s = scheduler(stand, overflow);
  await s.passNow();
  s.stop();
}

const stand = (over: Partial<Stand> = {}): Stand => ({ quota: {}, signedOut: new Set(), launches: [], probed: [], ...over });
const run = (id: string) => db.query("SELECT account, model, effort, pending_launch FROM runs WHERE id = ?1").get(id) as { account: string; model: string | null; effort: string | null; pending_launch: string | null };
const reasons = (id: string) => openExplanations(db, id).map((r) => [r.rule, r.reason]);
const item = (kind: string, key: string) => db.query("SELECT state, line FROM items WHERE kind = ?1 AND task_id = ?2 ORDER BY rowid DESC").get(kind, key) as { state: string; line: string } | null;
const events = (kind: string) => (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);

describe("one account held, the other carries on", () => {
  test("a low quota on one account holds only that account's fresh runs, each account probed once", async () => {
    waiting("r1", "work-a");
    waiting("r2", "work-b");
    const s = stand({ quota: { "work-a": 2 } });
    await pass(s);
    expect(s.launches).toEqual(["r2:fresh"]);
    expect(s.probed.toSorted()).toEqual(["work-a", "work-b"]);
    expect(reasons("r1")).toEqual([["capacity.quota_floor", "the quota of account work-a is 2%, under the 5% floor"]]);
    expect(quotaHolds(db, "work-a")).toBe(true);
    expect(quotaHolds(db, "work-b")).toBe(false);
    expect(item("quota_low", "account:work-a")!.line).toContain("flowryn capacity resume --account work-a");
    expect(item("quota_low", "account:work-b")).toBeNull();
  });

  test("a usage pause on one account holds every launch on it, a resume too; the other account launches", async () => {
    waiting("r1", "work-a", "resume");
    waiting("r2", "work-b");
    tx(db, () => noteUsageLimit(db, "work-a", "worker t1", "rate_limit", 1_000_000, BACKOFF));
    const s = stand();
    await pass(s);
    expect(s.launches).toEqual(["r2:fresh"]);
    expect(reasons("r1")[0]![0]).toBe("capacity.usage_limit");
    expect(usageGate(db, 1_000_000, "work-b", null)).toBe("open");
    expect(item("usage_limit", "account:work-a")!.state).toBe("open");
  });
});

describe("a login quota-axi cannot read", () => {
  test("the implicit Pi account is never probed nor recorded: its run starts and no quota event is written", async () => {
    waiting("r1", "pi", "fresh", 1, "pi");
    const s = stand();
    await pass(s);
    expect(s.launches).toEqual(["r1:fresh"]);
    expect(s.probed).toEqual([]);
    expect(db.query("SELECT kind FROM events WHERE kind LIKE 'sched.quota_%'").all()).toEqual([]);
  });
});

describe("overflow ([accounts.<id>] overflow)", () => {
  test("a held fresh launch moves to the overflow account, with its model and effort, recorded with an event", async () => {
    waiting("r1", "work-a");
    const s = stand({ quota: { "work-a": 2 } });
    await pass(s, true);
    expect(s.launches).toEqual(["r1:fresh"]);
    expect(run("r1")).toMatchObject({ account: "work-b", model: "sonnet", effort: "low" });
    expect(events("sched.overflow")).toEqual([{ from: "work-a", to: "work-b", why: "capacity.quota_floor", at: "grant" }]);
  });

  test("without overflow configured the same run waits on its account", async () => {
    waiting("r1", "work-a");
    const s = stand({ quota: { "work-a": 2 } });
    await pass(s, false);
    expect(s.launches).toEqual([]);
    expect(run("r1").account).toBe("work-a");
    expect(events("sched.overflow")).toEqual([]);
  });

  test("never on a resume: it keeps the account its session lives in", async () => {
    waiting("r1", "work-a", "resume");
    tx(db, () => noteUsageLimit(db, "work-a", "worker t1", "rate_limit", 1_000_000, BACKOFF));
    const s = stand();
    await pass(s, true);
    expect(s.launches).toEqual([]);
    expect(run("r1").account).toBe("work-a");
    expect(reasons("r1")).toEqual([[`capacity.usage_limit`, expect.stringMatching(/^the usage limit on account work-a pauses its starts until \d\d:\d\d$/)]]);
  });

  test("a target that is held too, or signed out, is no overflow: the run waits and says so", async () => {
    waiting("r1", "work-a");
    await pass(stand({ quota: { "work-a": 2, "work-b": 1 } }), true);
    expect(run("r1").account).toBe("work-a");
    expect(reasons("r1")).toEqual([["capacity.quota_floor", "the quota of account work-a is 2%, under the 5% floor; no overflow account is free (work-b)"]]);
    const s = stand({ quota: { "work-a": 2 }, signedOut: new Set(["work-b"]) });
    await pass(s, true);
    expect(s.launches).toEqual([]);
    expect(run("r1").account).toBe("work-a");
  });
});

describe("a signed-out account", () => {
  test("its runs wait with one P1 naming the login command; once signed in they start and the P1 resolves", async () => {
    waiting("r1", "work-a");
    waiting("r2", "work-a", "fresh", 2);
    const s = stand({ signedOut: new Set(["work-a"]) });
    await pass(s);
    await pass(s);
    expect(s.launches).toEqual([]);
    expect(reasons("r1")).toEqual([["capacity.account_signed_out", "account work-a is signed out"]]);
    const open = db.query("SELECT line FROM items WHERE kind = 'account_signed_out' AND state = 'open'").all() as { line: string }[];
    expect(open).toHaveLength(1);
    expect(open[0]!.line).toContain("CLAUDE_CONFIG_DIR=/x/work-a claude, then /login");
    expect(events("sched.account_signed_out")).toHaveLength(1);
    s.signedOut.clear();
    await pass(s);
    expect(s.launches.toSorted()).toEqual(["r1:fresh", "r2:fresh"]);
    expect(item("account_signed_out", "account:work-a")!.state).toBe("resolved");
    expect(events("sched.account_signed_in")).toHaveLength(1);
  });
});

describe("the state from before accounts", () => {
  test("claude_quota and claude_usage_limit, and their unkeyed P1s, move to the default Claude account once, with an event", () => {
    const config = parseConfig(ACCOUNTS(false), HOME);
    expect(defaultAccount(config, "claude").id).toBe("work-a");
    tx(db, () => {
      setMeta(db, "claude_quota", JSON.stringify({ state: "low", percent: 1, floor: 5, window: null, resets_at: null, detail: null, since: 5, override: false }));
      setMeta(db, "claude_usage_limit", JSON.stringify({ since: 5, until: 9_999_999_999_999, backoff_ms: 60_000, who: "worker t9", probe: null }));
      const event = db.query("INSERT INTO events (ulid, ts, source, kind, payload) VALUES ('01LEGACY', 5, 'daemon', 'sched.usage_limit', '{}') RETURNING seq").get() as { seq: number };
      db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, line, opened_at) VALUES ('i-legacy', ?1, 'actionable', 'P1', 'usage_limit', NULL, 'old', 5)").run(event.seq);
    });
    expect(tx(db, () => moveLegacyCapacity(db, config, 10))).toBe("work-a");
    expect(quotaState(db, "work-a")).toMatchObject({ state: "low", percent: 1 });
    expect(usagePause(db, "work-a")).toMatchObject({ who: "worker t9" });
    expect(getMeta(db, "claude_quota")).toBeNull();
    expect(getMeta(db, "claude_usage_limit")).toBeNull();
    expect(item("usage_limit", "account:work-a")!.state).toBe("open");
    expect(events("sched.capacity_moved")).toEqual([{ account: "work-a", moved: ["quota:work-a", "usage_limit:work-a"], items: 1 }]);
    expect(tx(db, () => moveLegacyCapacity(db, config, 11))).toBeNull();
  });

  test("without [accounts] it is the implicit claude account, so nothing changes for a home without accounts", () => {
    const config = parseConfig("", HOME);
    tx(db, () => setMeta(db, "claude_quota", JSON.stringify({ state: "ok", percent: 50, floor: 5, window: null, resets_at: null, detail: null, since: 5, override: false })));
    expect(tx(db, () => moveLegacyCapacity(db, config, 10))).toBe("claude");
    expect(quotaState(db, "claude")).toMatchObject({ state: "ok", percent: 50 });
  });
});

describe("config: overflow stays inside its scope and harness", () => {
  const load = (extra: string) => () => accountsConfig(parseConfig(`${ACCOUNTS(false)}${extra}`, HOME));
  const personal = `[scopes.personal]\n[accounts.home]\nharness = "claude"\nscope = "personal"\n[accounts.chatgpt]\nharness = "pi"\nscope = "work"\nprovider = "openai-codex"\nmodel = "openai-codex/gpt-5"\n`;
  test("refused at load: another scope, another harness, an unknown account, itself, twice", () => {
    expect(load(`${personal}[accounts.extra]\nharness = "claude"\nscope = "work"\noverflow = ["home"]\n`)).toThrow("home is in scope personal, not work; overflow stays inside a scope");
    expect(load(`${personal}[accounts.extra]\nharness = "claude"\nscope = "work"\noverflow = ["chatgpt"]\n`)).toThrow("chatgpt is a pi account, not claude; overflow stays on one harness");
    expect(load(`[accounts.extra]\nharness = "claude"\nscope = "work"\noverflow = ["nobody"]\n`)).toThrow("[accounts.extra] overflow: no account nobody");
    expect(load(`[accounts.extra]\nharness = "claude"\nscope = "work"\noverflow = ["extra"]\n`)).toThrow("cannot overflow to itself");
    expect(load(`[accounts.extra]\nharness = "claude"\nscope = "work"\noverflow = ["work-b", "work-b"]\n`)).toThrow("work-b is listed twice");
    expect(accountsConfig(parseConfig(ACCOUNTS(true), HOME)).accounts["work-a"]!.overflow).toEqual(["work-b"]);
  });
});

describe("a leader's usage signal", () => {
  test("belongs to the Claude account whose directory holds its transcript", () => {
    const logins = realpathSync(mkdtempSync(join(tmpdir(), "fw-logins-")));
    dirs.push(logins);
    mkdirSync(join(logins, "work-b", "projects", "p"), { recursive: true });
    const config = parseConfig(ACCOUNTS(false).replace('"/x/work-b"', JSON.stringify(join(logins, "work-b"))), HOME);
    expect(accountOfTranscript(config, join(logins, "work-b", "projects", "p", "s.jsonl"))?.id).toBe("work-b");
    expect(accountOfTranscript(config, join(logins, "elsewhere", "projects", "s.jsonl"))).toBeNull();
    expect(accountOfTranscript(config, null)).toBeNull();
  });
});

describe("probing one account's login", () => {
  function script(body: string): string {
    const d = mkdtempSync(join(tmpdir(), "fw-qprobe-"));
    dirs.push(d);
    const path = join(d, "quota-axi");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const account = (over: Partial<Account>): Account => ({ id: "a", harness: "claude", scope: "s", config_dir: null, agent_dir: null, provider: null, model: null, effort: null, declared: true, overflow: [], ...over });

  test("assumption: quota-axi reads the login CLAUDE_CONFIG_DIR points at, so each account's probe sets it, or deletes it for the default login", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "fw-qenv-")), "env");
    dirs.push(join(out, ".."));
    const tool = script(`echo "dir=\${CLAUDE_CONFIG_DIR-unset} key=\${ANTHROPIC_API_KEY-unset}" >> ${JSON.stringify(out)}; cat <<'JSON'\n${quotaJson(42)}\nJSON`);
    const saved = { dir: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };
    process.env.CLAUDE_CONFIG_DIR = "/inherited";
    process.env.ANTHROPIC_API_KEY = "sk-inherited";
    try {
      expect(await probeQuota(tool, null, account({ config_dir: "/x/work" }))).toMatchObject({ state: "known", percent: 42 });
      await probeQuota(tool, null, account({}));
      await probeQuota(tool, null, account({ declared: false }));
      await probeQuota(tool, null, account({ declared: false, config_dir: "/x/workers" }));
    } finally {
      for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.dir], ["ANTHROPIC_API_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual([
      "dir=/x/work key=unset",
      "dir=unset key=unset",
      // The implicit account launches on the inherited login, so it is read on it too, as before accounts.
      "dir=/inherited key=sk-inherited",
      "dir=/x/workers key=sk-inherited",
    ]);
  });

  test("assumption: quota-axi names the source only under --full, and reads Pi's openai-codex login with ~/.codex out of the way", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "fw-qpi-")), "log");
    dirs.push(join(out, ".."));
    const reply = (source: string) => JSON.stringify({ ...JSON.parse(quotaJson(30)), providers: [{ ...JSON.parse(quotaJson(30)).providers[0], provider: "codex", source }] });
    const piAccount = account({ id: "chatgpt", harness: "pi", agent_dir: "/x/pi-agent", provider: "openai-codex" });
    const tool = script(
      `echo "$* agent=$PI_CODING_AGENT_DIR codex=$CODEX_HOME" >> ${JSON.stringify(out)}; [ -d "$CODEX_HOME" ] && [ -z "$(ls -A "$CODEX_HOME")" ] && echo empty >> ${JSON.stringify(out)}; cat "$(dirname "$0")/reply.json"`,
    );
    writeFileSync(join(tool, "..", "reply.json"), reply("pi:openai-codex"));
    expect(await probeQuota(tool, null, piAccount)).toMatchObject({ state: "known", percent: 30 });
    writeFileSync(join(tool, "..", "reply.json"), reply("oauth"));
    expect(await probeQuota(tool, null, piAccount)).toEqual({ state: "unknown", detail: "quota-axi read oauth, not pi:openai-codex" });
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines[0]).toMatch(/^--provider codex --json --full --no-credential-refresh agent=\/x\/pi-agent codex=\S+$/);
    expect(lines[1]).toBe("empty");
    // The probe's empty directory is gone after it.
    expect(existsSync(lines[0]!.split("codex=")[1]!)).toBe(false);
    expect(readdirSync(join(out, "..")).length).toBe(1);
  });

  test("a Pi provider quota-axi cannot read, and the implicit Pi account, are unknown without running anything", async () => {
    const tool = script("echo ran >&2; exit 1");
    expect(await probeQuota(tool, null, account({ harness: "pi", agent_dir: "/x/pi", provider: "anthropic" }))).toEqual({ state: "unknown", detail: "quota-axi cannot read Pi provider anthropic" });
    expect(await probeQuota(tool, null, account({ id: "pi", harness: "pi", declared: false }))).toEqual({ state: "unknown", detail: "account pi names no Pi provider" });
  });

  test("parseQuota reads the named provider", () => {
    const codex = JSON.stringify({ ...JSON.parse(quotaJson(12)), providers: [{ ...JSON.parse(quotaJson(12)).providers[0], provider: "codex" }] });
    expect(parseQuota(codex, "codex")).toMatchObject({ state: "known", percent: 12 });
    expect(parseQuota(codex)).toEqual({ state: "unknown", detail: "quota-axi reported no claude provider" });
  });
});
