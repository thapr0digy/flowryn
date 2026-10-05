import type { Db } from "../db/db.ts";
import type { FlowrynConfig } from "../config/config.ts";
import type { Journal } from "../journal/journal.ts";
import type { BacklogWatcher } from "../journal/watcher.ts";
import type { FleetServices } from "../lifecycle/fleet-services.ts";
import type { AttentionServices } from "../attention/services.ts";
import type { DeliveryServices } from "../policy/services.ts";
import type { SchedServices } from "../sched/services.ts";
import type { LavishServices } from "../lavish/services.ts";
import { FlowrynError } from "./errors.ts";

/**
 * Who is calling, resolved from the token (design section 12). `human` is a
 * token-less CLI in your own terminal; `anonymous` is a token-less caller
 * that is not (a gate process, a script), which may only ping. A leader
 * session's token is `leader` while the lease names that session and
 * `reader` otherwise (design section 10: a read-only session may read and
 * claim). `hook` verbs accept a leader session's token as well as a run's.
 */
export type Role = "leader" | "reader" | "worker" | "hook" | "human" | "anonymous";

export interface Caller {
  role: Role;
  runId: string | null;
  taskId: string | null;
  /** The leader session (`L<n>`) the token belongs to, for leader and reader callers. */
  session?: string | null;
}

export type ArgValue = string | number | boolean | string[];
export type Args = Record<string, ArgValue | undefined>;

export type FlagType = "string" | "boolean" | "int" | "list";

export interface FlagSpec {
  type: FlagType;
  help: string;
  /** Name of the argument a `--<flag>-file <path|->` flag fills; the CLI reads the file (or stdin) and sends the text. */
  fileFor?: string;
  placeholder?: string;
}

export interface PositionalSpec {
  name: string;
  required: boolean;
  help: string;
}

export interface HandlerResult {
  data: Record<string, unknown>;
  hints?: string[];
}

export interface DaemonInfo {
  pid: number;
  version: string;
  proto: number;
  instance: string;
  startedAt: number;
  execPath: string;
  socket: string;
  stateDir: string;
}

export interface DaemonServices {
  db: Db;
  config(): FlowrynConfig;
  journal: Journal;
  watcher: BacklogWatcher;
  now(): number;
  log(message: string): void;
  info(): DaemonInfo;
  requestShutdown(reason: string): void;
  runTool(tool: "git", args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Runtime, steers, launcher and reconciler (M2). */
  fleet: FleetServices;
  /** Leader waiters, leader clocks and notifications (M3). */
  attention: AttentionServices;
  /** The forge, approvals challenges, cleanup and the delivery watchers (M4). */
  delivery: DeliveryServices;
  /** The scheduler: capacity grants and auto-dispatch (M5). */
  sched: SchedServices;
  /** The review pages' question widgets and their lavish-axi polls. */
  lavish: LavishServices;
}

export interface HandlerCtx extends DaemonServices {
  caller: Caller;
  ulid: string;
  via: "socket" | "spool";
}

export interface ReadCtx {
  db: Db;
  config: FlowrynConfig;
  now: number;
  caller: Caller;
  /** Present when the daemon serves the read; absent in the read-only fallback. */
  info?: DaemonInfo;
}

export type VerbKind = "read" | "mutation" | "local";

/**
 * One entry of the command registry. The same entry drives argv parsing and
 * help in the CLI, role checks and argument validation in the daemon, and the
 * read-only fallback when the daemon is down.
 */
export interface VerbSpec {
  name: string;
  summary: string;
  positionals: PositionalSpec[];
  flags: Record<string, FlagSpec>;
  /** Words after `--` are passed through as a list under this name (`flowryn lead -- --model haiku`). */
  rest?: { name: string; help: string };
  kind: VerbKind;
  /** Roles the daemon accepts for this verb. Local verbs check their own rules. */
  roles: Role[];
  /** Worker verbs spool to disk when the daemon is down (exit 75). */
  spool?: boolean;
  /**
   * How long the CLI waits for the reply. Worker verbs default to 2 s before
   * they spool (design section 12); a verb that must ask GitHub (deliver --pr)
   * waits longer, so a refusal reaches the worker instead of a spool.
   */
  replyMs?: number;
  /**
   * Hook traffic: frequent, never retried and never spooled, so its replies
   * are not kept for idempotency (a PostToolUse on every tool call would fill
   * the 7-day reply table).
   */
  ephemeral?: boolean;
  /** Mutations: async work outside the transaction (git lookups, a fresh hash check). */
  prepare?: (ctx: HandlerCtx, args: Args) => Promise<unknown>;
  /** Mutations: the state change, run inside one transaction with its event and idempotency row. */
  apply?: (ctx: HandlerCtx, args: Args, prepared: unknown) => HandlerResult;
  /** Mutations: after commit, for example to wait briefly for the journal. Also runs on an idempotent replay. */
  settle?: (ctx: HandlerCtx, result: HandlerResult) => Promise<HandlerResult>;
  /** Reads: pure SQLite reads, shared by the daemon and the read-only fallback. */
  read?: (ctx: ReadCtx, args: Args) => HandlerResult;
  /** Local verbs run in the CLI process only. Returns the exit code. */
  local?: (args: Args, io: CliIo) => Promise<number>;
}

export interface CliIo {
  stdout(text: string): void;
  /** The whole of stdin, for verbs that read it themselves (hooks). Set by the CLI entry point. */
  stdin?: () => Promise<string>;
  stderr(text: string): void;
  json: boolean;
  env: NodeJS.ProcessEnv;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

function coerce(name: string, spec: FlagSpec, value: unknown): ArgValue {
  switch (spec.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "int":
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
      break;
    case "list":
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
      if (typeof value === "string") return [value];
      break;
    case "string":
      if (typeof value === "string") return value;
      break;
  }
  throw new FlowrynError("bad_args", `--${name} must be ${spec.type === "int" ? "an integer" : `a ${spec.type}`}`);
}

/**
 * Validate an args object against a verb spec. The daemon runs this on every
 * call; the envelope is never trusted just because the CLI built it.
 */
export function validateArgs(spec: VerbSpec, raw: Record<string, unknown>): Args {
  const args: Args = {};
  const known = new Set<string>();
  for (const positional of spec.positionals) {
    known.add(positional.name);
    const value = raw[positional.name];
    if (value === undefined || value === null || value === "") {
      if (positional.required) throw new FlowrynError("bad_args", `missing <${positional.name}>`, `usage: ${usage(spec)}`);
      continue;
    }
    if (typeof value !== "string") throw new FlowrynError("bad_args", `<${positional.name}> must be a string`);
    args[positional.name] = value;
  }
  for (const [name, flag] of Object.entries(spec.flags)) {
    const target = flag.fileFor ?? name;
    known.add(target);
    const value = raw[target];
    if (value === undefined || value === null) continue;
    args[target] = flag.fileFor ? coerce(target, { type: "string", help: "" }, value) : coerce(name, flag, value);
  }
  if (spec.rest) {
    known.add(spec.rest.name);
    const value = raw[spec.rest.name];
    if (value !== undefined && value !== null) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new FlowrynError("bad_args", `${spec.rest.name} must be a list of words`);
      args[spec.rest.name] = value as string[];
    }
  }
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new FlowrynError("bad_args", `unknown argument ${key}`, `usage: ${usage(spec)}`);
  }
  return args;
}

export function usage(spec: VerbSpec): string {
  const parts = [`flowryn ${spec.name}`];
  for (const p of spec.positionals) parts.push(p.required ? `<${p.name}>` : `[<${p.name}>]`);
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.type === "boolean") parts.push(`[--${name}]`);
    else parts.push(`[--${name} <${flag.placeholder ?? (flag.fileFor ? "path|-" : name)}>]`);
  }
  if (spec.rest) parts.push(`[-- <${spec.rest.name}...>]`);
  return parts.join(" ");
}

export function stringArg(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

export function intArg(args: Args, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

export function boolArg(args: Args, name: string): boolean {
  return args[name] === true;
}
