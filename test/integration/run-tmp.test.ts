/**
 * Every worker's own temp directory (docs/notes/2026-10-22-give-every-worker-73.md)
 * through the real daemon, launcher and cleanup, against a fake Herdr and
 * fake workers. The incident: two workers wrote `$TMPDIR/intent.txt` to one
 * shared directory, and one PR was reviewed against the other's task.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

const uid = process.getuid?.() ?? 0;

/** The environment Herdr's workspace.create gave a run's pane. */
function paneEnv(env: FleetEnv, run: string): Record<string, string> {
  const create = env.herdr.calls.filter((c) => c.method === "workspace.create").find((c) => (c.params.env as Record<string, string>).FLOWRYN_RUN === run);
  if (!create) throw new Error(`no workspace.create for ${run}`);
  return create.params.env as Record<string, string>;
}

function allowWrite(env: FleetEnv, run: string): string[] {
  const settings = JSON.parse(readFileSync(join(env.h.stateDir, "runs", run, "claude-settings.json"), "utf8")) as { sandbox?: { filesystem?: { allowWrite?: string[] } } };
  return settings.sandbox?.filesystem?.allowWrite ?? [];
}

describe("each run's own TMPDIR", () => {
  test(
    "two concurrent runs (and a Pi one) get different private TMPDIRs, allowed by their sandbox, removed when each is cleaned up",
    async () => {
      const env = await makeFleetEnv();
      envs.push(env);
      const steps = "FAKE: tmpdir tmpdir.txt\nFAKE: wait-file go\nFAKE: deliver summary.md done\nFAKE: sleep 30000";
      const a = await env.dispatch(`Scout one\n${steps}`);
      const b = await env.dispatch(`Scout two\n${steps}`);
      const p = await env.dispatch(`Scout three\n${steps}`, { harness: "pi" });
      const reported = (task: string) => join(env.h.dataDir, task, "tmpdir.txt");
      for (const { task } of [a, b, p]) await waitUntil(() => existsSync(reported(task)), 20_000, `${task} to report its TMPDIR`);
      for (const { run } of [a, b, p]) expect(env.run(run).state).toBe("running");

      const seen = (task: string) => readFileSync(reported(task), "utf8").trim();
      const [tmpA, tmpB, tmpP] = [seen(a.task), seen(b.task), seen(p.task)];
      expect(new Set([tmpA, tmpB, tmpP]).size).toBe(3);
      // Claude: TMPDIR is the per-uid dir its sandbox derives from CLAUDE_CODE_TMPDIR, so it is the same in and out of it.
      for (const [{ run }, tmp] of [[a, tmpA], [b, tmpB]] as const) {
        const pane = paneEnv(env, run);
        expect(pane.TMPDIR).toBe(tmp);
        expect(tmp).toBe(join(pane.CLAUDE_CODE_TMPDIR!, `claude-${uid}`));
        expect(dirname(pane.CLAUDE_CODE_TMPDIR!)).toBe(env.h.tmpRoot);
        expect(allowWrite(env, run)).toContain(pane.CLAUDE_CODE_TMPDIR!);
      }
      // Pi: no sandbox, so the run dir itself.
      expect(paneEnv(env, p.run).TMPDIR).toBe(tmpP);
      expect(paneEnv(env, p.run).CLAUDE_CODE_TMPDIR).toBeUndefined();
      expect(dirname(tmpP)).toBe(env.h.tmpRoot);
      for (const tmp of [tmpA, tmpB, tmpP]) expect(statSync(tmp).mode & 0o777).toBe(0o700);
      // What each wrote to "$TMPDIR/intent.txt" is its own: the incident's overwrite cannot happen.
      expect(readFileSync(join(tmpA, "intent.txt"), "utf8").trim()).toBe(a.run);
      expect(readFileSync(join(tmpB, "intent.txt"), "utf8").trim()).toBe(b.run);

      // A lands and is cleaned up: its directory goes; the others, still running, keep theirs.
      writeFileSync(join(env.h.dataDir, a.task, "go"), "");
      await env.waitRun(a.run, (r) => r.state === "cleaned", "the first scout cleaned up");
      await waitUntil(() => !existsSync(dirname(tmpA)), 10_000, "the first run's temp dir removed");
      expect(existsSync(tmpB)).toBe(true);
      expect(existsSync(tmpP)).toBe(true);
      expect(env.events(a.run)).not.toContain("run.tmp_remove_failed");

      // A daemon restart keeps a live run's directory (the startup sweep only takes what no run wants).
      await env.daemon.stop();
      await env.restartDaemon();
      expect(existsSync(tmpB)).toBe(true);
      expect(existsSync(tmpP)).toBe(true);
    },
    120_000,
  );
});
