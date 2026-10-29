import { readFileSync } from "node:fs";
import { FlowrynError } from "../api/errors.ts";
import { STYLE_BLOCK } from "../harness/contract-text.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import type { FlowrynConfig } from "./config.ts";
import { checkEffort, checkModelName, type ModelPins } from "./model-choice.ts";
import { toAbsolute } from "./paths.ts";

/**
 * Typed views of the config sections M5 owns (design section 11): the
 * workflows ([workflows.<id>], data, not code), the capacity pools and the
 * host check ([capacity], [capacity.host]), the default autonomy
 * ([autonomy]), the terse style block ([style]) and the scheduler's clocks
 * ([sched], like [reconcile], for tests and the lab).
 */

export const GATES = ["none", "review", "merge"] as const;
export type GateKind = (typeof GATES)[number];

export interface StageDef {
  id: string;
  /** The skill that holds this stage's know-how, if any. */
  skill: string | null;
  gate: GateKind;
  /** Capacity pools the stage holds while it runs; every run also holds "worker". */
  pools: string[];
  /** Start this stage with a new worker session in the same worktree. */
  fresh: boolean;
}

export interface WorkflowDef {
  id: string;
  stages: StageDef[];
  /** `[workflows.<id>.<harness>] model/effort`: the defaults a run of this workflow starts with (src/config/model-choice.ts). */
  models?: Partial<Record<HarnessId, ModelPins>>;
  /**
   * Frozen by migration 5 for a run already open before M5: its worker has
   * M4's contract (pipeline, then deliver), so its ship slot is granted at
   * delivery time, never required before the pipeline.
   */
  legacy_m4?: boolean;
}

function stage(id: string, extra: Partial<StageDef> = {}): StageDef {
  return { id, skill: null, gate: "none", pools: [], fresh: false, ...extra };
}

/**
 * The built-in workflows; a [workflows.<id>] table replaces one of them or
 * adds another. Visual QA reviews only work with screens to look at:
 * `feature-ui` carries it, `feature` goes from build straight to ship
 * (no-mistakes already covers tests, lint and review there).
 */
export const DEFAULT_WORKFLOWS: Record<string, WorkflowDef> = {
  feature: {
    id: "feature",
    stages: [
      stage("design", { skill: "flowryn-design", gate: "review" }),
      stage("build", { skill: "flowryn-build-test" }),
      stage("ship", { pools: ["validation"], gate: "merge" }),
    ],
  },
  "feature-ui": {
    id: "feature-ui",
    stages: [
      stage("design", { skill: "flowryn-design", gate: "review" }),
      stage("build", { skill: "flowryn-build-test" }),
      stage("qa", { skill: "flowryn-visual-qa", pools: ["docker_env", "browser"], gate: "review" }),
      stage("ship", { pools: ["validation"], gate: "merge" }),
    ],
  },
  fix: { id: "fix", stages: [stage("build"), stage("ship", { pools: ["validation"], gate: "merge" })] },
  scout: { id: "scout", stages: [stage("investigate")] },
};

/** Every run holds a slot of this pool for as long as it has a live worker. */
export const WORKER_POOL = "worker";

export const DEFAULT_POOLS: Record<string, number> = { worker: 20, validation: 5, docker_env: 5, browser: 5 };

export interface HostCheckConfig {
  /** No new grant while the host has less memory available than this (GB). */
  min_free_mem_gb: number;
  /** No new grant while the 1-minute load average per core is above this. */
  max_load_per_core: number;
  /**
   * A command that prints {"free_mem_gb": n, "load_per_core": n} instead of
   * reading vm_stat and the load average (tests and the lab point it at a file).
   */
  probe: string | null;
}

export interface QuotaConfig {
  /** No new Claude run starts while quota-axi reads Claude's effectivePercentRemaining under this; 0 turns it off. */
  floor: number;
}

export interface CapacityConfig {
  pools: Record<string, number>;
  host: HostCheckConfig;
  quota: QuotaConfig;
}

export const DEFAULT_HOST: HostCheckConfig = { min_free_mem_gb: 8, max_load_per_core: 1.5, probe: null };
export const DEFAULT_QUOTA: QuotaConfig = { floor: 5 };

export const AUTONOMY_MODES = ["plan", "manual"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** The scheduler's clocks; every default is the design's number. */
export interface SchedTiming {
  /** A steady pass, so a host that recovers is noticed without an event. */
  pass_ms: number;
  /** Work waiting this long for a grant opens one P1 (design section 16: over 30 min). */
  wait_alert_ms: number;
  /** A host check result is reused this long. */
  host_cache_ms: number;
  /** A validation slot held this long with no progress (a quiet no-mistakes step, or no run going) opens one P1. */
  validation_stuck_ms: number;
  /** The Claude usage-limit pause expires after this, then one run probes it. */
  usage_backoff_ms: number;
  /** Each re-arm doubles the backoff, up to this. */
  usage_backoff_max_ms: number;
  /** A quota-axi reading is reused this long. */
  quota_cache_ms: number;
}

export const DEFAULT_SCHED: SchedTiming = {
  pass_ms: 30_000,
  wait_alert_ms: 30 * 60_000,
  validation_stuck_ms: 30 * 60_000,
  host_cache_ms: 5_000,
  usage_backoff_ms: 15 * 60_000,
  usage_backoff_max_ms: 2 * 60 * 60_000,
  quota_cache_ms: 120_000,
};

const STAGE_ID = /^[a-z][a-z0-9-]{0,23}$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SKILL_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const POOL_NAME = /^[a-z][a-z0-9_]{0,31}$/;

function table(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} must be a table`);
  return value as Record<string, unknown>;
}

function unknownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) if (!known.includes(key)) throw new FlowrynError("config_invalid", `${where} ${key} is not a known setting`);
}

function positiveNumber(value: unknown, where: string, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new FlowrynError("config_invalid", `${where} must be a ${allowZero ? "non-negative" : "positive"} number`);
  }
  return value;
}

export function capacityConfig(config: FlowrynConfig): CapacityConfig {
  const raw = table(config.extra.capacity, "[capacity]");
  const pools: Record<string, number> = { ...DEFAULT_POOLS };
  for (const [name, value] of Object.entries(raw)) {
    if (name === "host" || name === "quota") continue;
    if (!POOL_NAME.test(name)) throw new FlowrynError("config_invalid", `[capacity] ${name} is not a pool name (lowercase letters, digits, _)`);
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `[capacity] ${name} must be a positive integer`);
    pools[name] = value;
  }
  const host = table(raw.host, "[capacity.host]");
  unknownKeys(host, ["min_free_mem_gb", "max_load_per_core", "probe"], "[capacity.host]");
  let probe: string | null = null;
  if (host.probe !== undefined) {
    if (typeof host.probe !== "string" || host.probe.length === 0) throw new FlowrynError("config_invalid", "[capacity.host] probe must be the path of a command");
    probe = toAbsolute(host.probe, config.home);
  }
  const quota = table(raw.quota, "[capacity.quota]");
  unknownKeys(quota, ["floor"], "[capacity.quota]");
  const floor = positiveNumber(quota.floor, "[capacity.quota] floor", DEFAULT_QUOTA.floor, true);
  if (floor > 100) throw new FlowrynError("config_invalid", "[capacity.quota] floor is a percentage, at most 100");
  return {
    pools,
    quota: { floor },
    host: {
      min_free_mem_gb: positiveNumber(host.min_free_mem_gb, "[capacity.host] min_free_mem_gb", DEFAULT_HOST.min_free_mem_gb, true),
      max_load_per_core: positiveNumber(host.max_load_per_core, "[capacity.host] max_load_per_core", DEFAULT_HOST.max_load_per_core),
      probe,
    },
  };
}

/**
 * `[projects.<id>] max_workers` (docs/notes/2026-10-26-a-cap-on-dt.md): at most
 * this many of the project's runs hold a worker slot at once; null without the
 * key, so only `[capacity] worker` binds. A positive integer, else config_invalid.
 */
export function projectMaxWorkers(config: FlowrynConfig, projectId: string): number | null {
  const projects = table(config.extra.projects, "[projects]");
  const value = table(projects[projectId], `[projects.${projectId}]`).max_workers;
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `[projects.${projectId}] max_workers must be a positive integer`);
  return value;
}

/** Every project's worker limit that is set, in config order. */
export function projectWorkerLimits(config: FlowrynConfig): { project: string; max: number }[] {
  const out: { project: string; max: number }[] = [];
  for (const project of Object.keys(table(config.extra.projects, "[projects]"))) {
    const max = projectMaxWorkers(config, project);
    if (max !== null) out.push({ project, max });
  }
  return out;
}

function parseStage(raw: unknown, where: string, pools: Record<string, number>): StageDef {
  const t = table(raw, where);
  unknownKeys(t, ["id", "skill", "gate", "pools", "fresh"], where);
  if (typeof t.id !== "string" || !STAGE_ID.test(t.id)) throw new FlowrynError("config_invalid", `${where} id must be a stage id such as build`);
  const skill = t.skill === undefined ? null : t.skill;
  if (skill !== null && (typeof skill !== "string" || !SKILL_NAME.test(skill))) throw new FlowrynError("config_invalid", `${where} skill must be a skill name such as flowryn-design`);
  const gate = t.gate ?? "none";
  if (typeof gate !== "string" || !(GATES as readonly string[]).includes(gate)) throw new FlowrynError("config_invalid", `${where} gate must be one of ${GATES.join(", ")}`);
  const stagePools = t.pools ?? [];
  if (!Array.isArray(stagePools) || !stagePools.every((p) => typeof p === "string")) throw new FlowrynError("config_invalid", `${where} pools must be a list of pool names`);
  for (const pool of stagePools as string[]) {
    if (pool === WORKER_POOL) throw new FlowrynError("config_invalid", `${where}: every run holds the worker pool already; do not list it`);
    if (!(pool in pools)) throw new FlowrynError("config_invalid", `${where}: pool ${pool} is not in [capacity]`);
  }
  if (t.fresh !== undefined && typeof t.fresh !== "boolean") throw new FlowrynError("config_invalid", `${where} fresh must be true or false`);
  return { id: t.id, skill: skill as string | null, gate: gate as GateKind, pools: [...new Set(stagePools as string[])], fresh: t.fresh === true };
}

/** A workflow's shape: at least one stage, unique ids, a merge gate only on the last stage. */
export function checkWorkflow(wf: WorkflowDef): void {
  if (wf.stages.length === 0) throw new FlowrynError("config_invalid", `[workflows.${wf.id}] needs at least one stage`);
  const seen = new Set<string>();
  wf.stages.forEach((s, i) => {
    if (seen.has(s.id)) throw new FlowrynError("config_invalid", `[workflows.${wf.id}] has two stages named ${s.id}`);
    seen.add(s.id);
    if (s.gate === "merge" && i !== wf.stages.length - 1) throw new FlowrynError("config_invalid", `[workflows.${wf.id}] ${s.id}: only the last stage may have the merge gate`);
    if (s.gate === "review" && i === wf.stages.length - 1) throw new FlowrynError("config_invalid", `[workflows.${wf.id}] ${s.id}: the last stage ends in a delivery, not a review gate`);
  });
}

function parseModels(t: Record<string, unknown>, id: string): Partial<Record<HarnessId, ModelPins>> | undefined {
  const out: Partial<Record<HarnessId, ModelPins>> = {};
  for (const harness of HARNESS_IDS) {
    if (t[harness] === undefined) continue;
    const where = `[workflows.${id}.${harness}]`;
    const raw = table(t[harness], where);
    unknownKeys(raw, ["model", "effort"], where);
    const text = (value: unknown, key: string): string | null => {
      if (value === undefined) return null;
      if (typeof value !== "string" || value.length === 0) throw new FlowrynError("config_invalid", `${where} ${key} must be a non-empty string`);
      return value;
    };
    const model = text(raw.model, "model");
    const effort = text(raw.effort, "effort");
    out[harness] = {
      model: model === null ? null : checkModelName(model, `${where} model`, "config_invalid"),
      effort: effort === null ? null : checkEffort(effort, harness, `${where} effort`, "config_invalid"),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Every workflow: the built-in ones, replaced or extended by [workflows.<id>]
 * tables. A table without stages on a built-in id keeps its stages and only
 * sets the model and effort defaults.
 */
export function workflowsConfig(config: FlowrynConfig): Record<string, WorkflowDef> {
  const pools = capacityConfig(config).pools;
  const raw = table(config.extra.workflows, "[workflows]");
  const out: Record<string, WorkflowDef> = { ...DEFAULT_WORKFLOWS };
  for (const [id, value] of Object.entries(raw)) {
    if (!WORKFLOW_ID.test(id)) throw new FlowrynError("config_invalid", `[workflows.${id}]: a workflow id is lowercase letters, digits and dashes`);
    const t = table(value, `[workflows.${id}]`);
    unknownKeys(t, ["stages", ...HARNESS_IDS], `[workflows.${id}]`);
    const models = parseModels(t, id);
    const builtIn = DEFAULT_WORKFLOWS[id];
    if (t.stages === undefined && builtIn) {
      out[id] = models ? { ...builtIn, models } : builtIn;
      continue;
    }
    if (!Array.isArray(t.stages)) throw new FlowrynError("config_invalid", `[workflows.${id}] stages must be a list of stage tables`);
    const wf: WorkflowDef = { id, stages: t.stages.map((s, i) => parseStage(s, `[workflows.${id}] stage ${i + 1}`, pools)), ...(models ? { models } : {}) };
    checkWorkflow(wf);
    out[id] = wf;
  }
  return out;
}

/** A workflow as config has it now, for its model and effort defaults; null when config no longer has it. */
export function currentWorkflow(config: FlowrynConfig, id: string): WorkflowDef | null {
  return workflowsConfig(config)[id] ?? null;
}

/** The workflow a task of this kind may run: a ship's ends in the merge gate, a scout's does not. */
export function workflowFor(config: FlowrynConfig, id: string, kind: "ship" | "scout"): WorkflowDef {
  const wf = workflowsConfig(config)[id];
  if (!wf) throw new FlowrynError("bad_args", `no workflow ${id}`, `workflows: ${Object.keys(workflowsConfig(config)).join(", ")}`);
  const last = wf.stages[wf.stages.length - 1]!;
  if (kind === "ship" && last.gate !== "merge") throw new FlowrynError("bad_args", `workflow ${id} does not end in the merge gate, so it cannot ship`);
  if (kind === "scout" && last.gate === "merge") throw new FlowrynError("bad_args", `workflow ${id} ends in a merge; a scout delivers a report`);
  return wf;
}

export function defaultAutonomy(config: FlowrynConfig): AutonomyMode {
  const raw = table(config.extra.autonomy, "[autonomy]");
  unknownKeys(raw, ["default"], "[autonomy]");
  const value = raw.default ?? "plan";
  if (typeof value !== "string" || !(AUTONOMY_MODES as readonly string[]).includes(value)) throw new FlowrynError("config_invalid", `[autonomy] default must be one of ${AUTONOMY_MODES.join(", ")}`);
  return value as AutonomyMode;
}

export function schedTiming(config: FlowrynConfig): SchedTiming {
  const raw = table(config.extra.sched, "[sched]");
  unknownKeys(raw, Object.keys(DEFAULT_SCHED), "[sched]");
  const out = { ...DEFAULT_SCHED };
  for (const key of Object.keys(DEFAULT_SCHED) as (keyof SchedTiming)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `[sched] ${key} must be a positive integer`);
    out[key] = value;
  }
  return out;
}

/** The style block has to stay small: it leads every worker's instructions and the leader's system prompt. */
const MAX_STYLE_CHARS = 2_000;

/**
 * The terse style block (design section 11): the design's text by default,
 * your own with `[style] text` or `[style] file`, or none with `terse = false`.
 */
export function styleBlock(config: FlowrynConfig): string | null {
  const raw = table(config.extra.style, "[style]");
  unknownKeys(raw, ["terse", "text", "file"], "[style]");
  if (raw.terse !== undefined && typeof raw.terse !== "boolean") throw new FlowrynError("config_invalid", "[style] terse must be true or false");
  if (raw.text !== undefined && raw.file !== undefined) throw new FlowrynError("config_invalid", "[style] takes text or file, not both");
  if (raw.terse === false) return null;
  let text = STYLE_BLOCK;
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string" || raw.text.trim().length === 0) throw new FlowrynError("config_invalid", "[style] text must be non-empty text");
    text = raw.text.trim();
  } else if (raw.file !== undefined) {
    if (typeof raw.file !== "string" || raw.file.length === 0) throw new FlowrynError("config_invalid", "[style] file must be a path");
    const path = toAbsolute(raw.file, config.home);
    try {
      text = readFileSync(path, "utf8").trim();
    } catch (error) {
      throw new FlowrynError("config_invalid", `[style] file ${path} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
    if (text.length === 0) throw new FlowrynError("config_invalid", `[style] file ${path} is empty`);
  }
  if (text.length > MAX_STYLE_CHARS) throw new FlowrynError("config_invalid", `the [style] block is over ${MAX_STYLE_CHARS} characters; it leads every prompt, so keep it short`);
  return text;
}

/** Validate every section M5 owns; returns the problems (empty when sound). */
export function workflowConfigProblems(config: FlowrynConfig): string[] {
  const problems: string[] = [];
  for (const check of [() => capacityConfig(config), () => workflowsConfig(config), () => defaultAutonomy(config), () => schedTiming(config), () => styleBlock(config)]) {
    try {
      check();
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}
