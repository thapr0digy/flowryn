import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintToken } from "../../src/api/auth.ts";
import { completionValues } from "../../src/cli/completion/values.ts";
import { zshScript } from "../../src/cli/completion/zsh.ts";
import { CLI_VERBS } from "../../src/cli/registry.ts";
import { socketPath } from "../../src/config/paths.ts";
import { tx } from "../../src/db/db.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { cli, makeHome, REPO_ROOT, seedLeader, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * `flowryn completion values` and the zsh script driving it
 * (docs/notes/2026-10-29-zsh-completions-for-49.md): ids from a read-only look
 * at local state, scoped like the list verbs, and nothing on any failure.
 */

let h: TestHome;

function scopedConfig(home: string): string {
  return `[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(join(home, "work"))}]

[scopes.personal]

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(join(home, ".claude-work"))}

[accounts.claude-personal]
harness = "claude"
scope = "personal"
`;
}

function task(id: string, title: string, state: BacklogTask["state"] = "queued"): BacklogTask {
  return { id, title, state, kind: "ship", repo: null, priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [] };
}

/** Two projects in two scopes, each with an open and a done task, an open and an answered decision, and to-dos. */
function seedState(): void {
  const db = h.db();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('api', '', ?1, 'main', 'local-only')").run(join(h.home, "work", "api"));
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('site', '', ?1, 'main', 'local-only')").run(join(h.home, "code", "site"));
    for (const [taskId, project] of [["api-w1", "api"], ["api-old", "api"], ["site-p1", "site"]] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', 1)").run(taskId, project);
    }
    writeSnapshot(db, "backlog", "b", [task("api-w1", "fix the api"), task("api-old", "an old one", "done"), task("site-p1", "the site: header")]);
    writeSnapshot(db, "todos", "t", [task("bank-a1", "call the bank"), task("tax-b2", "file taxes", "done")]);
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, created_at) VALUES ('q1', 'api-w1', 'which db?', '[]', 0, 'open', 1)").run();
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, created_at) VALUES ('q2', 'site-p1', 'which font?', '[]', 0, 'answered', 1)").run();
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, created_at) VALUES ('q3', 'site-p1', 'which colour?', '[]', 0, 'open', 1)").run();
  });
  db.close();
}

async function values(source: string, env: Record<string, string> = {}): Promise<{ code: number; lines: string[]; stderr: string }> {
  const result = await cli(h, ["completion", "values", source], { env });
  return { code: result.code, lines: result.stdout.split("\n").filter(Boolean), stderr: result.stderr };
}

const ids = (lines: string[]) => lines.map((l) => l.split(":")[0]);

beforeEach(() => {
  h = makeHome({ extraConfig: (home) => scopedConfig(home) });
  for (const dir of [join(h.home, "work", "api"), join(h.home, "code", "site"), join(h.home, ".claude-work")]) mkdirSync(dir, { recursive: true });
});

afterEach(() => h.cleanup());

describe("completion values", () => {
  test("your terminal gets the open ids of each kind, with a description", async () => {
    seedState();
    expect((await values("project")).lines).toEqual([`api:${join(h.home, "work", "api")}`, `site:${join(h.home, "code", "site")}`]);
    expect((await values("task")).lines).toEqual(["api-w1:fix the api", "site-p1:the site: header"]);
    expect((await values("decision")).lines).toEqual(["q1:which db?", "q3:which colour?"]);
    expect((await values("todo")).lines).toEqual(["bank-a1:call the bank"]);
    expect(ids((await values("workflow")).lines)).toEqual(["feature", "feature-ui", "fix", "scout", "draft"]);
    expect(ids((await values("stage")).lines)).toEqual(["design", "build", "ship", "qa", "investigate", "draft", "final"]);
    expect(ids((await values("account")).lines)).toEqual(expect.arrayContaining(["claude-work", "claude-personal"]));
  });

  test("a scoped leader's token sees only its own scope's ids, as its list verbs do", async () => {
    seedState();
    const token = seedLeader(h, "work");
    const env = { FLOWRYN_TOKEN: token };
    expect(ids((await values("project", env)).lines)).toEqual(["api"]);
    expect(ids((await values("task", env)).lines)).toEqual(["api-w1"]);
    expect(ids((await values("decision", env)).lines)).toEqual(["q1"]);
    expect(ids((await values("account", env)).lines)).toEqual(["claude-work"]);
  });

  test("a run's token, a token that names nothing, and no database all print nothing and exit 0", async () => {
    const noDb = await values("task");
    expect(noDb).toEqual({ code: 0, lines: [], stderr: "" });
    // Config's ids need no database, for your terminal.
    expect(ids((await values("workflow")).lines)).toContain("feature-ui");
    seedState();
    const { token } = seedRun(h, "api-run-a1");
    expect(await values("task", { FLOWRYN_TOKEN: token })).toEqual({ code: 0, lines: [], stderr: "" });
    expect(await values("task", { FLOWRYN_TOKEN: mintToken("leader") })).toEqual({ code: 0, lines: [], stderr: "" });
  });

  test("an unreadable config prints nothing and exits 0", async () => {
    writeFileSync(join(h.home, "config.toml"), "this is = = not toml\n");
    expect(await values("workflow")).toEqual({ code: 0, lines: [], stderr: "" });
  });

  test("an unknown source or shell is refused", async () => {
    expect((await values("nope")).code).toBe(3);
    const bash = await cli(h, ["completion", "bash"]);
    expect(bash.code).toBe(3);
    expect(bash.stdout).toContain("only zsh is supported");
  });

  test("it never contacts the daemon: a socket that takes calls and never answers sees no connection", async () => {
    seedState();
    let connections = 0;
    const sock = socketPath(h.home, h.env);
    mkdirSync(join(sock, ".."), { recursive: true });
    const server = Bun.listen({ unix: sock, socket: { open: () => void connections++, data: () => {} } });
    try {
      const started = Date.now();
      const result = await values("task");
      expect(ids(result.lines)).toEqual(["api-w1", "site-p1"]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(connections).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("assumption: a read-only lookup does not wait on a writer holding the database's write lock", () => {
    seedState();
    const writer = h.db();
    writer.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(completionValues(h.env, "task").map((v) => v.id)).toEqual(["api-w1", "site-p1"]);
      expect(performance.now() - started).toBeLessThan(200);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("assumption: a lookup's own read takes well under 100 ms", () => {
    seedState();
    completionValues(h.env, "task");
    const started = performance.now();
    for (let i = 0; i < 10; i++) completionValues(h.env, "task");
    expect((performance.now() - started) / 10).toBeLessThan(50);
  });
});

/** Run the zsh completion of `line` against the script (or a directory on $fpath) and return what Tab offers. */
function complete(scriptOrDir: string, line: string): { code: number; offered: string[]; stderr: string } {
  const result = Bun.spawnSync(["zsh", "-f", join(REPO_ROOT, "test/helpers/zsh-complete.zsh"), scriptOrDir, line], {
    env: { ...h.env, PATH: `${join(h.home, "zbin")}:${h.env.PATH ?? ""}`, TMPDIR: h.home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: result.exitCode ?? -1, offered: result.stdout.toString().split("\n").filter(Boolean), stderr: result.stderr.toString() };
}

const words = (offered: string[]) => offered.map((o) => o.split(" -- ")[0]);

// CI's ubuntu-latest image has no zsh; the Mac run, where zsh is the login shell, covers these.
describe.skipIf(!Bun.which("zsh"))("Tab in a real zsh", () => {
  let scriptFile: string;
  let fpathDir: string;

  beforeEach(() => {
    const bin = join(h.home, "zbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "flowryn"), `#!/bin/sh\nexec bun ${JSON.stringify(join(REPO_ROOT, "src/main.ts"))} "$@"\n`);
    chmodSync(join(bin, "flowryn"), 0o755);
    const script = zshScript(CLI_VERBS, "0.0.0-test");
    scriptFile = join(h.home, "flowryn.zsh");
    writeFileSync(scriptFile, script);
    fpathDir = join(h.home, "fpath");
    mkdirSync(fpathDir);
    writeFileSync(join(fpathDir, "_flowryn"), script);
  });

  test("sourced: verbs, sub-verbs, flags and fixed values", () => {
    expect(words(complete(scriptFile, "flowryn de").offered)).toEqual(expect.arrayContaining(["decide", "decision", "decline", "deliver"]));
    expect(words(complete(scriptFile, "flowryn decision ").offered)).toEqual(["add", "list", "defer"]);
    expect(words(complete(scriptFile, "flowryn dispatch web --kind ").offered)).toEqual(["ship", "scout"]);
    expect(words(complete(scriptFile, "flowryn --json todo list --due ").offered)).toEqual(["today", "overdue"]);
    const flags = words(complete(scriptFile, "flowryn dispatch web --").offered);
    expect(flags).toEqual(expect.arrayContaining(["--kind", "--harness", "--blocked-by", "--json", "--help"]));
    expect(flags).not.toContain("--once");
  });

  test("sourced: ids come from local state, with their titles", () => {
    seedState();
    expect(complete(scriptFile, "flowryn show ").offered).toEqual(["api-w1 -- fix the api", "site-p1 -- the site: header"]);
    expect(words(complete(scriptFile, "flowryn dispatch ").offered)).toEqual(["api", "site"]);
    expect(words(complete(scriptFile, "flowryn verify ").offered)).toEqual(expect.arrayContaining(["show", "api-w1"]));
  });

  test("with no database Tab on an id offers nothing and prints no error", () => {
    const result = complete(scriptFile, "flowryn show ");
    expect(result.offered).toEqual([]);
    expect(result.stderr).toBe("");
  });

  test("assumption: the same script works autoloaded from $fpath", () => {
    expect(words(complete(fpathDir, "flowryn leader ").offered)).toEqual(["status", "claim", "repin"]);
    expect(words(complete(fpathDir, "flowryn dispatch web --harness ").offered)).toEqual(["claude", "pi"]);
  });
});
