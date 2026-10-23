/**
 * Workers launch whatever the user's shell does at startup
 * (docs/notes/2026-10-17-workers-launch-reliably-5a.md), against the fake
 * Herdr: its server shell can eat the first typed character as oh-my-zsh's
 * update prompt did, and a launch that still fails names what its pane shows.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const f of envs.splice(0)) await f.cleanup();
});

async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const f = await makeFleetEnv({ ...options, timing: { launch_timeout_ms: 3_000, ...options.timing } });
  envs.push(f);
  return f;
}

function failureReason(f: FleetEnv, runId: string): string {
  const db = f.h.db();
  try {
    const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.failed' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | null;
    return row ? String((JSON.parse(row.payload) as { reason: string }).reason) : "";
  } finally {
    db.close();
  }
}

test("a user shell whose startup prompt eats the first typed character does not break a launch: the pane runs Flowryn's shell", async () => {
  const f = await fleet({ herdrShellPrompt: "[oh-my-zsh] Would you like to update? [Y/n]" });
  const { run } = await f.dispatch("FAKE: sleep 60000\n");
  const running = await f.waitRun(run, (r) => r.state === "running" && r.proc_pid !== null, "the worker launched");
  expect(running.proc_pid).toBe(f.herdr.harnessPid(running.pane_id!)!);
  expect(f.herdr.panes.get(running.pane_id!)!.env.SHELL).toBe(join(f.h.home, "state", "pane-shell"));
}, 60_000);

test("a launch whose harness never appears fails naming the pane's last lines, secrets redacted", async () => {
  const f = await fleet();
  f.herdr.startFailure = "[oh-my-zsh] Would you like to update? [Y/n]\nzsh: no such file or directory: Users/me/.local/bin/claude\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { run } = await f.dispatch("FAKE: sleep 60000\n");
  await f.waitRun(run, (r) => r.state === "failed", "the launch failed");
  const reason = failureReason(f, run);
  expect(reason).toContain("did not appear in pane");
  expect(reason).toContain("the pane's last lines: [oh-my-zsh] Would you like to update? [Y/n] | zsh: no such file or directory: Users/me/.local/bin/claude");
  expect(reason).toContain("[redacted]");
  expect(reason).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
}, 60_000);
