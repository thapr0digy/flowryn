import type { HandlerResult, ReadCtx } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { ShowText } from "../lifecycle/show-text.ts";
import { MAX_LINE_CHARS } from "../util/sanitize.ts";
import { isOpenAsk, type AskRow } from "./store.ts";

/** An answer in `show`, unless --full: its first lines, each cut. */
const ANSWER_LINES = 60;
const QUESTION_LINES = 12;

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function usd(n: number | null): string {
  if (n === null) return "-";
  return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
}

function openAskItem(db: Db, id: string): { id: string; kind: string } | null {
  return db.query("SELECT id, kind FROM items WHERE task_id = ?1 AND kind IN ('answer_ready','ask_failed') AND state IN ('open','presented') ORDER BY opened_at DESC LIMIT 1").get(id) as { id: string; kind: string } | null;
}

/**
 * `flowryn show a<N>`: the question, how the call went, and the answer (its first lines, or whole
 * with --full). The leader's read of a whole answer closes its answer_ready item.
 */
export function askView(ctx: ReadCtx, ask: AskRow, full: boolean): HandlerResult {
  const text = new ShowText(full);
  const item = openAskItem(ctx.db, ask.id);
  const ran = ask.started_at !== null ? span((ask.ended_at ?? ctx.now) - ask.started_at) : "-";
  const data: Record<string, unknown> = {
    ask: ask.id,
    state: ask.state,
    project: ask.project_id,
    title: ask.title,
    harness: `${ask.harness} (account ${ask.account})`,
    ...(ask.model_pin || ask.effort_pin ? { model: [ask.model_pin, ask.effort_pin].filter(Boolean).join(" ") } : {}),
    spend: `${usd(ask.cost_usd)} of a ${usd(ask.max_usd)} cap`,
    asked: `${span(ctx.now - ask.created_at)} ago by ${ask.created_by}`,
    ran: ask.attempts > 1 ? `${ran} (attempt ${ask.attempts})` : ran,
    ...(item ? { item: item.id } : {}),
    question: text.block(ask.question, QUESTION_LINES, MAX_LINE_CHARS),
  };
  if (ask.reason) data.reason = text.line(ask.reason, MAX_LINE_CHARS);
  if (ask.promoted_task) data.scout = ask.promoted_task;
  if (ask.answer !== null) data.answer = text.block(ask.answer, ANSWER_LINES, MAX_LINE_CHARS);
  if (ask.answer_path) data.whole_answer = ask.answer_path;
  Object.assign(data, text.pointer(ask.id));
  const hints: string[] = [];
  if (text.cut) hints.push(`flowryn show ${ask.id} --full`);
  if (ask.promoted_task) hints.push(`flowryn show ${ask.promoted_task}`);
  else if (ask.state === "answered" || ask.state === "failed") hints.push(`flowryn promote ${ask.id} (a scout on the same question)`);
  if (isOpenAsk(ask)) hints.push(`flowryn drop ${ask.id}`);
  else if (item) hints.push(`flowryn dismiss ${item.id}`);
  const whole = !text.cut && ask.answer !== null;
  return {
    data,
    hints: hints.length > 0 ? hints : ["flowryn fleet"],
    ...(item?.kind === "answer_ready" && whole ? { reportsRead: [{ item: item.id, form: full ? "item-full" : "item" }] } : {}),
  };
}

/** One line per open ask, for `fleet`. */
export function askLines(db: Db, now: number, visible: (projectId: string) => boolean): string[] {
  const rows = db.query("SELECT * FROM asks WHERE state IN ('queued','running') ORDER BY created_at, id").all() as AskRow[];
  return rows
    .filter((a) => visible(a.project_id))
    .map((a) => `${a.id} ${a.state} ${a.project_id} · ${a.title.slice(0, 80)} · ${a.state === "running" && a.started_at !== null ? `${span(now - a.started_at)} in` : `queued ${span(now - a.created_at)}`}`);
}
