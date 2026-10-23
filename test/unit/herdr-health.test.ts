import { accountById } from "../../src/config/accounts.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/config.ts";
import { migrate, openDb, type Db } from "../../src/db/db.ts";
import { checkStart, type StartDeps } from "../../src/lifecycle/dispatch.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import { herdrEpisode } from "../../src/reconcile/herdr-health.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { dir: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "fw-herdr-health-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  return { dir, db };
}

function eventCount(db: Db, kind: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(kind) as { n: number }).n;
}

describe("Herdr outage episode", () => {
  test("a dispatch-started episode ends on the next successful ping", async () => {
    const { dir, db } = scratch();
    let reachable = false;
    let clock = 1_000;
    const runtime = {
      ping: async () => {
        if (!reachable) throw new Error("connect ENOENT");
      },
    } as unknown as HerdrRuntime;
    const deps: StartDeps = {
      db,
      config: () => defaultConfig(dir),
      runtime: () => runtime,
      harnessVersion: async () => null,
      git: async () => null,
      now: () => clock,
    };
    const project = { id: "web", path: dir, default_branch: "main" } as ProjectRow;

    await expect(checkStart(deps, project, accountById(defaultConfig(dir), "claude"))).rejects.toMatchObject({ code: "herdr_unavailable" });
    expect(herdrEpisode(db)).toEqual({ since: 1_000, detail: "connect ENOENT" });

    reachable = true;
    clock = 5_000;
    await expect(checkStart(deps, project, accountById(defaultConfig(dir), "claude"))).rejects.not.toMatchObject({ code: "herdr_unavailable" });
    expect(herdrEpisode(db)).toBeNull();
    expect(eventCount(db, "herdr.reachable")).toBe(1);

    await expect(checkStart(deps, project, accountById(defaultConfig(dir), "claude"))).rejects.not.toMatchObject({ code: "herdr_unavailable" });
    expect(eventCount(db, "herdr.reachable")).toBe(1);
  });
});
