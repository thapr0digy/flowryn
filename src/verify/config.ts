import { isAbsolute, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { checkUsd } from "../config/ask.ts";
import { table, type FlowrynConfig } from "../config/config.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { parseRelease } from "../lifecycle/release.ts";
import { compileGlob } from "./changed.ts";

/**
 * A project's verify steps, from config.toml `[projects.<id>]`: the commands
 * `flowryn verify` runs, in order, in a clean worktree at a PR head. They
 * live in your config, never in the repository, so a PR cannot change the
 * check that lets it through the merge gate. A nested list is a group whose
 * steps run at the same time (docs/notes/2026-10-22-verify-reliability-per-xe.md).
 * A `{ review = true }` entry is the review step: one capped, read-only model
 * review of the PR diff against the task's brief and approved spec
 * (src/verify/review.ts, docs/notes/2026-11-06-auto-verify-every-t8.md).
 */

/** One entry of `verify`: a step, or a group of two or more steps run in parallel. */
export type VerifyItem = string | string[];

export const LANDING_MODES = ["queue", "batch", "manual"] as const;
export type LandingMode = (typeof LANDING_MODES)[number];

/** Where a step's `rerun_failed` command takes the failing packages or test files. */
export const FAILED_PLACEHOLDER = "{failed}";

/** The review step's name in a verification's steps: no shell command is ever spelled like this. */
export const REVIEW_STEP = "flowryn:review";
/**
 * The laws step (src/verify/laws.ts, docs/notes/2026-11-27-phase-the-laws-ib.md): every project's
 * verify ends with it, after the steps that install and build (initialSteps). It checks the AGENTS.md laws table.
 */
export const LAWS_STEP = "flowryn:laws";
/** The review step's spend cap and deadline when its entry sets none. */
export const DEFAULT_REVIEW_USD = 2;
export const DEFAULT_REVIEW_TIMEOUT_MIN = 10;

/** `{ review = true, max_usd?, timeout_min?, harness?, model? }`: who reviews, and its bounds. */
export interface ReviewConfig {
  max_usd: number;
  timeout_ms: number;
  harness: HarnessId;
  /** A model other than the builder's, where one is set; null: the harness's configured model. */
  model: string | null;
}

export interface VerifyConfig {
  /** In order; the review step appears as REVIEW_STEP. */
  steps: VerifyItem[];
  /** The review step's settings when `verify` has one. */
  review: ReviewConfig | null;
  /**
   * Each step's `when_changed` globs, by its place in the flattened list (groups in order),
   * or null: it always runs. Absent or empty: no step has any (docs/notes/2026-11-06-fast-tests-parallel-36.md).
   */
  when_changed?: (readonly string[] | null)[];
  /**
   * Each step's `rerun_failed` command, by its place in the flattened list, or null: a landing batch
   * whose step fails reruns only that step's failing tests with it (src/verify/flake.ts). Absent: no
   * step has one. Not part of the verify policy: it never changes what a pass of the step proves.
   */
  rerun_failed?: (string | null)[];
  /**
   * Whether the laws step (LAWS_STEP) ends this verify: true for every project's verify, absent on
   * the light check. Not part of the verify policy: the step is the same built-in on every project.
   */
  laws?: boolean;
  /** A file the steps build, relative to the worktree, copied out before the worktree goes. */
  binary: string | null;
  /** The whole run, every step together. */
  timeout_ms: number;
  /** Every step's own deadline, from verify_step_timeout_min; null: each step's deadline comes from its history. */
  step_timeout_ms: number | null;
  /**
   * A batch project's light check (`light_verify`, docs/notes/2026-11-21-landing-batches-one-27.md):
   * the short steps each delivered branch runs alone before it may join a batch; null when unset.
   * Not part of the verify policy: the light check has its own (lightVerifyConfig).
   */
  light?: { steps: VerifyItem[]; when_changed?: (readonly string[] | null)[] } | null;
}

export const DEFAULT_VERIFY_TIMEOUT_MIN = 30;

// scope and account are read by src/config/accounts.ts, max_workers and review_model by src/config/workflows.ts, release by src/lifecycle/release.ts.
const KNOWN = new Set(["verify", "verify_binary", "verify_timeout_min", "verify_step_timeout_min", "auto_merge", "auto_verify", "landing", "landing_train_depth", "light_verify", "batch_max", "gate_pass", "scope", "account", "max_workers", "review_model", "release"]);

/** `gate_pass`'s one value: the daemon passes a design or QA review gate on objective evidence. */
export const GATE_PASS_EVIDENCE = "evidence";

/** What to paste for a bun project, shown when a project has no verify steps. */
export function verifySnippet(projectId: string): string {
  return `[projects.${projectId}]\nverify = ["bun install --frozen-lockfile", ["bun run typecheck", "npx oxlint", "bun run build"], "bun test"]`;
}

function projectTable(config: FlowrynConfig, projectId: string): Record<string, unknown> {
  const projects = table(config.extra.projects, "[projects]");
  return table(projects[projectId], `[projects.${projectId}]`);
}

const isStep = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.trim() !== REVIEW_STEP && s.trim() !== LAWS_STEP;
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REVIEW_KEYS = new Set(["review", "max_usd", "timeout_min", "harness", "model"]);

/** A `{ review = true, ... }` entry, checked; throws config_invalid on anything else in it. */
function readReview(raw: Record<string, unknown>, where: string): ReviewConfig {
  for (const key of Object.keys(raw)) if (!REVIEW_KEYS.has(key)) throw new FlowrynError("config_invalid", `${where} the review step's ${key} is not a known setting (${[...REVIEW_KEYS].join(", ")})`);
  if (raw.review !== true) throw new FlowrynError("config_invalid", `${where} a table in verify must be { review = true }`);
  if (raw.harness !== undefined && !HARNESS_IDS.includes(raw.harness as HarnessId)) throw new FlowrynError("config_invalid", `${where} the review step's harness must be one of ${HARNESS_IDS.join(", ")}`);
  if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.trim() === "")) throw new FlowrynError("config_invalid", `${where} the review step's model must be a model name`);
  return {
    max_usd: raw.max_usd === undefined ? DEFAULT_REVIEW_USD : checkUsd(raw.max_usd, `${where} the review step's max_usd`),
    timeout_ms: positiveMinutes(raw.timeout_min ?? DEFAULT_REVIEW_TIMEOUT_MIN, where, "the review step's timeout_min"),
    harness: (raw.harness as HarnessId | undefined) ?? "claude",
    model: typeof raw.model === "string" ? raw.model.trim() : null,
  };
}

/** One step: its command, its when_changed globs or null, and its rerun_failed command or null. */
interface ReadStep {
  run: string;
  when: string[] | null;
  rerun: string | null;
}

const STEP_KEYS = new Set(["run", "when_changed", "rerun_failed"]);

/** `rerun_failed`: a command that names `{failed}`, where the failing packages or test files go. */
function readRerun(raw: unknown, run: string, where: string): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.includes(FAILED_PLACEHOLDER)) throw new FlowrynError("config_invalid", `${where} verify: rerun_failed of "${run}" must be a command that names ${FAILED_PLACEHOLDER}, where the failing packages or test files go`);
  return raw.trim();
}

/**
 * A step as written: a command, or a table `{ run = "...", when_changed = ["src/x/**"], rerun_failed = "go test {failed}" }`.
 * Null when it is neither; throws config_invalid on a table whose globs or rerun command are malformed.
 */
function readStep(raw: unknown, where: string): ReadStep | null {
  if (isStep(raw)) return { run: raw, when: null, rerun: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!STEP_KEYS.has(key)) throw new FlowrynError("config_invalid", `${where} verify: a step table takes ${[...STEP_KEYS].join(", ")}, not ${key}`);
  if (!isStep(entry.run)) throw new FlowrynError("config_invalid", `${where} verify: a step table needs run, the command`);
  const rerun = readRerun(entry.rerun_failed, entry.run, where);
  const globs = entry.when_changed;
  if (globs === undefined) return { run: entry.run, when: null, rerun };
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string")) {
    throw new FlowrynError("config_invalid", `${where} verify: when_changed of "${entry.run}" must be a non-empty list of globs`);
  }
  for (const glob of globs as string[]) {
    try {
      compileGlob(glob);
    } catch (error) {
      throw new FlowrynError("config_invalid", `${where} verify: when_changed glob "${glob}" of "${entry.run}" ${(error as Error).message}`);
    }
  }
  return { run: entry.run, when: [...(globs as string[])], rerun };
}

/**
 * The `verify` list, each group of one read as a plain step, with each step's globs and rerun command in flattened order; null when malformed.
 * A `{ review = true }` entry is REVIEW_STEP, at most once, never in a group, and has no globs.
 */
function readItems(raw: unknown, where: string): { items: VerifyItem[]; when: (string[] | null)[]; rerun: (string | null)[]; review: ReviewConfig | null } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: VerifyItem[] = [];
  const when: (string[] | null)[] = [];
  const rerun: (string | null)[] = [];
  let review: ReviewConfig | null = null;
  for (const item of raw) {
    if (isTable(item) && "review" in item) {
      if (review) throw new FlowrynError("config_invalid", `${where} verify has more than one review step`);
      review = readReview(item, where);
      items.push(REVIEW_STEP);
      when.push(null);
      rerun.push(null);
      continue;
    }
    const single = readStep(item, where);
    if (single) {
      items.push(single.run);
      when.push(single.when);
      rerun.push(single.rerun);
      continue;
    }
    if (!Array.isArray(item) || item.length === 0) return null;
    if (item.some((step) => isTable(step) && "review" in step)) throw new FlowrynError("config_invalid", `${where} the review step cannot run in a parallel group`);
    const group = item.map((step) => readStep(step, where));
    if (group.some((step) => step === null)) return null;
    const steps = group as ReadStep[];
    items.push(steps.length === 1 ? steps[0]!.run : steps.map((step) => step.run));
    when.push(...steps.map((step) => step.when));
    rerun.push(...steps.map((step) => step.rerun));
  }
  return { items, when, rerun, review };
}

function positiveMinutes(value: unknown, where: string, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `${where} ${key} must be a positive integer`);
  return value * 60_000;
}

/** The project's verify config, or null when it has no `verify` steps. Throws config_invalid on a malformed table. */
export function verifyConfig(config: FlowrynConfig, projectId: string): VerifyConfig | null {
  const where = `[projects.${projectId}]`;
  const raw = projectTable(config, projectId);
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) throw new FlowrynError("config_invalid", `${where} ${key} is not a known setting (${[...KNOWN].join(", ")})`);
  if (raw.auto_merge !== undefined && typeof raw.auto_merge !== "boolean") throw new FlowrynError("config_invalid", `${where} auto_merge must be true or false`);
  if (raw.auto_verify !== undefined && typeof raw.auto_verify !== "boolean") throw new FlowrynError("config_invalid", `${where} auto_verify must be true or false`);
  if (raw.gate_pass !== undefined && raw.gate_pass !== GATE_PASS_EVIDENCE) throw new FlowrynError("config_invalid", `${where} gate_pass must be "${GATE_PASS_EVIDENCE}" (or unset: every review gate waits for you)`);
  if (raw.landing !== undefined && !LANDING_MODES.includes(raw.landing as LandingMode)) throw new FlowrynError("config_invalid", `${where} landing must be "queue", "batch" or "manual"`);
  if (raw.light_verify !== undefined && raw.landing !== "batch") throw new FlowrynError("config_invalid", `${where} light_verify is the light check of landing = "batch"; set landing = "batch" or remove it`);
  if (raw.landing_train_depth !== undefined) checkTrainDepth(raw.landing_train_depth, where);
  if (raw.batch_max !== undefined) {
    if (raw.landing !== "batch") throw new FlowrynError("config_invalid", `${where} batch_max is the batch size of landing = "batch"; set landing = "batch" or remove it`);
    checkBatchMax(raw.batch_max, where);
  }
  parseRelease(raw.release, where);
  if (raw.verify === undefined) {
    // Without verify steps the merge gate passes a PR that has no checks: auto-merge would land anything.
    if (raw.auto_merge === true) throw new FlowrynError("config_invalid", `${where} auto_merge needs verify steps: without them the merge gate passes a PR that has no checks`);
    // The queue re-verifies each PR at main's tip before it merges: with no steps there is nothing to re-verify.
    if (raw.landing === "queue") throw new FlowrynError("config_invalid", `${where} landing = "queue" needs verify steps: the queue verifies each PR again after merging main into it`);
    if (raw.landing === "batch") throw new FlowrynError("config_invalid", `${where} landing = "batch" needs verify steps: each batch is verified with them once before it lands`);
    return null;
  }
  const read = readItems(raw.verify, where);
  if (!read) throw new FlowrynError("config_invalid", `${where} verify must be a non-empty list of commands (or { run, when_changed } tables, or one { review = true }), or of lists of commands run in parallel`);
  let binary: string | null = null;
  if (raw.verify_binary !== undefined) {
    const value = raw.verify_binary;
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || normalize(value).split("/").includes("..")) {
      throw new FlowrynError("config_invalid", `${where} verify_binary must be a path inside the worktree, such as dist/flowryn`);
    }
    binary = normalize(value);
  }
  const timeout_ms = positiveMinutes(raw.verify_timeout_min ?? DEFAULT_VERIFY_TIMEOUT_MIN, where, "verify_timeout_min");
  const step_timeout_ms = raw.verify_step_timeout_min === undefined ? null : positiveMinutes(raw.verify_step_timeout_min, where, "verify_step_timeout_min");
  const when_changed = read.when.some((w) => w !== null) ? read.when : undefined;
  const rerun_failed = read.rerun.some((r) => r !== null) ? read.rerun : undefined;
  const light = readLight(raw.light_verify, where);
  return { laws: true, steps: read.items, ...(when_changed ? { when_changed } : {}), ...(rerun_failed ? { rerun_failed } : {}), review: read.review, binary, timeout_ms, step_timeout_ms, ...(light ? { light } : {}) };
}

/** `light_verify`: the verify grammar without a review step; null when unset. */
function readLight(raw: unknown, where: string): VerifyConfig["light"] {
  if (raw === undefined) return null;
  const read = readItems(raw, `${where} light_verify:`);
  if (!read) throw new FlowrynError("config_invalid", `${where} light_verify must be a non-empty list of commands (or { run, when_changed } tables), or of lists of commands run in parallel`);
  if (read.review) throw new FlowrynError("config_invalid", `${where} light_verify cannot hold the review step: it belongs in verify`);
  // A failing light check goes back to its worker; only a batch's full verify reruns failing tests.
  if (read.rerun.some((r) => r !== null)) throw new FlowrynError("config_invalid", `${where} light_verify cannot take rerun_failed: only the full verify of a landing batch reruns failing tests`);
  const when_changed = read.when.some((w) => w !== null) ? read.when : undefined;
  return { steps: read.items, ...(when_changed ? { when_changed } : {}) };
}

/**
 * The light check as a verify config of its own: its steps, the full verify's deadlines, no
 * review and no kept binary. Its policy id (verifyPolicyId) is what tells a light request from
 * a full one in the verify queue. Null when the project has no light check.
 */
export function lightVerifyConfig(config: VerifyConfig): VerifyConfig | null {
  if (!config.light) return null;
  return { steps: config.light.steps, ...(config.light.when_changed ? { when_changed: config.light.when_changed } : {}), review: null, binary: null, timeout_ms: config.timeout_ms, step_timeout_ms: config.step_timeout_ms };
}

/**
 * `[projects.<id>] auto_verify` (docs/notes/2026-11-06-auto-verify-every-t8.md): a delivery that
 * does not auto-merge still has its verify queued by the daemon. True unless set false; false
 * leaves those verifies to `flowryn verify` (an auto-merge and the landing queue still verify).
 */
export function autoVerifyEnabled(config: FlowrynConfig, projectId: string): boolean {
  if (!verifyConfig(config, projectId)) return false;
  return projectTable(config, projectId).auto_verify !== false;
}

/**
 * `[projects.<id>] gate_pass = "evidence"` (docs/notes/2026-11-23-phase-gates-pass-8f.md): the
 * daemon passes the project's design and QA review gates on objective evidence
 * (src/attention/evidence-gate.ts); unset, every review gate waits for a human channel. Never
 * throws: a malformed project table counts as unset, as verifyConfig refuses it where config is checked.
 */
export function gatePassOnEvidence(config: FlowrynConfig, projectId: string): boolean {
  try {
    verifyConfig(config, projectId);
    return projectTable(config, projectId).gate_pass === GATE_PASS_EVIDENCE;
  } catch {
    return false;
  }
}

/** `[projects.<id>] auto_merge` as written: true, false, or null when unset. Throws config_invalid like verifyConfig. */
export function autoMergeSetting(config: FlowrynConfig, projectId: string): boolean | null {
  verifyConfig(config, projectId);
  const value = projectTable(config, projectId).auto_merge;
  return typeof value === "boolean" ? value : null;
}

/**
 * `[projects.<id>] auto_merge` (docs/notes/2026-10-22-daemon-run-verify-y3.md, phase 2):
 * the daemon verifies and merges the project's yolo deliveries itself. Unset,
 * it follows the project's yolo posture (docs/notes/2026-11-06-auto-verify-every-t8.md):
 * a yolo project auto-merges, and `auto_merge = false` opts out. Never without
 * verify steps; throws config_invalid like verifyConfig.
 */
export function autoMergeEnabled(config: FlowrynConfig, projectId: string, projectYolo = false): boolean {
  if (!verifyConfig(config, projectId)) return false;
  return autoMergeSetting(config, projectId) ?? projectYolo;
}

/**
 * `[projects.<id>] landing` (docs/notes/2026-10-30-landing-queue-the-65.md):
 * "queue" has the daemon land the project's approved and routine work one at a
 * time, merging its base into each first (src/verify/landing-queue.ts);
 * "manual" leaves landing to the merge verb. Unset, a local-only project with
 * verify steps queues (docs/notes/2026-11-15-local-only-auto-x9.md) and any
 * other project is manual. "batch" (docs/notes/2026-11-21-landing-batches-one-27.md)
 * lands a local-only project's ready branches together, one verify per batch
 * (src/verify/landing-batch.ts); it is a queue too, so every "does this project
 * queue" check holds for it. `deliveryMode` is the project's (or the run's)
 * delivery mode; null reads the config alone. Throws config_invalid like
 * verifyConfig (a queue is refused without verify steps), and for "batch" on a
 * project known not to be local-only.
 */
export function landingMode(config: FlowrynConfig, projectId: string, deliveryMode: string | null): LandingMode {
  if (!verifyConfig(config, projectId)) return "manual";
  const written = projectTable(config, projectId).landing;
  if (written === undefined) return deliveryMode === "local-only" ? "queue" : "manual";
  if (written === "batch") {
    if (deliveryMode !== null && deliveryMode !== "local-only") throw new FlowrynError("config_invalid", `[projects.${projectId}] landing = "batch" is for local-only projects; this one delivers ${deliveryMode}`);
    return "batch";
  }
  return written === "queue" ? "queue" : "manual";
}

/** The deepest landing train a project may set: each car beyond the first holds a validation slot. */
export const MAX_TRAIN_DEPTH = 5;
/** How many entries of a line verify at once when unset: the head of line and one speculative car. */
export const DEFAULT_TRAIN_DEPTH = 2;
/**
 * How long a local-only line waits on the entry whose turn it is while its worker is busy or its
 * checkout has uncommitted changes, before the entries behind it go ahead (it keeps its place).
 */
export const LOCAL_TURN_WAIT_MS = 5 * 60_000;
/** Turns a local-only entry may be passed over that way; at the last it is held for the leader. */
export const MAX_SKIPPED_TURNS = 3;

function checkTrainDepth(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TRAIN_DEPTH) {
    throw new FlowrynError("config_invalid", `${where} landing_train_depth must be an integer from 1 (no train) to ${MAX_TRAIN_DEPTH}`);
  }
  return value;
}

/**
 * `[projects.<id>] landing_train_depth` (docs/notes/2026-11-07-faster-landing-test-q7.md): how
 * many entries of a queue project's line verify at once, the head of line included; 1 turns the
 * train off. Never throws: an invalid table was refused by the daemon, and no train runs on it.
 */
export function landingTrainDepth(config: FlowrynConfig, projectId: string, deliveryMode: string | null): number {
  try {
    if (landingMode(config, projectId, deliveryMode) !== "queue") return 1;
    const raw = projectTable(config, projectId).landing_train_depth;
    return raw === undefined ? DEFAULT_TRAIN_DEPTH : checkTrainDepth(raw, `[projects.${projectId}]`);
  } catch {
    return 1;
  }
}

/** landingMode for a pass that must not throw: an invalid table was refused by the daemon, and nothing queues on it. A batch project queues too. */
export function landingQueued(config: FlowrynConfig, projectId: string, deliveryMode: string | null): boolean {
  try {
    return landingMode(config, projectId, deliveryMode) !== "manual";
  } catch {
    return false;
  }
}

/** Whether the project lands in batches; never throws, as landingQueued. */
export function landingBatched(config: FlowrynConfig, projectId: string, deliveryMode: string | null): boolean {
  try {
    return landingMode(config, projectId, deliveryMode) === "batch";
  } catch {
    return false;
  }
}

/** Times one landing entry (or batch) is rebuilt on a base that moved under it before it is held. */
export const MAX_INTEGRATIONS = 3;

/** The most branches one landing batch takes, and `batch_max`'s default and upper bound. */
export const MAX_BATCH = 8;

function checkBatchMax(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new FlowrynError("config_invalid", `${where} batch_max must be an integer from 1 (one branch per verify) to ${MAX_BATCH}`);
  }
  return value;
}

/**
 * `[projects.<id>] batch_max` (docs/notes/2026-11-21-landing-batches-one-27.md): the most branches
 * one landing batch of the project takes, MAX_BATCH when unset. Never throws: an invalid table was
 * refused by the daemon, and no batch forms on it.
 */
export function batchMax(config: FlowrynConfig, projectId: string): number {
  try {
    const raw = projectTable(config, projectId).batch_max;
    return raw === undefined ? MAX_BATCH : checkBatchMax(raw, `[projects.${projectId}]`);
  } catch {
    return MAX_BATCH;
  }
}
