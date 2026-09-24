import { dirname } from "node:path";
import { decode } from "@toon-format/toon";

/** One task as Flowryn reads it back from tasks-axi (list TOON or mutation JSON). */
export interface BacklogTask {
  id: string;
  title: string;
  state: "queued" | "in_flight" | "done";
  kind: string | null;
  repo: string | null;
  priority: number | null;
  body: string;
  created: string | null;
  closed: string | null;
  deps: string[];
  hold: { kind: string | null; reason: string | null; until: string | null } | null;
  links: string[];
}

/** Every extra field `list --fields` offers that the journal and watcher need. */
export const LIST_FIELDS = ["body", "priority", "created", "closed", "deps", "held", "hold_kind", "hold_reason", "hold_until", "links"] as const;

export const TASKS_AXI_TIMEOUT_MS = 10_000;

export type RunFailureKind = "transient" | "permanent";

export type TasksAxiOutcome =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; kind: RunFailureKind; code: string; message: string; exitCode: number | null };

export interface TasksAxiRunner {
  run(args: string[], timeoutMs?: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }>;
}

/** Spawn the real tasks-axi. Node's directory goes first on PATH, since tasks-axi is a Node script and launchd's PATH is minimal. */
export function processRunner(tasksAxiPath: string, nodePath: string | null): TasksAxiRunner {
  return {
    async run(args, timeoutMs = TASKS_AXI_TIMEOUT_MS) {
      const pathParts = [nodePath ? dirname(nodePath) : null, dirname(tasksAxiPath), process.env.PATH ?? "/usr/bin:/bin"];
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([tasksAxiPath, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: pathParts.filter(Boolean).join(":"), NO_COLOR: "1" },
        });
      } catch (error) {
        return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: (error as Error).message };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { exitCode, stdout, stderr, timedOut };
    },
  };
}

function decodeToon(text: string): Record<string, unknown> | null {
  try {
    const value = decode(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const TRANSIENT_CODES = new Set(["LOCKED"]);
const PERMANENT_CODES = new Set(["NOT_FOUND", "VALIDATION_ERROR"]);

/**
 * Classify one tasks-axi mutation run. A lock timeout, a timeout or a spawn
 * failure is transient and retried with backoff; a validation error or a
 * missing task is permanent, because replaying the same arguments cannot fix it.
 */
export function classifyMutation(raw: Awaited<ReturnType<TasksAxiRunner["run"]>>): TasksAxiOutcome {
  if (raw.spawnError) return { ok: false, kind: "transient", code: "SPAWN_FAILED", message: raw.spawnError, exitCode: null };
  if (raw.timedOut) return { ok: false, kind: "transient", code: "TIMEOUT", message: "tasks-axi did not finish in time", exitCode: raw.exitCode };
  if (raw.exitCode === 0) {
    try {
      const json = JSON.parse(raw.stdout) as Record<string, unknown>;
      if (json.ok === true) return { ok: true, json };
    } catch {
      // fall through: exit 0 without a JSON result is unexpected output
    }
    return { ok: false, kind: "transient", code: "BAD_OUTPUT", message: `unexpected tasks-axi output: ${raw.stdout.slice(0, 200)}`, exitCode: 0 };
  }
  const parsed = decodeToon(raw.stdout) ?? decodeToon(raw.stderr);
  const code = typeof parsed?.code === "string" ? parsed.code : `EXIT_${raw.exitCode}`;
  const message = typeof parsed?.error === "string" ? parsed.error : (raw.stdout || raw.stderr).trim().slice(0, 300);
  if (TRANSIENT_CODES.has(code)) return { ok: false, kind: "transient", code, message, exitCode: raw.exitCode };
  if (PERMANENT_CODES.has(code) || raw.exitCode === 2) return { ok: false, kind: "permanent", code, message, exitCode: raw.exitCode };
  return { ok: false, kind: "transient", code, message, exitCode: raw.exitCode };
}

const NONE = new Set(["-", "none", ""]);

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "-" ? null : s;
}

function list(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  const s = String(value);
  if (NONE.has(s)) return [];
  return s.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function priority(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-4]$/.test(value)) return Number(value);
  return null;
}

function state(value: unknown): BacklogTask["state"] {
  if (value === "queued" || value === "in_flight" || value === "done") return value;
  throw new Error(`unknown tasks-axi task state: ${String(value)}`);
}

/** Normalize one row of `tasks-axi list --fields ...` TOON output. */
export function taskFromListRow(row: Record<string, unknown>): BacklogTask {
  const holdKind = str(row.hold_kind);
  const holdReason = str(row.hold_reason);
  const holdUntil = str(row.hold_until);
  const held = row.held === "yes" || holdKind !== null || holdReason !== null || holdUntil !== null;
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    state: state(row.state),
    kind: str(row.kind),
    repo: str(row.repo),
    priority: priority(row.priority),
    body: typeof row.body === "string" ? row.body : row.body === undefined || row.body === null ? "" : String(row.body),
    created: str(row.created),
    closed: str(row.closed),
    deps: list(row.deps),
    hold: held ? { kind: holdKind, reason: holdReason, until: holdUntil } : null,
    links: list(row.links),
  };
}

/** Normalize the `task` object of a mutation's --json result to the same shape. */
export function taskFromJson(task: Record<string, unknown>): BacklogTask {
  const deps = Array.isArray(task.deps)
    ? (task.deps as { type?: string; id?: string }[]).map((d) => `${d.type ?? "dep"}:${d.id ?? ""}`)
    : [];
  const links = Array.isArray(task.links) ? (task.links as { kind?: string; url?: string }[]).map((l) => `${l.kind ?? "link"}:${l.url ?? ""}`) : [];
  const hold = task.hold as { kind?: string | null; reason?: string | null; until?: string | null } | null | undefined;
  return {
    id: String(task.id),
    title: String(task.title ?? ""),
    state: state(task.state),
    kind: str(task.kind),
    repo: str(task.repo),
    priority: priority(task.priority),
    body: typeof task.body === "string" ? task.body : "",
    created: str(task.created),
    closed: str(task.closed),
    deps,
    hold: hold ? { kind: hold.kind ?? null, reason: hold.reason ?? null, until: hold.until ?? null } : null,
    links,
  };
}

/**
 * Parse `tasks-axi list --fields ...` output. Reads print TOON; tasks-axi
 * 0.2.5 has --json only on mutations (M0 spike t04).
 */
export function parseListOutput(stdout: string): BacklogTask[] {
  const parsed = decodeToon(stdout);
  if (!parsed) throw new Error(`could not parse tasks-axi list output: ${stdout.slice(0, 200)}`);
  if (typeof parsed.error === "string") throw new Error(`tasks-axi list failed: ${parsed.error} (${String(parsed.code ?? "")})`);
  const tasks = parsed.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((row) => taskFromListRow(row as Record<string, unknown>));
}

export async function listTasks(runner: TasksAxiRunner, file: string): Promise<BacklogTask[]> {
  const raw = await runner.run(["list", "--file", file, "--fields", LIST_FIELDS.join(",")]);
  if (raw.spawnError) throw new Error(`could not run tasks-axi: ${raw.spawnError}`);
  if (raw.timedOut) throw new Error("tasks-axi list timed out");
  if (raw.exitCode !== 0) {
    const parsed = decodeToon(raw.stdout);
    throw new Error(`tasks-axi list failed: ${String(parsed?.error ?? raw.stdout.trim())} (${String(parsed?.code ?? `exit ${raw.exitCode}`)})`);
  }
  return parseListOutput(raw.stdout);
}

/** tasks-axi's version string, or null when it cannot run. */
export async function tasksAxiVersion(runner: TasksAxiRunner): Promise<string | null> {
  const raw = await runner.run(["--version"], 5_000);
  if (raw.exitCode !== 0) return null;
  return raw.stdout.trim().split(/\s+/).pop() ?? null;
}
