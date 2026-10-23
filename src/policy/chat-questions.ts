import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { captainAnswerable, getDecision } from "../lifecycle/decisions.ts";
import { deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import { pendingPlanLine } from "../lifecycle/plans.ts";
import { findRun, taskTitle } from "../lifecycle/runs.ts";
import type { GateRow } from "../lifecycle/stages.ts";
import { getDivergence, isBacklogDivergence } from "../reconcile/divergence.ts";
import { sha256Hex } from "../util/hash.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The binding questions of chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md).
 * A leader AskUserQuestion question authorises an action only in the exact form Flowryn writes
 * for one item, so the leader never words what you are answering: `flowryn chat-question <id>`
 * prints it, the PreToolUse hook denies a question that starts like a binding one but differs,
 * and the PostToolUse hook writes the form again (stale facts, such as a moved PR head, grant
 * nothing). Plain code: a prefix, fixed templates, string equality.
 */

/** What an answer to a binding question can authorise. */
export type GrantAction = "decide" | "gate" | "divergence" | "merge";

export interface ChatOption {
  label: string;
  description: string;
}

/** One AskUserQuestion question, as the tool takes it. */
export interface ChatQuestion {
  question: string;
  header: string;
  options: ChatOption[];
  multiSelect: boolean;
}

export interface ChatForm {
  /** The item: q42, k3, g81, d13 or merge:<task>. */
  ref: string;
  action: GrantAction;
  task: string | null;
  question: ChatQuestion;
  /** Each label's choice; null grants nothing (Don't merge). */
  choices: { label: string; choice: string | null }[];
  /** Besides the item: the PR head a merge answer binds to. */
  binds: string | null;
  /** The choice an "Other" answer becomes, with the answer as its words (a gate's changes), or null: free text grants nothing. */
  freeText: string | null;
}

/** AskUserQuestion takes 2 to 4 options per question. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const SEPARATOR = " · ";
const RECOMMENDED = " (Recommended)";
const BINDING_PREFIX = /^(q\d+|k\d+|g\d+|d\d+|merge [A-Za-z0-9][\w.-]*) · /;

/** The item a question binds to, from its prefix (`q42 · `, `merge T17 · `), or null for an ordinary question. */
export function bindingRef(question: string): string | null {
  const match = BINDING_PREFIX.exec(question);
  if (!match) return null;
  const head = match[1]!;
  return head.startsWith("merge ") ? `merge:${head.slice("merge ".length)}` : head;
}

/** The item as typed on the command line: q42, g81, d13, or merge:<task> (also `merge <task>`). */
export function parseRef(typed: string): string {
  const trimmed = typed.trim();
  const merge = /^merge[: ]\s*([A-Za-z0-9][\w.-]*)$/.exec(trimmed);
  if (merge) return `merge:${merge[1]}`;
  if (/^[qkgd]\d+$/.test(trimmed)) return trimmed;
  throw new FlowrynError("bad_args", `a chat question names q<N>, k<N>, g<N>, d<N> or merge:<task>, not "${sanitizeLine(trimmed, 60)}"`);
}

function option(label: string, description: string): ChatOption {
  return { label, description };
}

function decisionForm(db: Db, id: string): ChatForm {
  const d = getDecision(db, id);
  if (!d) throw new FlowrynError("not_found", `no decision ${id}`, "flowryn decision list");
  if (!captainAnswerable(d)) throw new FlowrynError("not_ready", `decision ${id} is already ${d.state}`);
  const opts = JSON.parse(d.options) as string[];
  if ((d.kind ?? "single") === "text" || opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) {
    throw new FlowrynError("not_ready", `decision ${id} has ${opts.length} options; a chat question takes ${MIN_OPTIONS} to ${MAX_OPTIONS}`, `ask it as before: flowryn decide ${id} <choice> --by captain (Claude prompts the user)`);
  }
  const labelOf = (o: string) => (o === d.recommendation ? `${o}${RECOMMENDED}` : o);
  return {
    ref: d.id,
    action: "decide",
    task: d.task_id,
    question: {
      question: `${d.id}${SEPARATOR}${sanitizeLine(d.question, 400)}`,
      header: d.id,
      options: opts.map((o) => option(labelOf(o), `Record "${o}" as your answer to ${d.id}`)),
      multiSelect: d.kind === "multi",
    },
    choices: opts.map((o) => ({ label: labelOf(o), choice: o })),
    binds: null,
    freeText: null,
  };
}

function gateForm(db: Db, id: string): ChatForm {
  const gate = db.query("SELECT * FROM gates WHERE id = ?1").get(id) as GateRow | null;
  if (!gate || gate.kind !== "review") throw new FlowrynError("not_found", `no review gate ${id}`, "flowryn fleet");
  if (gate.state !== "open") throw new FlowrynError("not_ready", `gate ${id} is ${gate.state}, not open`);
  const run = db.query("SELECT task_id FROM runs WHERE id = ?1").get(gate.run_id) as { task_id: string } | null;
  if (!run) throw new FlowrynError("not_found", `gate ${id} has no run`);
  const open = db.query("SELECT id FROM decisions WHERE gate_id = ?1 AND state = 'open' ORDER BY id").all(gate.id) as { id: string }[];
  if (open.length > 0) {
    throw new FlowrynError("questions_open", `gate ${id} still has open questions (${open.map((q) => q.id).join(", ")})`, `ask those first: flowryn chat-question ${open[0]!.id}`);
  }
  const plan = pendingPlanLine(db, gate.id);
  const title = sanitizeLine(taskTitle(db, run.task_id), 120);
  return {
    ref: gate.id,
    action: "gate",
    task: run.task_id,
    question: {
      question: `${gate.id}${SEPARATOR}Pass the ${gate.stage} review of ${run.task_id} (${title})? Page: ${gate.review_url ?? "none"}${plan ? `; passing also approves ${plan}` : ""}`,
      header: gate.id,
      options: [option("Pass", "Pass the review; the next stage starts at once"), option("Changes", "Send it back; type what to change as your own answer")],
      multiSelect: false,
    },
    choices: [
      { label: "Pass", choice: "pass" },
      { label: "Changes", choice: "changes" },
    ],
    binds: null,
    freeText: "changes",
  };
}

function divergenceForm(db: Db, id: string): ChatForm {
  const d = getDivergence(db, id);
  if (!d) throw new FlowrynError("not_found", `no divergence ${id}`, "flowryn fleet");
  if (d.resolved_at !== null) throw new FlowrynError("not_ready", `divergence ${id} is already resolved (${d.resolution ?? "?"})`);
  if (!isBacklogDivergence(d)) throw new FlowrynError("not_ready", `divergence ${id} is not a backlog edit: keep-run is its only resolution, and it needs no word from the user`, `flowryn divergence resolve ${id} keep-run`);
  return {
    ref: d.id,
    action: "divergence",
    task: d.task_id,
    question: {
      question: `${d.id}${SEPARATOR}${sanitizeLine(d.summary, 300)}: which side wins?`,
      header: d.id,
      options: [option("keep-run", "The run's state goes back into the backlog"), option("accept-edit", "Your backlog edit stands; a live run is cancelled")],
      multiSelect: false,
    },
    choices: [
      { label: "keep-run", choice: "keep-run" },
      { label: "accept-edit", choice: "accept-edit" },
    ],
    binds: null,
    freeText: null,
  };
}

function mergeForm(db: Db, task: string): ChatForm {
  const run = findRun(db, task);
  if (!run) throw new FlowrynError("not_found", `no task ${task}`, "flowryn fleet");
  const shipped = deliveredOf(db, run.task_id);
  if (!shipped) throw new FlowrynError("not_ready", `${run.task_id} has delivered nothing to merge`, `flowryn show ${run.task_id}`);
  const evidence = shipped.kind === "pr" ? prEvidence(db, run.id) : null;
  const head = evidence?.head ?? shipped.head;
  const where = shipped.kind === "pr" ? `PR ${shipped.ref} at ${head.slice(0, 8)}, checks ${evidence?.checks?.line ?? "unknown"}` : `branch ${run.branch} at ${head.slice(0, 8)} into local main`;
  return {
    ref: `merge:${run.task_id}`,
    action: "merge",
    task: run.task_id,
    question: {
      question: `merge ${run.task_id}${SEPARATOR}${sanitizeLine(taskTitle(db, run.task_id), 120)}: ${where}`,
      header: "merge",
      options: [option("Merge", `Merge ${run.task_id} at ${head.slice(0, 8)}; never waives a red check`), option("Don't merge", "Leave it unmerged")],
      multiSelect: false,
    },
    choices: [
      { label: "Merge", choice: "merge" },
      { label: "Don't merge", choice: null },
    ],
    binds: head,
    freeText: null,
  };
}

/** The binding form for an item, from what flowrynd knows now. Throws when the item cannot be asked. */
export function chatForm(db: Db, ref: string): ChatForm {
  if (ref.startsWith("merge:")) return mergeForm(db, ref.slice("merge:".length));
  if (/^[qk]\d+$/.test(ref)) return decisionForm(db, ref);
  if (/^g\d+$/.test(ref)) return gateForm(db, ref);
  if (/^d\d+$/.test(ref)) return divergenceForm(db, ref);
  throw new FlowrynError("bad_args", `${ref} is not an item a chat question can name`);
}

/** A question as compared and hashed: only the fields the user sees, trimmed, in a fixed order. */
export function normalizeQuestion(raw: unknown): ChatQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.question !== "string" || !Array.isArray(q.options)) return null;
  const options: ChatOption[] = [];
  for (const o of q.options as unknown[]) {
    if (!o || typeof o !== "object") return null;
    const { label, description } = o as Record<string, unknown>;
    if (typeof label !== "string") return null;
    options.push({ label: label.trim(), description: typeof description === "string" ? description.trim() : "" });
  }
  return { question: q.question.trim(), header: typeof q.header === "string" ? q.header.trim() : "", options, multiSelect: q.multiSelect === true };
}

export function sameQuestion(a: ChatQuestion, b: ChatQuestion): boolean {
  return JSON.stringify(normalizeQuestion(a)) === JSON.stringify(normalizeQuestion(b));
}

/** The hash both hooks and the transcript check compute over a tool call's questions. */
export function questionsHash(questions: ChatQuestion[]): string {
  return sha256Hex(`flowryn-chat-questions\n${JSON.stringify(questions.map((q) => normalizeQuestion(q)))}`);
}

export type Mapped = { kind: "grant"; choice: string; words: string | null } | { kind: "declined"; label: string } | { kind: "none"; why: string };

/**
 * What an answer authorises. A label (or, for a multi-select, labels joined by commas) names
 * the choice; any other text is "Other": a gate's changes with those words, else nothing.
 * Your notes on the answer travel as words.
 */
export function mapAnswer(form: ChatForm, answer: string, notes: string | null): Mapped {
  const text = answer.trim();
  const byLabel = new Map(form.choices.map((c) => [c.label, c.choice]));
  const exact = byLabel.get(text);
  if (exact !== undefined) return exact === null ? { kind: "declined", label: text } : { kind: "grant", choice: exact, words: notes };
  if (form.question.multiSelect) {
    const parts = text.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    const chosen = parts.map((p) => byLabel.get(p));
    if (parts.length > 0 && chosen.every((c) => typeof c === "string")) return { kind: "grant", choice: (chosen as string[]).join(", "), words: notes };
  }
  if (text.length === 0) return { kind: "none", why: "no answer" };
  if (form.freeText) return { kind: "grant", choice: form.freeText, words: notes ? `${text}\n${notes}` : text };
  return { kind: "none", why: "a free-text answer names no option, so it authorises nothing" };
}
