import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateFiles } from "../../src/config/paths.ts";
import { makeFleetEnv, makeRepo, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * `flowryn project rm` through the real daemon (docs/notes/2026-11-22-flowryn-project-rm-74.md):
 * a project with an open decision is refused; one with none is removed, its checkout stays,
 * and upkeep's sync, which logged a failed fetch for it every pass, never names it again.
 */

let env: FleetEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("project rm", () => {
  test(
    "refuses a project with open work; removes one without, and upkeep stops syncing it",
    async () => {
      env = await makeFleetEnv({ extraConfig: "[upkeep]\ninterval_ms = 300" });
      const e = env;
      const log = () => {
        const path = join(stateFiles(e.h.stateDir).logs, "flowrynd.log");
        return existsSync(path) ? readFileSync(path, "utf8") : "";
      };
      for (const id of ["gone", "busy"]) {
        const path = makeRepo(join(e.h.home, id));
        git(path, ["remote", "add", "origin", join(e.h.home, "no-such-origin.git")]);
        expect((await e.json(["project", "add", path, "--id", id, "--mode", "local-only"])).code).toBe(0);
      }
      await waitUntil(() => log().includes("upkeep: sync gone: skipped (fetch_failed"), 15_000, "a failed fetch logged for gone");

      expect((await e.json(["decision", "add", "--key", "k", "--question", "Keep busy?", "--project", "busy"])).code).toBe(0);
      const refused = await e.json(["project", "rm", "busy"]);
      expect(refused.code).not.toBe(0);
      expect((refused.reply as { error: { code: string; message: string } }).error).toMatchObject({ code: "project_busy", message: expect.stringContaining("open decisions") });

      const removed = await e.json(["project", "rm", "gone", "--reason", "retired"]);
      expect(removed.code).toBe(0);
      expect(existsSync(join(e.h.home, "gone", ".git"))).toBe(true);
      const listed = (await e.json(["project", "list"])).reply as { data: { projects: { id: string }[] } };
      expect(listed.data.projects.map((p) => p.id).toSorted()).toEqual(["busy", "web"]);

      // Two later passes (web has no origin, so each pass logs its skip) name gone no more.
      const from = log().length;
      await waitUntil(() => log().slice(from).split("upkeep: sync web:").length > 3, 15_000, "two more upkeep passes");
      expect(log().slice(from)).not.toContain("sync gone");
      expect(log().slice(from)).toContain("upkeep: sync busy: skipped (fetch_failed");
    },
    { timeout: 60_000 },
  );
});
