import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPiModel } from "../../src/cli/commands/setup.ts";
import type { FlowrynConfig } from "../../src/config/config.ts";
import { piAgentSource, realPiTable, scriptedPiTable, SCRIPTED_MODEL, seedAgentDir, writeScriptedProvider } from "../../src/contracts/pi-profile.ts";
import { pollFor, scratchConfig, type ContractOptions } from "../../src/contracts/runner.ts";
import { ackBlocker, contractBody, IGNORED_GRACE_MS, waitAcked, type ContractEnv } from "../../src/contracts/suite.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import type { MessageRow } from "../../src/lifecycle/steers.ts";

/**
 * The deterministic Pi contract gate and the named ack causes
 * (docs/notes/2026-10-11-make-the-pi-rv.md). The rows the real hooks write
 * are checked end to end in test/integration/contract-ack-blocker.test.ts.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pigate-")));
  dirs.push(dir);
  return dir;
}

const T0 = 1_000_000;

function run(fields: Partial<RunRow> = {}): RunRow {
  return { id: "r1", state: "running", liveness: "busy", idle_since: null, ...fields } as RunRow;
}

function steer(fields: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m1",
    run_id: "r1",
    body: "ack this",
    created_at: T0,
    rings: 1,
    last_rung_at: T0 + 2,
    carried_at: T0 + 2,
    acked_at: null,
    decision_id: null,
    seen_at: null,
    ring_state: "carried",
    ring_idle: 0,
    seen_via: null,
    urgent: 0,
    preempted_at: null,
    end_turn: 0,
    ...fields,
  };
}

const seen = (fields: Partial<MessageRow> = {}) => steer({ seen_at: T0 + 25_100, ring_state: "seen", ...fields });

describe("ackBlocker: why a steer's acknowledgement can no longer come", () => {
  test("an acknowledged steer is never blocked, whatever the run did after", () => {
    expect(ackBlocker(run({ state: "landed" }), seen({ acked_at: T0 + 26_000 }), T0 + 60_000)).toBeNull();
  });

  test("the worker delivered first: the run landed or was cleaned", () => {
    expect(ackBlocker(run({ state: "landed" }), steer({ id: "m2" }), T0 + 5_000)).toBe("the worker delivered before m2 (run landed); m2 carried +2ms, not seen for 5.0s");
    expect(ackBlocker(run({ state: "cleaned" }), seen(), T0 + 30_000)).toStartWith("the worker delivered before m1 (run cleaned); m1 carried +2ms, seen +25.1s");
  });

  test("the run ended first: failed or cancelled", () => {
    expect(ackBlocker(run({ state: "failed" }), steer(), T0 + 1_000)).toStartWith("the run failed before m1 was acknowledged; m1 carried +2ms");
    expect(ackBlocker(run({ state: "cancelled" }), steer(), T0 + 1_000)).toStartWith("the run cancelled before m1 was acknowledged");
  });

  test("seen, then the turn ended without an ack and stayed ended past the grace: the model ignored it", () => {
    const ended = T0 + 27_000;
    expect(ackBlocker(run({ liveness: "idle", idle_since: ended }), seen(), ended + IGNORED_GRACE_MS)).toBe(
      "m1 seen +25.1s, turn ended without ack (model ignored the steer); m1 carried +2ms, seen +25.1s",
    );
  });

  test("a turn end inside the grace waits: a continuation may still be on its way", () => {
    const ended = T0 + 27_000;
    expect(ackBlocker(run({ liveness: "idle", idle_since: ended }), seen(), ended + IGNORED_GRACE_MS - 1)).toBeNull();
  });

  test("a turn end before the steer was seen is the idle worker it woke, not an ignored steer", () => {
    expect(ackBlocker(run({ liveness: "idle", idle_since: T0 + 25_000 }), seen(), T0 + 600_000)).toBeNull();
    expect(ackBlocker(run({ liveness: "idle", idle_since: T0 + 25_100 }), seen(), T0 + 600_000)).toBeNull();
  });

  test("an unseen steer, or a busy run (idle_since cleared), keeps waiting", () => {
    expect(ackBlocker(run({ liveness: "idle", idle_since: T0 + 30_000 }), steer(), T0 + 600_000)).toBeNull();
    // A lapsed busy lease turns liveness idle mid-tool, but only a turn-end hook sets idle_since.
    expect(ackBlocker(run({ liveness: "idle", idle_since: null }), seen(), T0 + 600_000)).toBeNull();
  });

  test("a steer not found yet keeps waiting on a live run and is named generically on a landed one", () => {
    expect(ackBlocker(run(), undefined, T0)).toBeNull();
    expect(ackBlocker(run({ state: "landed" }), undefined, T0)).toBe("the worker delivered before the steer (run landed)");
  });
});

describe("waitAcked fails fast with the named cause, and a timeout names the steer's timings", () => {
  function env(current: () => { run: RunRow; steers: MessageRow[] }): ContractEnv {
    const waitFor: ContractEnv["waitFor"] = (what, timeoutMs, check, explain) => pollFor(what, timeoutMs, check, explain, async () => null);
    return {
      waitFor,
      run: () => current().run,
      steers: () => current().steers,
    } as unknown as ContractEnv;
  }

  test("returns the acknowledged steer", async () => {
    const acked = seen({ created_at: Date.now(), acked_at: Date.now() });
    expect(await waitAcked(env(() => ({ run: run(), steers: [acked] })), "m1", 1_000)).toBe(acked);
  });

  test("a run that landed meanwhile fails the wait at once, long before its timeout", async () => {
    let state: RunRow["state"] = "running";
    setTimeout(() => (state = "landed"), 150);
    const started = Date.now();
    const created = Date.now();
    const pending = waitAcked(env(() => ({ run: run({ state }), steers: [steer({ id: "m2", created_at: created, carried_at: created + 2, last_rung_at: created + 2 })] })), "m2", 60_000);
    await expect(pending).rejects.toThrow(/^the worker delivered before m2 \(run landed\); m2 carried \+2ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a turn that ended after the steer was seen fails the wait once the grace has passed", async () => {
    const now = Date.now();
    const ignored = seen({ created_at: now - 40_000, carried_at: now - 39_998, last_rung_at: now - 39_998, seen_at: now - 14_900 });
    const pending = waitAcked(env(() => ({ run: run({ liveness: "idle", idle_since: now - IGNORED_GRACE_MS - 1 }), steers: [ignored] })), "m1", 60_000);
    await expect(pending).rejects.toThrow(/^m1 seen \+25\.1s, turn ended without ack \(model ignored the steer\)/);
  });

  test("a timeout names the steer's carried and seen timings", async () => {
    const created = Date.now();
    const unseen = steer({ created_at: created, carried_at: created + 2, last_rung_at: created + 2 });
    await expect(waitAcked(env(() => ({ run: run(), steers: [unseen] })), "m1", 300)).rejects.toThrow(
      /^timed out after 0s waiting for steer m1 to be acknowledged \(m1 carried \+2ms, not seen for \d+ms\)$/,
    );
  });
});

describe("the Pi gate's profile", () => {
  /** A user config whose Pi profile is the one the scout found flaky: openrouter/free, plus an extension of their own. */
  function options(model: string | null, piProfile?: "scripted" | "real"): ContractOptions {
    const workers = { pi: { model: "openrouter/free", extensions: ["/Users/me/.pi/ext.ts"], effort: "high", env: { HTTPS_PROXY: "http://proxy" } } };
    return { harness: "pi", config: { tools: {}, extra: { workers } } as unknown as FlowrynConfig, herdrSocket: "/missing", project: null, model, piProfile, keep: false, log: () => {} };
  }
  const pin = { harness: "pi" as const, binary: "/opt/pi/pi-0.87.1", version: "0.87.1" };
  const piTable = (toml: string) => (Bun.TOML.parse(toml) as { workers: { pi: Record<string, unknown> } }).workers.pi;

  test("the gate runs the scripted model in a fixed scratch profile, whatever [workers.pi] and --model say", () => {
    for (const model of [null, "openrouter/free"]) {
      const pi = piTable(scratchConfig(options(model), pin, "/scratch/fwc-x", "flowryn/contract-x-"));
      expect(pi).toEqual(scriptedPiTable("/scratch/fwc-x"));
      expect(pi).toEqual({
        model: SCRIPTED_MODEL,
        extensions: ["/scratch/fwc-x/pi/scripted-provider.ts"],
        agent_dir: "/scratch/fwc-x/pi-agent",
        session_dir: "/scratch/fwc-x/pi-sessions",
        no_context_files: true,
        env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      });
    }
  });

  test("the real-model pass keeps your profile with the named model and scratch agent and session dirs", () => {
    const pi = piTable(scratchConfig(options("openrouter/qwen:free", "real"), pin, "/scratch/fwc-y", "flowryn/contract-y-"));
    expect(pi).toEqual(realPiTable({ model: "openrouter/free", extensions: ["/Users/me/.pi/ext.ts"], effort: "high", env: { HTTPS_PROXY: "http://proxy" } }, "openrouter/qwen:free", "/scratch/fwc-y"));
    expect(pi).toMatchObject({ model: "openrouter/qwen:free", extensions: ["/Users/me/.pi/ext.ts"], agent_dir: "/scratch/fwc-y/pi-agent", session_dir: "/scratch/fwc-y/pi-sessions" });
    expect(() => scratchConfig(options(null, "real"), pin, "/scratch/fwc-y", "flowryn/contract-y-")).toThrow("a real-model Pi pass needs a model");
  });

  test("Claude's --model still sets its worker model", () => {
    const claude = { ...options("claude-sonnet-5-5"), harness: "claude" as const };
    expect(scratchConfig(claude, { ...pin, harness: "claude" }, "/scratch/fwc-z", "flowryn/contract-z-")).toContain('model = "claude-sonnet-5-5"');
  });

  test("only --model on Pi naming a model other than the scripted one asks for the informational pass", () => {
    expect(realPiModel("pi", "openrouter/qwen:free")).toBe("openrouter/qwen:free");
    expect(realPiModel("pi", SCRIPTED_MODEL)).toBeNull();
    expect(realPiModel("pi", null)).toBeNull();
    expect(realPiModel("claude", "openrouter/qwen:free")).toBeNull();
  });

  test("assumption: the provider the compiled binary embeds is the spike's scripted provider, and the gate's script needs it", async () => {
    const home = scratch();
    const path = await writeScriptedProvider(home);
    expect(path).toBe(join(home, "pi", "scripted-provider.ts"));
    expect(readFileSync(path, "utf8")).toBe(readFileSync(join(import.meta.dir, "../../spikes/pi/lib/scripted-provider.ts"), "utf8"));
    expect(readFileSync(path, "utf8")).toContain('const PROVIDER = "flowryn-scripted"');
    expect(contractBody("pi", true)).toContain("FLOWRYN-SCRIPT: ");
  });
});

describe("the real-model pass's credentials", () => {
  test("assumption: a real model needs only auth.json, models.json and the model catalogue; each is copied when present, and the source is only read", () => {
    const source = join(scratch(), "own-agent");
    mkdirSync(join(source, "sessions"), { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"openrouter":{"type":"api_key","key":"k"}}');
    writeFileSync(join(source, "models-store.json"), "{}");
    writeFileSync(join(source, "settings.json"), '{"defaultModel":"free"}');
    const target = join(scratch(), "pi-agent");
    expect(seedAgentDir(source, target)).toEqual(["auth.json", "models-store.json"]);
    expect(readdirSync(target).toSorted()).toEqual(["auth.json", "models-store.json"]);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toBe(readFileSync(join(source, "auth.json"), "utf8"));
    expect(readdirSync(source).toSorted()).toEqual(["auth.json", "models-store.json", "sessions", "settings.json"]);
  });

  test("no auth.json: refused before anything is copied", () => {
    const source = scratch();
    const target = join(scratch(), "pi-agent");
    expect(() => seedAgentDir(source, target)).toThrow(`no auth.json in ${source}`);
    expect(existsSync(target)).toBe(false);
  });

  test("the source is [workers.pi] agent_dir, else PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
    const config = (agentDir?: string) => ({ home: "/h", data_dir: "/h/data", extra: { workers: agentDir ? { pi: { agent_dir: agentDir } } : {} } }) as unknown as FlowrynConfig;
    expect(piAgentSource(config("/cfg/agent"), { PI_CODING_AGENT_DIR: "/env/agent" })).toBe("/cfg/agent");
    expect(piAgentSource(config(), { PI_CODING_AGENT_DIR: "/env/agent" })).toBe("/env/agent");
    expect(piAgentSource(config(), {})).toEndWith("/.pi/agent");
  });
});
