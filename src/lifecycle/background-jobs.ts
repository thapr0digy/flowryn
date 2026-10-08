import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { transcriptSize } from "./control.ts";
import type { RunRow } from "./runs.ts";

/**
 * A Claude worker's own background jobs: a Bash call run in the background or
 * an agent launched asynchronously. A worker that ends its turn to wait on one
 * is waiting, not stuck, so the turn-end guard stands aside while one runs
 * (docs/m5-notes.md, "Turn-end guard"). Deterministic: the PostToolUse hook
 * input records a start; Claude's notice of its end, found in the session
 * transcript, records the end: a `<task-notification>` naming the job's tool
 * use id, or for an agent its hand-back, `<agent-message from="<agentId>">`
 * (both seen on 2.1.294). A notice arrives as the prompt of the turn it
 * wakes, or as an attachment inside a busy turn, which fires no hook, so the
 * transcript is the one place that shows both.
 */

export const BACKGROUND_STARTED = "run.background_started";
export const BACKGROUND_ENDED = "run.background_ended";

/** The PostToolUse input fields a background start is read from. */
export interface ToolHookInput {
  tool_name?: string | null;
  tool_use_id?: string | null;
  tool_input?: unknown;
  tool_response?: unknown;
  agent_id?: string | null;
}

export interface BackgroundStart {
  toolUseId: string;
  tool: string;
  /** Claude's own id: a Bash backgroundTaskId or an agentId; null when the response named none. */
  job: string | null;
}

export interface BackgroundJob extends BackgroundStart {
  startedAt: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The background job a main-agent tool call started, or null. Claude answers
 * a background Bash call with a backgroundTaskId and an asynchronous agent
 * with status "async_launched" (its transcript's toolUseResult); a Bash call
 * asked to run in the background counts even when the response names no id.
 * A subagent's own tool calls (agent_id set) run inside its parent's call.
 */
export function backgroundStartOf(input: ToolHookInput): BackgroundStart | null {
  if (text(input.agent_id)) return null;
  const toolUseId = text(input.tool_use_id);
  if (!toolUseId) return null;
  const tool = text(input.tool_name) ?? "tool";
  const response = record(input.tool_response);
  const taskId = text(response.backgroundTaskId);
  if (taskId) return { toolUseId, tool, job: taskId };
  if (response.status === "async_launched") return { toolUseId, tool, job: text(response.agentId) };
  if (tool === "Bash" && record(input.tool_input).run_in_background === true) return { toolUseId, tool, job: null };
  return null;
}

/** Record a background start, with where the transcript stood. Call inside the transaction. */
export function recordBackgroundStart(db: Db, run: RunRow, start: BackgroundStart, transcriptPath: string | null, now: number): void {
  const transcript = transcriptPath ?? run.transcript_path;
  appendEvent(db, {
    source: "hook",
    kind: BACKGROUND_STARTED,
    runId: run.id,
    taskId: run.task_id,
    payload: { tool_use_id: start.toolUseId, tool: start.tool, job: start.job, transcript, offset: transcriptSize(transcript) },
    ts: now,
  });
}

interface StartPayload {
  tool_use_id: string;
  tool: string;
  job: string | null;
  transcript: string | null;
  offset: number;
}

/** The transcript from `fromByte` on, or null when it cannot be read. */
function readFrom(path: string, fromByte: number): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= fromByte) return "";
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(size - fromByte);
    readSync(fd, buffer, 0, buffer.length, fromByte);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Where the transcript tail first shows the job ended, from `from` on, and how; null while it runs. */
function endNotice(tail: string, from: number, start: StartPayload): { status: string | null } | null {
  const notice = tail.indexOf(`<tool-use-id>${start.tool_use_id}</tool-use-id>`, from);
  if (notice >= 0) return { status: /<status>([a-z_]+)<\/status>/.exec(tail.slice(notice, notice + 2_000))?.[1] ?? null };
  if (start.job && tail.indexOf(`<agent-message from=\\"${start.job}\\"`, from) >= 0) return { status: "handed_back" };
  return null;
}

/**
 * The run's background jobs still running: started by the current worker
 * process (a relaunch or resume starts with none) with no end recorded. Ends
 * the transcript now shows are recorded first. A transcript that cannot be
 * read leaves its jobs running: the guard then stays quiet, and the
 * worker_idle pointer is the backstop. Call inside the transaction.
 */
export function runningBackgroundJobs(db: Db, run: RunRow, now: number): BackgroundJob[] {
  const since = run.worker_started_at ?? run.started_at;
  const starts = (db
    .query("SELECT ts, payload FROM events WHERE run_id = ?1 AND kind = ?2 AND ts >= ?3 ORDER BY seq")
    .all(run.id, BACKGROUND_STARTED, since) as { ts: number; payload: string }[]).map((e) => ({ ts: e.ts, ...(JSON.parse(e.payload) as StartPayload) }));
  if (starts.length === 0) return [];
  const ended = new Set(
    (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 AND ts >= ?3").all(run.id, BACKGROUND_ENDED, since) as { payload: string }[]).map(
      (e) => (JSON.parse(e.payload) as { tool_use_id: string }).tool_use_id,
    ),
  );
  const pending = starts.filter((s) => !ended.has(s.tool_use_id));
  const pathOf = (s: StartPayload) => s.transcript ?? run.transcript_path;
  // Each transcript is read once, from the earliest pending start in it.
  const tails = new Map<string, { from: number; tail: string | null }>();
  for (const start of pending) {
    const path = pathOf(start);
    if (!path || tails.has(path)) continue;
    const from = Math.min(...pending.filter((s) => pathOf(s) === path).map((s) => s.offset));
    tails.set(path, { from, tail: readFrom(path, from) });
  }
  const running: BackgroundJob[] = [];
  for (const start of pending) {
    const path = pathOf(start);
    const read = path ? tails.get(path)! : { from: 0, tail: null };
    const tail = read.tail;
    const end = tail === null ? null : endNotice(tail, start.offset - read.from, start);
    if (end) {
      appendEvent(db, {
        source: "hook",
        kind: BACKGROUND_ENDED,
        runId: run.id,
        taskId: run.task_id,
        payload: { tool_use_id: start.tool_use_id, job: start.job, status: end.status },
        ts: now,
      });
      continue;
    }
    running.push({ toolUseId: start.tool_use_id, tool: start.tool, job: start.job, startedAt: start.ts });
  }
  return running;
}

/** "its own background job (Bash bf1ambuzj, started 12m ago)": the worker_idle pointer's words for what the worker waits on. */
export function describeJobs(jobs: BackgroundJob[], now: number): string {
  const names = jobs.map((j) => `${j.tool} ${j.job ?? j.toolUseId}`).join(", ");
  const minutes = Math.round((now - Math.min(...jobs.map((j) => j.startedAt))) / 60_000);
  return jobs.length === 1 ? `its own background job (${names}, started ${minutes}m ago)` : `its own background jobs (${names}; the first started ${minutes}m ago)`;
}
