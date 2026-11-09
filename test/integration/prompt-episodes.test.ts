/**
 * After a permission prompt (docs/notes/2026-11-08-keep-workers-off-pp.md),
 * through the real daemon, CLI and hook verbs against the fake Herdr: a
 * prompt that clears with its command blocked gets the fixed steer at once;
 * three within 30 minutes raise one P1 instead; a prompt you answered (the
 * held command ran) gets none; and while a dialog is up, nothing touches it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

const SCREEN = ["⏺ Bash(python3 - <<'PY' ...)", "Dangerous rm operation not ruled out", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function query<T>(env: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = env.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const steers = (env: FleetEnv, run: string) => query<{ id: string; body: string }>(env, "SELECT id, body FROM messages WHERE run_id = ?1 ORDER BY created_at", run);
const episodes = (env: FleetEnv, run: string) => query<{ held_tool: string | null; outcome: string; via: string | null; steer_id: string | null }>(env, "SELECT held_tool, outcome, via, steer_id FROM prompt_episodes WHERE run_id = ?1 ORDER BY id", run);
const openItems = (env: FleetEnv, run: string, kind: string) => query<{ line: string }>(env, "SELECT COALESCE(full_line, line) AS line FROM items WHERE run_id = ?1 AND kind = ?2 AND state != 'resolved'", run, kind);
const keysSent = (env: FleetEnv) => env.herdr.calls.filter((c) => c.method === "pane.send_keys").length;

/** A Claude run whose hooks the test drives itself, through the real `flowryn hook` CLI. */
async function claudeRun() {
  const env = await makeFleetEnv();
  envs.push(env);
  const { run } = await env.dispatch("Build\nFAKE: no-start");
  const launched = await env.waitRun(run, (r) => r.pane_id !== null && r.proc_pid !== null, "launched");
  const pane = launched.pane_id!;
  env.herdr.setStatus(pane, "working");
  const token = env.herdr.panes.get(pane)!.env.FLOWRYN_TOKEN!;
  const hook = (name: string, input: Record<string, unknown> = {}) => env.cli(["hook", name, "--harness", "claude"], { env: { FLOWRYN_TOKEN: token }, stdin: JSON.stringify(input) });
  await hook("prompt");
  /** The worker runs `tool`, and Claude Code puts a permission dialog up for it. */
  const dialog = async (tool: string) => {
    await hook("pre-tool", { tool_name: "Bash", tool_use_id: tool });
    env.herdr.setScreen(pane, SCREEN);
    env.herdr.setStatus(pane, "blocked");
    await hook("notify", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await waitUntil(() => openItems(env, run, "blocked_prompt").length === 1, 10_000, "the blocked_prompt item");
  };
  /** The dialog leaves the screen (answered, or auto-blocked): Herdr reads the agent working again. */
  const cleared = () => {
    env.herdr.setScreen(pane, "");
    env.herdr.setStatus(pane, "working");
  };
  return { env, run, hook, dialog, cleared };
}

describe("after a permission prompt", () => {
  test(
    "blocked (the dialog cleared, the worker moved on): the fixed steer naming the prompt, carried at the next tool result",
    async () => {
      const { env, run, hook, dialog, cleared } = await claudeRun();
      await dialog("toolu_held");
      // Auto-blocked: the reconciler's dialog-gone check clears the item; the held tool never finishes.
      cleared();
      await waitUntil(() => env.events(run).includes("run.prompt_cleared"), 15_000, "the dialog-gone check");
      expect(steers(env, run)).toHaveLength(0);
      await hook("pre-tool", { tool_name: "Edit", tool_use_id: "toolu_next" });
      const made = steers(env, run);
      expect(made).toHaveLength(1);
      expect(made[0]!.body).toContain("blocked by a permission prompt and did not run");
      expect(made[0]!.body).toContain("Dangerous rm operation not ruled out");
      expect(made[0]!.body).toContain("Do not retry it.");
      expect(episodes(env, run)).toEqual([{ held_tool: "toolu_held", outcome: "denied", via: "pre-tool", steer_id: made[0]!.id }]);
      // The usual steer path: carried beside the next tool result.
      const post = await hook("post-tool", { tool_name: "Edit", tool_use_id: "toolu_next" });
      expect(post.stdout).toContain(made[0]!.id);
      expect(post.stdout).toContain("did not run");
      expect(keysSent(env)).toBe(0);
    },
    { timeout: 45_000 },
  );

  test(
    "answered (the held command ran): no steer",
    async () => {
      const { env, run, hook, dialog, cleared } = await claudeRun();
      await dialog("toolu_held");
      cleared();
      await hook("post-tool", { tool_name: "Bash", tool_use_id: "toolu_held" });
      await hook("stop");
      expect(steers(env, run)).toHaveLength(0);
      expect(episodes(env, run)).toEqual([{ held_tool: "toolu_held", outcome: "answered", via: "post-tool", steer_id: null }]);
      expect(openItems(env, run, "blocked_prompt")).toHaveLength(0);
    },
    { timeout: 45_000 },
  );

  test(
    "Claude's PermissionDenied hook for the held tool decides it blocked",
    async () => {
      const { env, run, hook, dialog } = await claudeRun();
      await dialog("toolu_held");
      const reply = await hook("permission-denied", { tool_name: "Bash", tool_use_id: "toolu_held", reason: "denied" });
      // It never tells Claude to retry the call.
      expect(reply.stdout).not.toContain("retry");
      expect(steers(env, run)).toHaveLength(1);
      expect(episodes(env, run)[0]).toMatchObject({ outcome: "denied", via: "permission-denied" });
    },
    { timeout: 45_000 },
  );

  test(
    "three blocked prompts within 30 minutes: two steers, then one P1 for the leader with all three prompt texts",
    async () => {
      const { env, run, hook, dialog, cleared } = await claudeRun();
      for (const n of [1, 2, 3]) {
        await dialog(`toolu_${n}`);
        cleared();
        await hook("stop");
        await hook("prompt");
      }
      expect(steers(env, run)).toHaveLength(2);
      const p1 = openItems(env, run, "prompt_repeat");
      expect(p1).toHaveLength(1);
      expect(p1[0]!.line.match(/Dangerous rm operation not ruled out/g)).toHaveLength(3);
      expect(env.events(run)).toContain("run.prompt_repeat");
    },
    { timeout: 60_000 },
  );

  test(
    "security: while the dialog is still up, Flowryn never answers or dismisses it and sends no steer",
    async () => {
      const { env, run, dialog } = await claudeRun();
      await dialog("toolu_held");
      // Several reconciler passes with the dialog up.
      await Bun.sleep(3_000);
      expect(keysSent(env)).toBe(0);
      expect(env.herdr.calls.some((c) => c.method === "pane.send_text" || c.method === "pane.send_input")).toBe(false);
      expect(openItems(env, run, "blocked_prompt")).toHaveLength(1);
      expect(episodes(env, run)).toEqual([{ held_tool: "toolu_held", outcome: "pending", via: null, steer_id: null }]);
      expect(steers(env, run)).toHaveLength(0);
    },
    { timeout: 45_000 },
  );
});
