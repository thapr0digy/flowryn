import { decisionsConfig } from "../attention/decisions-policy.ts";
import { verifyConfig } from "../verify/config.ts";
import { CONFIG_SECTIONS, table, type FlowrynConfig, type SectionName } from "./config.ts";
import { daemonConfig } from "./daemon.ts";
import { cleanupConfig, githubConfig } from "./delivery.ts";
import { awayConfig, grantsConfig, leaderTiming, notifyConfig, reviewConfig } from "./leader.ts";
import { policyMode } from "./policy.ts";
import { upkeepConfig } from "./upkeep.ts";
import { validationConfig } from "./validation.ts";
import { herdrConfig, timingConfig, workersConfig } from "./workers.ts";
import { capacityConfig, defaultAutonomy, DEFAULT_WORKFLOWS, schedTiming, styleBlock, workflowsConfig } from "./workflows.ts";

/**
 * The effective configuration (docs/notes/2026-10-12-next-steps-md-it.md):
 * every registered section through its own parser, in one snapshot. The
 * daemon validates with it and `flowryn config` shows it, so what is checked
 * and what is shown are the same list.
 */

/** `core` holds the top-level settings; every other key is a registered section. */
export type SnapshotKey = "core" | SectionName;
export const SNAPSHOT_KEYS: readonly SnapshotKey[] = ["core", ...CONFIG_SECTIONS];

type Resolver = (config: FlowrynConfig, env: NodeJS.ProcessEnv) => unknown;

function styleView(config: FlowrynConfig): Record<string, unknown> {
  const block = styleBlock(config);
  const raw = table(config.extra.style, "[style]");
  const source = block === null ? "off" : raw.text !== undefined ? "text" : raw.file !== undefined ? `file ${String(raw.file)}` : "built-in";
  return { terse: block !== null, source, chars: block?.length ?? 0 };
}

function workflowsView(config: FlowrynConfig): Record<string, unknown> {
  const own = table(config.extra.workflows, "[workflows]");
  const out: Record<string, unknown> = {};
  for (const [id, wf] of Object.entries(workflowsConfig(config))) {
    out[id] = { source: id in own ? (id in DEFAULT_WORKFLOWS ? "config (replaces the built-in)" : "config") : "built-in", stages: wf.stages };
  }
  return out;
}

function projectsView(config: FlowrynConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(table(config.extra.projects, "[projects]"))) out[id] = verifyConfig(config, id) ?? { verify: "none" };
  return out;
}

/** Typed by SectionName, so registering a section without a resolver fails the typecheck. */
const RESOLVERS: Record<SnapshotKey, Resolver> = {
  core: (c) => ({ data_dir: c.data_dir, state_dir: c.state_dir, morning_hour: c.morning_hour }),
  tasks: (c) => ({ ...c.tasks }),
  tools: (c) => ({ ...c.tools }),
  herdr: herdrConfig,
  workers: workersConfig,
  reconcile: timingConfig,
  leader: leaderTiming,
  notify: notifyConfig,
  away: awayConfig,
  grants: grantsConfig,
  review: reviewConfig,
  github: githubConfig,
  cleanup: cleanupConfig,
  policy: (c) => ({ mode: policyMode(c) }),
  daemon: daemonConfig,
  upkeep: upkeepConfig,
  validation: validationConfig,
  capacity: capacityConfig,
  workflows: workflowsView,
  autonomy: (c) => ({ default: defaultAutonomy(c) }),
  sched: schedTiming,
  style: styleView,
  decisions: decisionsConfig,
  projects: projectsView,
};

export interface EffectiveConfig {
  /** Each section's resolved values; null for a section its parser refused. */
  sections: Record<SnapshotKey, unknown>;
  /** The parsers' refusals, one per refused section. */
  problems: string[];
}

export function effectiveConfig(config: FlowrynConfig, env: NodeJS.ProcessEnv = process.env): EffectiveConfig {
  const sections = {} as Record<SnapshotKey, unknown>;
  const problems: string[] = [];
  for (const key of SNAPSHOT_KEYS) {
    try {
      sections[key] = RESOLVERS[key](config, env);
    } catch (error) {
      sections[key] = null;
      problems.push((error as Error).message);
    }
  }
  return { sections, problems };
}

/** The environment variables a resolver reads: [grants] claude_projects_dir defaults from them. */
export const RESOLVE_ENV_KEYS = ["HOME", "CLAUDE_CONFIG_DIR"] as const;

export function resolveEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of RESOLVE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Every section parser's refusal: what the daemon checks at startup and on SIGHUP, and init and doctor report. */
export function configSectionProblems(config: FlowrynConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return effectiveConfig(config, env).problems;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafPaths(value: Record<string, unknown>, prefix: string[], out: string[]): void {
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isTable(child)) leafPaths(child, path, out);
    else out.push(path.join("."));
  }
}

/**
 * The values the file sets, as dotted paths (`notify.macos`, an array such as
 * `workflows.fix.stages` is one leaf); every other value is a default. Empty
 * for text that is not TOML: the file's own error says why.
 */
export function configOverrides(text: string): string[] {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (isTable(raw)) leafPaths(raw, [], out);
  return out.toSorted();
}

export const REDACTED = "<redacted>";

const SECRET_NAME = /token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key/i;
/** Names that look secret but hold no secret: [github] token_env lists environment variable names. */
const NOT_SECRET_PATHS = new Set(["github.token_env"]);
export const TOKEN_LIKE = /\b(gh[opusr]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{8,}/;
const SECRET_FLAG = /^--?[\w-]*(token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key)[\w-]*$/i;
const SECRET_FLAG_VALUE = /^(--?[\w-]*(?:token|secret|passw(?:or)?d|api[-_]?key|credential|private[-_]?key)[\w-]*)=.*/i;

function redactArgs(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (typeof arg !== "string") {
      out.push(redactValue(arg, []));
      hideNext = false;
      continue;
    }
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
      continue;
    }
    const withValue = SECRET_FLAG_VALUE.exec(arg);
    if (withValue) out.push(`${withValue[1]}=${REDACTED}`);
    else if (TOKEN_LIKE.test(arg)) out.push(REDACTED);
    else {
      out.push(arg);
      hideNext = SECRET_FLAG.test(arg);
    }
  }
  return out;
}

function redactValue(value: unknown, path: string[]): unknown {
  const dotted = path.join(".");
  const key = path[path.length - 1] ?? "";
  if (path.length >= 1 && !NOT_SECRET_PATHS.has(dotted) && SECRET_NAME.test(key)) return REDACTED;
  // A harness's environment ([workers.pi] env) is where API keys go: none of its values is shown.
  if (path.length >= 2 && path[path.length - 2] === "env") return REDACTED;
  if (Array.isArray(value)) return key === "extra_args" ? redactArgs(value) : value.map((item) => redactValue(item, []));
  if (isTable(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, [...path, k])]));
  if (typeof value === "string" && TOKEN_LIKE.test(value)) return REDACTED;
  return value;
}

/** The snapshot with every secret-looking value replaced by `<redacted>`; nothing else changes. */
export function redactConfig(sections: Record<string, unknown>): Record<string, unknown> {
  return redactValue(sections, []) as Record<string, unknown>;
}

/** The sections whose resolved values differ between two (redacted) snapshots, in snapshot order. */
export function differingSections(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...SNAPSHOT_KEYS, ...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((key) => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null));
}

/** The daemon's record of its accepted configuration, for `daemon.config`. */
export interface ConfigStatus {
  /** When the config it runs on was accepted: startup or the last accepted SIGHUP. */
  loaded_at: number;
  /** The last SIGHUP's outcome; null when none came since startup. */
  reload: { at: number; outcome: "accepted" | "rejected"; error: string | null } | null;
}
