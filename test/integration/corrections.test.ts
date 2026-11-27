import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { correctionsPass, CORRECTIONS_SHIPS_KIND } from "../../src/leader/corrections.ts";
import { listProjects } from "../../src/lifecycle/projects.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

/**
 * Corrections become checks (docs/notes/2026-11-22-phase-corrections-become-7t.md) through a real
 * daemon and the fake harness: the weekly pass's scout starts as a scout of the corrections workflow,
 * its stage names the correct skill, and the checks in its report become ships of the project.
 * test/unit/corrections.test.ts covers the list, the pass and the filing rules.
 */

useIntegrationTimeout();

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

describe("the weekly corrections scout", () => {
  test("starts as a scout with the correct skill; the checks its report cites twice become ships; the rest are refused", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    // Manual autonomy: the phases wait, so the test starts the scout itself and the filed ships stay queued.
    expect((await env.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
    for (const lesson of ["User: labels are single words.", "User: no section titles splitting one table."]) {
      expect((await env.json(["learn", "--project", "web", "--correction", lesson])).code).toBe(0);
    }
    const report = [
      "# Corrections in web",
      "## Short answer",
      "One class: clutter.",
      "## Checks to ship",
      "### Labels are single words",
      "Evidence: l1, l2",
      "Enforcer: test",
      "Law: | Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4 |",
      "A test over every label.",
      "### A one-off",
      "Evidence: l1",
      "Words.",
      "## Classes not filed",
      "None.",
    ].join("\\n");
    const db = env.h.db();
    const pass = correctionsPass(db, listProjects(db), Date.now())!;
    expect(pass.filed.map((f) => [f.project, f.corrections])).toEqual([["web", 2]]);
    const scout = pass.filed[0]!.task;
    db.query("UPDATE plan_phases SET body = body || ?2 WHERE task_id = ?1").run(scout, `\nFAKE: deliver-raw report.md ${report}\nFAKE: sleep 30000`);
    db.close();

    const started = await env.json(["dispatch", "web", "--task", scout, "--harness", "claude"]);
    expect(started.code).toBe(0);
    const run = (started.reply.data as { run: string }).run;
    expect((started.reply.data as { workflow: string }).workflow).toBe("corrections");
    await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "the scout's report landed");
    expect(readFileSync(join(env.h.stateDir, "runs", run, "task.md"), "utf8")).toContain(join(env.h.stateDir, "skills", "correct", "SKILL.md"));

    const check = env.h.db();
    expect(check.query("SELECT kind, workflow FROM task_policy WHERE task_id = ?1").get(scout)).toEqual({ kind: "scout", workflow: "corrections" });
    const event = check.query("SELECT payload FROM events WHERE kind = ?1 AND run_id = ?2").get(CORRECTIONS_SHIPS_KIND, run) as { payload: string };
    const filed = JSON.parse(event.payload) as { plan: string; ships: string[]; refused: { title: string; why: string }[] };
    expect(filed.ships).toHaveLength(1);
    expect(filed.refused).toEqual([{ title: "A one-off", why: "cites 1 correction; a class needs 2" }]);
    expect(check.query("SELECT title, workflow FROM plan_phases WHERE task_id = ?1").get(filed.ships[0]!)).toEqual({ title: "Labels are single words", workflow: "fix" });
    const item = check.query("SELECT line FROM items WHERE run_id = ?1 AND kind = 'report_ready'").get(run) as { line: string };
    check.close();
    expect(item.line).toContain(`; 1 check filed as ships (${filed.plan}), 1 refused`);
  });
});
