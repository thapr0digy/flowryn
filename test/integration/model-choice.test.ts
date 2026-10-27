import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

/**
 * A worker's model and effort end to end (docs/notes/2026-10-24-model-and-effort-sc.md):
 * through the real CLI and daemon with a fake Herdr, the typed launch carries
 * what the task chose, else the workflow's default, else the account's.
 */

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

const DEFAULTS = `
[workflows.scout.claude]
effort = "high"
`;

async function fleet(extra = DEFAULTS): Promise<FleetEnv> {
  const env = await makeFleetEnv({ extraConfig: extra });
  envs.push(env);
  return env;
}

/** The arguments of the newest agent.start (the typed harness launch). */
function lastStart(env: FleetEnv): string[] {
  const start = env.herdr.calls.filter((c) => c.method === "agent.start").at(-1)!;
  return (start.params as { args: string[] }).args;
}

/** The value after a flag in a launch, or null when the launch has no such flag. */
function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1]!;
}

function payload(env: FleetEnv, runId: string, kind: string): Record<string, unknown> {
  const db = env.h.db();
  try {
    const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq DESC LIMIT 1").get(runId, kind) as { payload: string };
    return JSON.parse(row.payload) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

async function dispatch(env: FleetEnv, flags: string[], body = "look around\nFAKE: sleep 60000"): Promise<{ code: number; reply: Record<string, unknown> }> {
  return env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", ...flags, "--body-file", "-"], { stdin: body });
}

/** Edit config.toml and have the daemon read it (SIGHUP), as you would. */
async function editConfig(env: FleetEnv, edit: (text: string) => string): Promise<void> {
  const file = join(env.h.home, "config.toml");
  const before = ((await env.json(["config"])).reply.data as { daemon_reload?: string }).daemon_reload;
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  process.kill(env.daemon.pid, "SIGHUP");
  await waitUntil(async () => {
    const reload = ((await env.json(["config"])).reply.data as { daemon_reload?: string }).daemon_reload;
    return reload !== undefined && reload !== before;
  }, 10_000, "the daemon to read the edited config");
}

describe("model and effort", () => {
  test("dispatch's own model wins, the workflow's effort applies, and dispatch, the launch and show all name the source", async () => {
    const env = await fleet();
    const sent = await dispatch(env, ["--model", "sonnet"]);
    expect(sent.code).toBe(0);
    const { run: runId, task } = sent.reply.data as { run: string; task: string };
    expect(sent.reply.data).toMatchObject({ model: "sonnet (dispatch)", effort: "high (workflow scout)" });
    const run = await env.waitRun(runId, (r) => r.proc_pid !== null, "the worker launched");
    expect(run).toMatchObject({ model: "sonnet", effort: "high", model_pin: "sonnet", effort_pin: null });
    expect(flag(lastStart(env), "--model")).toBe("sonnet");
    expect(flag(lastStart(env), "--effort")).toBe("high");
    expect(payload(env, runId, "run.launched")).toMatchObject({ model: "sonnet", effort: "high", model_source: "dispatch", effort_source: "workflow scout" });
    const shown = await env.json(["show", task]);
    expect(shown.reply.data).toMatchObject({ model: "sonnet (dispatch)", effort: "high (workflow scout)" });
  }, 30_000);

  test("a resume keeps the task's own choice and follows a workflow edit made since", async () => {
    const env = await fleet();
    const sent = await dispatch(env, ["--model", "sonnet"], "look around\nFAKE: sleep 3000\nFAKE: sleep 60000");
    const runId = (sent.reply.data as { run: string }).run;
    const busy = await env.waitRun(runId, (r) => r.liveness === "busy", "busy");
    await editConfig(env, (text) => text.replace('[workflows.scout.claude]\neffort = "high"', '[workflows.scout.claude]\nmodel = "opus"\neffort = "low"'));
    env.herdr.killHarness(busy.pane_id!, "SIGKILL");
    const resumed = await env.waitRun(runId, (r) => r.resume_count === 1 && r.proc_pid !== null && r.proc_pid !== busy.proc_pid, "the resumed worker", 30_000);
    expect(lastStart(env)).toContain("--resume");
    expect(flag(lastStart(env), "--model")).toBe("sonnet");
    expect(flag(lastStart(env), "--effort")).toBe("low");
    expect(resumed).toMatchObject({ model: "sonnet", effort: "low" });
  }, 60_000);

  test("a bad effort or model refuses before any run exists", async () => {
    const env = await fleet();
    const effort = await dispatch(env, ["--effort", "minimal"]);
    expect(effort.code).toBe(3);
    expect(JSON.stringify(effort.reply)).toContain("claude effort must be one of low, medium, high, xhigh, max");
    const model = await dispatch(env, ["--model", "sonnet; id"]);
    expect(model.code).toBe(3);
    expect(JSON.stringify(model.reply)).toContain("is not a model name");
    const plan = await env.json(["plan", "web", "--body-file", "-"], { stdin: "## One\neffort: off\ndo it\n" });
    expect(plan.code).toBe(3);
    const db = env.h.db();
    expect((db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM plan_phases").get() as { n: number }).n).toBe(0);
    db.close();
  }, 30_000);

  test("a home that sets none of this launches with no model or effort flag, as before", async () => {
    const env = await fleet("");
    const sent = await dispatch(env, []);
    const runId = (sent.reply.data as { run: string }).run;
    expect(sent.reply.data).toMatchObject({ model: "default (harness default)", effort: "default (harness default)" });
    await env.waitRun(runId, (r) => r.proc_pid !== null, "the worker launched");
    expect(lastStart(env)).not.toContain("--model");
    expect(lastStart(env)).not.toContain("--effort");
  }, 30_000);

  test("a live scout promoted with --model relaunches as a ship on that model; the workflow's effort follows the new workflow", async () => {
    const env = await fleet(`${DEFAULTS}\n[workflows.fix.claude]\neffort = "medium"`);
    const sent = await dispatch(env, [], "Scout it\nFAKE: sleep 400\nFAKE: sleep 60000");
    const { run: runId, task } = sent.reply.data as { run: string; task: string };
    const scouting = await env.waitRun(runId, (r) => r.liveness === "busy" || r.liveness === "idle", "the scout at work");
    expect(flag(lastStart(env), "--effort")).toBe("high");
    const promoted = await env.json(["promote", task, "--model", "opus", "--body-file", "-"], { stdin: "Fix it." });
    expect(promoted.code).toBe(0);
    await env.waitRun(runId, (r) => r.proc_pid !== null && r.proc_pid !== scouting.proc_pid && r.pending_launch === null, "the relaunched worker", 20_000);
    expect(flag(lastStart(env), "--model")).toBe("opus");
    expect(flag(lastStart(env), "--effort")).toBe("medium");
  }, 40_000);

  test("a plan phase's model: and effort: lines reach its worker; --model on dispatch --blocked-by is kept on the queued phase", async () => {
    const env = await fleet(`${DEFAULTS}\n[sched]\npass_ms = 250`);
    const filed = await env.json(["plan", "web", "--body-file", "-"], { stdin: "## Phase 1: one\nmodel: opus\neffort: max\ndo it\nFAKE: sleep 60000\n" });
    expect(filed.code).toBe(0);
    const phase = (filed.reply.data as { phases: { task: string }[] }).phases[0]!.task;
    const db = () => env.h.db();
    await waitUntil(() => {
      const d = db();
      try {
        return d.query("SELECT proc_pid FROM runs WHERE task_id = ?1 AND proc_pid IS NOT NULL").get(phase) !== null;
      } finally {
        d.close();
      }
    }, 20_000, "the phase's worker to start by itself");
    expect(flag(lastStart(env), "--model")).toBe("opus");
    expect(flag(lastStart(env), "--effort")).toBe("max");

    const queued = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", phase, "--model", "haiku", "--body-file", "-"], { stdin: "after it" });
    expect(queued.code).toBe(0);
    const d = db();
    const row = d.query("SELECT model, effort FROM plan_phases WHERE task_id = ?1").get((queued.reply.data as { task: string }).task);
    d.close();
    expect(row).toEqual({ model: "haiku", effort: null });
  }, 40_000);
});
