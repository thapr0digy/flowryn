import { existsSync } from "node:fs";
import { errorReply } from "../../api/envelope.ts";
import { boolArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { openActionable } from "../../attention/router.ts";
import { loadConfig } from "../../config/config.ts";
import { leaderTiming } from "../../config/leader.ts";
import { flowrynHome, stateFiles } from "../../config/paths.ts";
import { openDb, type Db } from "../../db/db.ts";
import { describeSession, getLease, getSession } from "../../lease/lease.ts";
import { localDate } from "../../lifecycle/dates.ts";
import { todoViews } from "../../lifecycle/todos.ts";
import { agentIdentity } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { ping } from "./daemon.ts";

/**
 * `flowryn board` (design section 4): a zero-token live view for your own
 * terminal. It reads flowryn.db read-only, like any reader while WAL is on,
 * and never writes; it never runs inside an agent pane. `--once` prints one
 * frame and exits.
 */

const REFRESH_MS = 2_000;
const MAX_ROWS = { needs: 12, fleet: 12, updates: 6, todos: 8 };

function age(now: number, since: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

export interface BoardFacts {
  now: number;
  /** "up (pid 123)" or "down". */
  daemon: string;
}

interface FleetRow {
  task_id: string;
  kind: string;
  project_id: string;
  state: string;
  liveness: string;
  started_at: number;
}

interface UpdateRow {
  id: string;
  lane: string;
  line: string;
  state: string;
  opened_at: number;
}

/** One frame, as plain lines: the leader, what needs you, the fleet, recent updates, to-dos. */
export function boardFrame(db: Db, facts: BoardFacts, ageMs: number): string[] {
  const { now } = facts;
  const lines: string[] = [];
  const lease = getLease(db);
  const holder = lease.session_id ? getSession(db, lease.session_id) : null;
  const leader = holder ? `${describeSession(holder)} (lease ${lease.epoch})` : "none";
  lines.push(`Flowryn board · ${new Date(now).toLocaleTimeString("en-GB")} · daemon ${facts.daemon} · leader: ${leader}`);

  const needs = openActionable(db, now, ageMs);
  lines.push("", `NEEDS YOU (${needs.length})`);
  if (needs.length === 0) lines.push("  nothing");
  for (const item of needs.slice(0, MAX_ROWS.needs)) lines.push(`  ${item.lane} ${pad(item.id, 6)} ${pad(age(now, item.opened_at), 4)} ${item.line}`);
  if (needs.length > MAX_ROWS.needs) lines.push(`  +${needs.length - MAX_ROWS.needs} more (flowryn fleet)`);

  const runs = db
    .query(
      `SELECT r.task_id, p.kind, p.project_id, r.state, r.liveness, r.started_at FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE r.state NOT IN ('cleaned','failed','cancelled') OR r.updated_at > ?1 ORDER BY r.started_at DESC`,
    )
    .all(now - 86_400_000) as FleetRow[];
  lines.push("", `FLEET (${runs.length})`);
  if (runs.length === 0) lines.push("  no workers");
  for (const r of runs.slice(0, MAX_ROWS.fleet)) {
    lines.push(`  ${pad(r.task_id, 28)} ${pad(r.kind, 6)} ${pad(r.project_id, 12)} ${pad(r.state, 10)} ${pad(r.liveness, 14)} ${age(now, r.started_at)}`);
  }

  const updates = db
    .query("SELECT id, lane, line, state, opened_at FROM items WHERE class = 'info' AND opened_at > ?1 ORDER BY opened_at DESC LIMIT ?2")
    .all(now - 86_400_000, MAX_ROWS.updates) as UpdateRow[];
  lines.push("", "UPDATES (last day)");
  if (updates.length === 0) lines.push("  none");
  for (const u of updates) lines.push(`  ${u.lane} ${pad(u.id, 6)} ${pad(u.state, 9)} ${pad(age(now, u.opened_at), 4)} ${u.line}`);

  const today = localDate(new Date(now));
  const todos = todoViews(db)
    .filter((t) => t.state !== "done")
    .toSorted((a, b) => (a.due ?? "9999") < (b.due ?? "9999") ? -1 : (a.due ?? "9999") > (b.due ?? "9999") ? 1 : 0);
  lines.push("", `TO-DOS (${todos.length} open)`);
  if (todos.length === 0) lines.push("  none");
  for (const t of todos.slice(0, MAX_ROWS.todos)) {
    const when = t.due === null ? "-" : t.due < today ? `overdue ${t.due}` : t.due === today ? "today" : t.due;
    lines.push(`  ${pad(t.id, 28)} ${pad(when, 18)} ${t.title}`);
  }
  return lines;
}

function out(text: string): void {
  process.stdout.write(text);
}

function fit(lines: string[], columns: number): string {
  return lines.map((l) => (l.length > columns ? `${l.slice(0, Math.max(1, columns - 1))}…` : l)).join("\n");
}

async function daemonFacts(io: CliIo): Promise<string> {
  const reply = await ping(io.env);
  if (!reply?.ok) return "down (read-only view)";
  const data = reply.data as { pid?: number };
  return `up (pid ${data.pid ?? "?"})`;
}

const board: VerbSpec = {
  name: "board",
  summary: "A live, read-only view in your terminal: what needs you, the fleet, updates, to-dos",
  positionals: [],
  flags: { once: { type: "boolean", help: "print one frame and exit" } },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const identity = agentIdentity(io.env);
    if (identity) {
      io.stdout(renderReply(errorReply({ code: "human_only", message: `board runs only in your own terminal: ${identity} is set` }), { json: io.json }));
      return exitCodeOf(errorReply({ code: "human_only", message: "" }));
    }
    const once = boolArg(args, "once");
    if (!once && (!io.stdoutIsTty || !io.stdinIsTty)) {
      const reply = errorReply({ code: "human_only", message: "the live board needs a terminal; use --once to print one frame" });
      io.stdout(renderReply(reply, { json: io.json }));
      return exitCodeOf(reply);
    }
    const { config } = loadConfig(flowrynHome(io.env));
    const dbPath = stateFiles(config.state_dir).db;
    if (!existsSync(dbPath)) {
      const reply = errorReply({ code: "daemon_unavailable", message: "there is no database yet", help: "flowryn init, then flowryn daemon start" });
      io.stdout(renderReply(reply, { json: io.json }));
      return exitCodeOf(reply);
    }
    const db = openDb(dbPath, { readonly: true });
    const ageMs = leaderTiming(config).age_ms;
    try {
      if (once) {
        io.stdout(boardFrame(db, { now: Date.now(), daemon: await daemonFacts(io) }, ageMs).join("\n") + "\n");
        return 0;
      }
      return await live(io, db, ageMs);
    } finally {
      db.close();
    }
  },
};

/** The live view: alternate screen, a frame every 2 s or on r, q or Ctrl+C to leave. */
async function live(io: CliIo, db: Db, ageMs: number): Promise<number> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const draw = async () => {
    const lines = boardFrame(db, { now: Date.now(), daemon: await daemonFacts(io) }, ageMs);
    lines.push("", "q quit · r refresh · every 2s");
    out(`\u001b[H\u001b[2J${fit(lines, process.stdout.columns || 120)}`);
  };
  const onKey = (data: Buffer) => {
    const key = data.toString("utf8");
    if (key === "q" || key === "\u0003") finish();
    else if (key === "r") void draw();
  };
  out("\u001b[?1049h\u001b[?25l");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  const timer = setInterval(() => void draw(), REFRESH_MS);
  try {
    await draw();
    await done;
  } finally {
    clearInterval(timer);
    process.stdin.off("data", onKey);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    out("\u001b[?25h\u001b[?1049l");
  }
  return 0;
}

export const BOARD_VERBS: VerbSpec[] = [board];
