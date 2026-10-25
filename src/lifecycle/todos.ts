import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import { tx, type Db } from "../db/db.ts";
import { syncOverdueTodos } from "../attention/todos-due.ts";
import { boolArg, stringArg, type Args, type HandlerCtx, type HandlerResult, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { getIntent, intentArgs, pendingIntents, recordIntent, type IntentRow } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { localDate, parseDueArg } from "./dates.ts";
import { mintTaskId } from "./ids.ts";
import { lensFor, recordTaskScope } from "../leader/scope.ts";

/**
 * Personal to-dos live in tasks-axi's todos.md with --kind todo. tasks-axi
 * 0.2.5 has no due field, so the due date is the body's first line,
 * `due: YYYY-MM-DD` (design section 8). `due: none` marks a cleared date,
 * because tasks-axi cannot set an empty body.
 */
export const TODO_KIND = "todo";
const DUE_LINE = /^due:\s*(\S+)\s*$/i;
const MAX_TITLE = 200;
/** tasks-axi refuses a title that ends in one of its own `(key: value)` tags. */
const TRAILING_TAG = /\((?:kind|repo|priority|since|done|merged|hold|hold-kind|hold-until|blocked-by|pr|report): [^)]*\)\s*$/i;
/** How long a to-do mutation waits for the journal before answering `pending`. */
export const SETTLE_WAIT_MS = 3_000;

export function dueOf(body: string): string | null {
  const first = body.split("\n", 1)[0] ?? "";
  const match = DUE_LINE.exec(first);
  if (!match) return null;
  const value = match[1]!.toLowerCase();
  return value === "none" || value === "-" ? null : value;
}

export function withDue(body: string, due: string | null): string {
  const lines = body.length > 0 ? body.split("\n") : [];
  if (lines.length > 0 && DUE_LINE.test(lines[0]!)) lines.shift();
  if (due) lines.unshift(`due: ${due}`);
  const text = lines.join("\n").trim();
  return text.length > 0 ? text : "due: none";
}

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new FlowrynError("invalid_todo", "a to-do needs a title");
  if (/[\r\n]/.test(trimmed)) throw new FlowrynError("invalid_todo", "a to-do title must be a single line", "put details in --body-file -");
  if (trimmed.length > MAX_TITLE) throw new FlowrynError("invalid_todo", `a to-do title is at most ${MAX_TITLE} characters`);
  if (TRAILING_TAG.test(trimmed)) throw new FlowrynError("invalid_todo", "a to-do title must not end in a (key: value) tag");
  return trimmed;
}

function dueArg(value: string, now: number): string | null {
  if (value.trim().toLowerCase() === "none") return null;
  const due = parseDueArg(value, new Date(now));
  if (!due) throw new FlowrynError("invalid_todo", `cannot read due date "${value}"`, "use YYYY-MM-DD, today, tomorrow, +Nd or none");
  return due;
}

export interface TodoView {
  id: string;
  title: string;
  state: "open" | "done" | "pending";
  due: string | null;
  body: string;
}

/** Latest body an intent will leave on a task, when one is still pending. */
function pendingBody(intents: IntentRow[], taskId: string): string | null {
  let body: string | null = null;
  for (const intent of intents) {
    if (intent.task_id !== taskId) continue;
    const flag = intentArgs(intent).flags.body;
    if (typeof flag === "string") body = flag;
  }
  return body;
}

function pendingAdd(intents: IntentRow[], taskId: string): IntentRow | undefined {
  return intents.find((i) => i.task_id === taskId && i.verb === "add");
}

function fromTask(task: BacklogTask): TodoView {
  return { id: task.id, title: task.title, state: task.state === "done" ? "done" : "open", due: dueOf(task.body), body: task.body };
}

/** Every to-do as the daemon knows it: the last read of todos.md plus adds still pending, minus removals still pending. */
export function todoViews(db: Db): TodoView[] {
  const tasks = readSnapshot(db, "todos")?.tasks ?? [];
  const pending = pendingIntents(db, "todos");
  const removing = new Set(pending.filter((i) => i.verb === "rm").map((i) => i.task_id));
  const views = tasks.map(fromTask).filter((v) => !removing.has(v.id));
  const known = new Set([...views.map((v) => v.id), ...removing]);
  for (const intent of pending) {
    if (intent.verb !== "add" || !intent.task_id || known.has(intent.task_id)) continue;
    const args = intentArgs(intent);
    const body = typeof args.flags.body === "string" ? args.flags.body : "";
    views.push({ id: intent.task_id, title: args.positional[1] ?? intent.task_id, state: "pending", due: dueOf(body), body });
    known.add(intent.task_id);
  }
  return views;
}

function findTodo(db: Db, id: string): TodoView {
  const view = todoViews(db).find((v) => v.id === id);
  if (!view) throw new FlowrynError("not_found", `no to-do ${id}`, "list them with: flowryn todo list");
  return view;
}

async function settleIntent(ctx: HandlerCtx, result: HandlerResult): Promise<HandlerResult> {
  const intentId = result.data.intent;
  if (typeof intentId !== "string") return result;
  const row = (await ctx.journal.awaitSettled(intentId, SETTLE_WAIT_MS)) ?? getIntent(ctx.db, intentId);
  if (row?.state === "failed") {
    throw new FlowrynError("rejected_by_tasks_axi", `tasks-axi refused ${row.verb} ${row.task_id}: ${row.last_error ?? "unknown error"}`);
  }
  // A to-do done, removed or moved off the past opens or closes its overdue item now, not at the next pass.
  if (row?.state === "applied") tx(ctx.db, () => syncOverdueTodos(ctx.db, ctx.now()));
  return { ...result, data: { ...result.data, intent_state: row?.state ?? "pending" } };
}

/** Refresh the to-do snapshot first, so a read-modify-write never starts from a stale body. */
async function freshTodos(ctx: HandlerCtx): Promise<void> {
  await ctx.watcher.refreshIfIdle("todos");
}

const todoAdd: VerbSpec = {
  name: "todo add",
  summary: "Add a personal to-do",
  positionals: [{ name: "title", required: true, help: "one line" }],
  flags: {
    due: { type: "string", help: "YYYY-MM-DD, today, tomorrow or +Nd", placeholder: "date" },
    "body-file": { type: "string", help: "notes, read from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "self" },
  apply(ctx, args) {
    const title = validateTitle(stringArg(args, "title")!);
    const due = stringArg(args, "due") ? dueArg(stringArg(args, "due")!, ctx.now()) : null;
    const notes = stringArg(args, "body") ? sanitizeBlock(stringArg(args, "body")!).trim() : "";
    const body = due ? withDue(notes, due) : notes;
    const taken = new Set(todoViews(ctx.db).map((v) => v.id));
    const id = mintTaskId(title, (candidate) => taken.has(candidate));
    const flags: Record<string, string> = { kind: TODO_KIND };
    if (body.length > 0) flags.body = body;
    const intent = recordIntent(ctx.db, { file: "todos", verb: "add", taskId: id, positional: [id, title], flags, now: ctx.now() });
    // A scoped leader's to-do stays in its scope (docs/notes/2026-10-24-leader-scoping-and-vj.md).
    recordTaskScope(ctx.db, ctx.caller, id);
    appendEvent(ctx.db, { source: "cli", kind: "todo.added", taskId: id, payload: { title, due, intent: intent.id } });
    return { data: { todo: id, title, due: due ?? "-", intent: intent.id }, hints: ["flowryn todo list", `flowryn todo done ${id}`] };
  },
  settle: settleIntent,
};

const todoDone: VerbSpec = {
  name: "todo done",
  summary: "Mark a to-do done",
  positionals: [{ name: "id", required: true, help: "to-do id" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "id" },
  prepare: freshTodos,
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const todo = findTodo(ctx.db, id);
    const intent = recordIntent(ctx.db, { file: "todos", verb: "done", taskId: id, positional: [id], now: ctx.now() });
    appendEvent(ctx.db, { source: "cli", kind: "todo.done", taskId: id, payload: { intent: intent.id, already: todo.state === "done" } });
    return { data: { todo: id, title: todo.title, intent: intent.id }, hints: ["flowryn todo list"] };
  },
  settle: settleIntent,
};

const todoDue: VerbSpec = {
  name: "todo due",
  summary: "Set or clear a to-do's due date",
  positionals: [
    { name: "id", required: true, help: "to-do id" },
    { name: "date", required: true, help: "YYYY-MM-DD, today, tomorrow, +Nd or none" },
  ],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "id" },
  prepare: freshTodos,
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const due = dueArg(stringArg(args, "date")!, ctx.now());
    const todo = findTodo(ctx.db, id);
    const pending = pendingIntents(ctx.db, "todos");
    const add = pendingAdd(pending, id);
    const currentBody = pendingBody(pending, id) ?? todo.body;
    const body = withDue(currentBody, due);
    // An add still waiting in the journal gets a follow-up update, applied after it in order.
    const intent = recordIntent(ctx.db, { file: "todos", verb: "update", taskId: id, positional: [id], flags: { body }, now: ctx.now() });
    appendEvent(ctx.db, { source: "cli", kind: "todo.due", taskId: id, payload: { due, intent: intent.id, after_pending_add: Boolean(add) } });
    return { data: { todo: id, title: todo.title, due: due ?? "-", intent: intent.id }, hints: ["flowryn todo list"] };
  },
  settle: settleIntent,
};

const todoEdit: VerbSpec = {
  name: "todo edit",
  summary: "Change a to-do's title or notes (its due date stays; use todo due for that)",
  positionals: [{ name: "id", required: true, help: "to-do id" }],
  flags: {
    title: { type: "string", help: "the new title, one line", placeholder: "text" },
    "body-file": { type: "string", help: "new notes, from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "id" },
  prepare: freshTodos,
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const todo = findTodo(ctx.db, id);
    const rawTitle = stringArg(args, "title");
    const rawBody = stringArg(args, "body");
    if (rawTitle === undefined && rawBody === undefined) throw new FlowrynError("bad_args", "say what changes: --title <text> and/or --body-file -");
    const flags: Record<string, string> = {};
    if (rawTitle !== undefined) flags.title = validateTitle(rawTitle);
    if (rawBody !== undefined) {
      const currentBody = pendingBody(pendingIntents(ctx.db, "todos"), id) ?? todo.body;
      flags.body = withDue(sanitizeBlock(rawBody).trim(), dueOf(currentBody));
    }
    const intent = recordIntent(ctx.db, { file: "todos", verb: "update", taskId: id, positional: [id], flags, now: ctx.now() });
    appendEvent(ctx.db, { source: "cli", kind: "todo.edited", taskId: id, payload: { intent: intent.id, fields: Object.keys(flags) } });
    return { data: { todo: id, title: flags.title ?? todo.title, intent: intent.id }, hints: ["flowryn todo list"] };
  },
  settle: settleIntent,
};

/**
 * `flowryn todo rm <id>`: take a to-do back, added by mistake or no longer
 * wanted, without editing the file (a follow-up M1 left for M3).
 */
const todoRm: VerbSpec = {
  name: "todo rm",
  summary: "Remove a to-do",
  positionals: [{ name: "id", required: true, help: "to-do id" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "id" },
  prepare: freshTodos,
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const todo = findTodo(ctx.db, id);
    const intent = recordIntent(ctx.db, { file: "todos", verb: "rm", taskId: id, positional: [id], now: ctx.now() });
    appendEvent(ctx.db, { source: "cli", kind: "todo.removed", taskId: id, payload: { intent: intent.id, title: todo.title } });
    return { data: { todo: id, title: todo.title, removed: true, intent: intent.id }, hints: ["flowryn todo list"] };
  },
  settle: settleIntent,
};

type DueFilter = "today" | "overdue";

function listTodos(ctx: ReadCtx, args: Args): HandlerResult {
  const today = localDate(new Date(ctx.now));
  const filter = stringArg(args, "due") as DueFilter | undefined;
  if (filter && filter !== "today" && filter !== "overdue") throw new FlowrynError("bad_args", "--due must be today or overdue");
  const all = boolArg(args, "all");
  const when = (due: string | null) => (due === null ? "-" : due < today ? "overdue" : due === today ? "today" : "later");
  const lens = lensFor(ctx.db, ctx.config, ctx.caller.scope);
  const rows = todoViews(ctx.db)
    .filter((v) => lens.task(v.id))
    .filter((v) => all || v.state !== "done")
    .filter((v) => !filter || (filter === "today" ? v.due !== null && v.due <= today : v.due !== null && v.due < today))
    .toSorted((a, b) => {
      if (a.state === "done" && b.state !== "done") return 1;
      if (b.state === "done" && a.state !== "done") return -1;
      if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1;
      return 0;
    })
    .map((v) => ({ id: v.id, due: v.due ?? "-", when: v.state === "done" ? "-" : when(v.due), state: v.state, title: v.title }));
  const pending = pendingIntents(ctx.db, "todos").length;
  const data: Record<string, unknown> = { todos: rows };
  const overdue = rows.filter((r) => r.when === "overdue").length;
  const dueToday = rows.filter((r) => r.when === "today").length;
  data.summary = `${rows.length} shown · due today ${dueToday} · overdue ${overdue}`;
  if (pending > 0) data.journal = `${pending} change(s) waiting to reach todos.md`;
  const hints = rows.length === 0 ? ['flowryn todo add "<title>" --due <date>'] : ["flowryn todo done <id>", "flowryn todo edit <id> --title <text>"];
  return { data, hints };
}

const todoList: VerbSpec = {
  name: "todo list",
  summary: "List to-dos: open ones, soonest due first",
  positionals: [],
  flags: {
    all: { type: "boolean", help: "include done to-dos" },
    due: { type: "string", help: "only today (due today or earlier) or overdue", placeholder: "today|overdue" },
  },
  kind: "read",
  roles: ["leader", "reader", "human"],
  scope: { kind: "list" },
  read: listTodos,
};

export const TODO_VERBS: VerbSpec[] = [todoAdd, todoList, todoDone, todoDue, todoEdit, todoRm];
