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
import { taskTitle } from "../../lifecycle/runs.ts";
import { runApprovalFlow, type Tty } from "./approve.ts";

/**
 * `flowryn board` (design section 4): a zero-token live view for your own
 * terminal. It reads flowryn.db read-only, like any reader while WAL is on,
 * and never writes; it never runs inside an agent pane. Its approve key (a)
 * records your approval through the socket, behind the same typed code as
 * `flowryn approve` (design section 7, channel board). `--once` prints one
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
  summary: "A live view in your terminal: what needs you, the fleet, updates, to-dos; a approves a merge",
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

/** Ships that wait for a merge approval: delivered (ready), or merging with a merge that was not proven. */
export function approvable(db: Db): { task: string; title: string; project: string; state: string }[] {
  const rows = db
    .query(
      `SELECT r.task_id, p.project_id, r.state FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.kind = 'ship' AND r.state IN ('ready','merging') ORDER BY r.updated_at`,
    )
    .all() as { task_id: string; project_id: string; state: string }[];
  return rows.map((r) => ({ task: r.task_id, title: taskTitle(db, r.task_id), project: r.project_id, state: r.state }));
}

/**
 * The board's keys as a line-oriented terminal for the approve flow: what you
 * type is echoed, Enter ends a line, Escape or Ctrl+C cancels it. The keys
 * come from the board's own raw terminal, never from a pipe.
 */
class KeyTty implements Tty {
  private buffer = "";
  private waiter: ((line: string | null) => void) | null = null;

  write(text: string): void {
    out(text.replace(/\n/g, "\r\n"));
  }

  feed(key: string): void {
    if (!this.waiter) return;
    for (const ch of key) {
      if (ch === "\r" || ch === "\n") return this.finish(this.buffer);
      if (ch === "\u0003" || ch === "\u001b") return this.finish(null);
      if (ch === "\u007f" || ch === "\b") {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          out("\b \b");
        }
        continue;
      }
      if (ch >= " " && ch <= "~") {
        this.buffer += ch;
        out(ch);
      }
    }
  }

  private finish(line: string | null): void {
    const waiter = this.waiter;
    this.waiter = null;
    this.buffer = "";
    waiter?.(line);
  }

  readLine(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(null), timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  close(): void {
    this.finish(null);
  }
}

/** The approve key: pick a waiting ship, see what would land, type the code back (design section 7, channel board). */
async function approveFromBoard(io: CliIo, db: Db, tty: KeyTty): Promise<void> {
  out("\u001b[H\u001b[2J");
  const list = approvable(db);
  if (list.length === 0) {
    tty.write("Nothing waits for a merge approval.\n\nPress Enter to go back. ");
    await tty.readLine(60_000);
    return;
  }
  tty.write("APPROVE A MERGE\n\n");
  list.forEach((row, i) => tty.write(`  ${i + 1}. ${pad(row.task, 28)} ${pad(row.project, 12)} ${row.state === "merging" ? "(merge not proven) " : ""}${row.title}\n`));
  tty.write("\nNumber, then Enter (Escape cancels): ");
  const pick = await tty.readLine(120_000);
  const chosen = pick === null ? undefined : list[Number(pick.trim()) - 1];
  if (!chosen) return;
  const reply = await runApprovalFlow(io.env, tty, { task: chosen.task, channel: "board", actor: io.env.USER || io.env.LOGNAME || "you" });
  tty.write(reply.ok ? `\nApproved ${chosen.task} (${(reply.data as { approval?: string }).approval}). The leader can merge it now.\n` : `\nNot approved: ${reply.error?.message ?? "error"}\n`);
  tty.write("\nPress Enter to go back. ");
  await tty.readLine(60_000);
}

/** The live view: alternate screen, a frame every 2 s or on r, a to approve a merge, q or Ctrl+C to leave. */
async function live(io: CliIo, db: Db, ageMs: number): Promise<number> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // An object, so the key handler and the finally block see the same approve flow.
  const view: { approving: KeyTty | null } = { approving: null };
  const draw = async () => {
    if (view.approving) return;
    const lines = boardFrame(db, { now: Date.now(), daemon: await daemonFacts(io) }, ageMs);
    lines.push("", "q quit · r refresh · a approve a merge · every 2s");
    if (view.approving) return;
    out(`\u001b[H\u001b[2J${fit(lines, process.stdout.columns || 120)}`);
  };
  const onKey = (data: Buffer) => {
    const key = data.toString("utf8");
    if (view.approving) {
      view.approving.feed(key);
      return;
    }
    if (key === "q" || key === "\u0003") finish();
    else if (key === "r") void draw();
    else if (key === "a") {
      const tty = new KeyTty();
      view.approving = tty;
      void approveFromBoard(io, db, tty).finally(() => {
        view.approving = null;
        void draw();
      });
    }
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
    view.approving?.close();
    process.stdin.off("data", onKey);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    out("\u001b[?25h\u001b[?1049l");
  }
  return 0;
}

export const BOARD_VERBS: VerbSpec[] = [board];
