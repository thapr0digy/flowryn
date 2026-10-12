import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFiles } from "../../src/config/paths.ts";
import { git, removeScratchHome } from "../../src/contracts/runner.ts";
import { readManifest, recoverOwned, removableHome, writeManifest, type OwnedResources, type RecoverDeps } from "../../src/contracts/owned.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { HerdrClient } from "../../src/runtime/herdr/client.ts";
import { isAlive, readIdentity, type ProcIdentity } from "../../src/runtime/proc.ts";
import { FakeHerdr } from "../helpers/fake-herdr.ts";

/**
 * The daemon's release of what a killed contract run owned
 * (src/contracts/owned.ts), against real processes, a real scratch home and
 * the fake Herdr: exactly the manifest's ids go, and nothing beside them.
 */

const dirs: string[] = [];
const herdrs: FakeHerdr[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const herdr of herdrs.splice(0)) await herdr.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "fw-own-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A process in a group of its own, as a harness in its pane is; its identity from the process table. */
async function sleeper(): Promise<ProcIdentity> {
  const child = Bun.spawn(["/bin/sh", "-c", "exec sleep 60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true } as Parameters<typeof Bun.spawn>[1]);
  children.push(child);
  for (let i = 0; i < 50; i++) {
    const identity = await readIdentity(child.pid);
    if (identity?.exe.includes("sleep")) return identity;
    await Bun.sleep(20);
  }
  throw new Error("the sleeper did not start");
}

async function workspace(herdr: FakeHerdr, cwd: string): Promise<string> {
  const result = await new HerdrClient(herdr.socket).call("workspace.create", { cwd, label: "x", env: {}, focus: false });
  return String((result.workspace as { workspace_id: string }).workspace_id);
}

/** The scratch daemon's database, with one run naming its workspace and harness. */
function scratchDb(home: string, workspaceId: string, harness: ProcIdentity): void {
  mkdirSync(join(home, "state"), { recursive: true });
  const db = openDb(stateFiles(join(home, "state")).db);
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('contract', '', '/tmp/repo', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'contract', 'scout', 'local-only', 0, 'scout', 1)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, workspace_id, proc_pid, proc_start, proc_exe)
       VALUES ('r1', 't1', 'claude', '1', 'running', 'busy', 'scout', 'scout', '/tmp/wt', 'flowryn/contract-00000000-t1', 'abc', 'h', 1, 1, ?1, ?2, ?3, ?4)`,
    ).run(workspaceId, harness.pid, harness.start, harness.exe);
  });
  db.close();
}

function deps(): RecoverDeps & { lines: string[] } {
  const lines: string[] = [];
  return { lines, git, log: (line) => lines.push(line), removeHome: (home) => removeScratchHome(home, (line) => lines.push(line), 2_000), now: Date.now };
}

describe("releasing what a killed contract run owned", () => {
  test(
    "assumption: exactly the manifest's and the scratch database's ids are released; an unrelated workspace, process and directory stay",
    async () => {
      const root = tempDir();
      const herdr = await FakeHerdr.start(join(root, "h.sock"), { env: {}, logDir: root });
      herdrs.push(herdr);
      const home = realpathSync(mkdtempSync(join(root, "fwc-")));
      writeFileSync(join(home, "config.toml"), "# scratch\n");
      const unrelatedDir = join(root, "fwc-not-ours");
      mkdirSync(unrelatedDir);
      const owned = { daemon: await sleeper(), harness: await sleeper(), copied: await sleeper() };
      const unrelated = await sleeper();
      const ownWorkspace = await workspace(herdr, home);
      const otherWorkspace = await workspace(herdr, root);
      // The harness only in the scratch database (the run was killed before its cleanup copied it), the other only in the manifest.
      scratchDb(home, ownWorkspace, owned.harness);
      const manifest = join(root, "auto.owned.json");
      const resources: OwnedResources = {
        runner: null,
        home,
        herdr_socket: herdr.socket,
        branch_prefix: "flowryn/contract-00000000-",
        project: null,
        daemon: owned.daemon,
        workspaces: [],
        harnesses: [owned.copied],
        cleanup: null,
      };
      writeManifest(manifest, resources);

      const d = deps();
      const outcome = await recoverOwned(manifest, d);
      expect(outcome).toMatchObject({ ok: true, problems: [], by: "daemon" });
      for (const proc of Object.values(owned)) expect(await isAlive(proc)).toBe(false);
      expect(await isAlive(unrelated)).toBe(true);
      expect(herdr.workspaces.has(ownWorkspace)).toBe(false);
      expect(herdr.workspaces.has(otherWorkspace)).toBe(true);
      expect(existsSync(home)).toBe(false);
      expect(existsSync(unrelatedDir)).toBe(true);
      // The outcome is kept with the manifest, next to the ids it settled.
      expect(readManifest(manifest).owned).toMatchObject({ workspaces: [ownWorkspace], cleanup: { ok: true, by: "daemon" } });
    },
    30_000,
  );

  test("assumption: what cannot be released is an explicit failure naming it, never dropped", async () => {
    const root = tempDir();
    const home = realpathSync(mkdtempSync(join(root, "fwc-")));
    const manifest = join(root, "auto.owned.json");
    writeManifest(manifest, {
      runner: null,
      home,
      herdr_socket: join(root, "no-herdr.sock"),
      branch_prefix: "flowryn/contract-00000000-",
      project: null,
      daemon: null,
      workspaces: ["w9"],
      harnesses: [],
      cleanup: null,
    });
    const outcome = await recoverOwned(manifest, deps());
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toEqual([expect.stringMatching(/^Herdr workspace w9 not closed: Herdr socket .*no-herdr\.sock/)]);
    // The rest was still released.
    expect(existsSync(home)).toBe(false);
  });

  test("assumption: a manifest that is missing or unreadable is reported as unknown ownership, not as nothing owned", async () => {
    const root = tempDir();
    expect(await recoverOwned(join(root, "absent.owned.json"), deps())).toMatchObject({ ok: false, problems: [expect.stringContaining("what the run owned is unknown")] });
    writeFileSync(join(root, "bad.owned.json"), "{ not json");
    expect(await recoverOwned(join(root, "bad.owned.json"), deps())).toMatchObject({ ok: false, problems: [expect.stringContaining("unreadable")] });
    writeFileSync(join(root, "thin.owned.json"), JSON.stringify({ home: "/tmp/fwc-x" }));
    expect(await recoverOwned(join(root, "thin.owned.json"), deps())).toMatchObject({ ok: false, problems: [expect.stringContaining("lacks")] });
  });

  test("assumption: only a real fwc-* directory is ever removed as a scratch home", async () => {
    const root = tempDir();
    const notScratch = join(root, "projects");
    mkdirSync(notScratch);
    const link = join(root, "fwc-link");
    symlinkSync(notScratch, link);
    expect(removableHome(notScratch)).toContain("not a contract scratch home");
    expect(removableHome("fwc-relative")).toContain("not a contract scratch home");
    expect(removableHome(link)).toContain("not a directory");
    expect(removableHome(join(root, "fwc-gone"))).toBeNull();

    const manifest = join(root, "auto.owned.json");
    writeManifest(manifest, { runner: null, home: notScratch, herdr_socket: "/s", branch_prefix: "flowryn/contract-00000000-", project: null, daemon: null, workspaces: [], harnesses: [], cleanup: null });
    const outcome = await recoverOwned(manifest, deps());
    expect(outcome).toMatchObject({ ok: false, problems: [expect.stringContaining("scratch home left alone")] });
    expect(existsSync(notScratch)).toBe(true);
  });
});
