import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type HandlerCtx } from "../api/verbs.ts";
import { grantsConfig } from "../config/leader.ts";
import { getSession } from "../lease/lease.ts";
import { findAttempt, type ApprovalAction } from "./approvals.ts";
import { tx, getMeta, setMeta, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { bindingRef, chatForm, mapAnswer, normalizeQuestion, questionsHash, sameQuestion, type ChatForm, type ChatQuestion, type GrantAction } from "./chat-questions.ts";

/**
 * Chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md): your answer to a
 * leader AskUserQuestion, in a binding form (chat-questions.ts), authorises exactly the action it
 * names, once, within this turn and at most GRANT_TTL_MS. Only the Claude leader's own hooks make
 * one: PreToolUse records the question (and denies one that brings its own answers), PostToolUse
 * reads your answer. The hook token is the leader's token too, so before a grant is used the
 * daemon also finds the question and your answer in Claude's own transcript, a file the leader
 * cannot write (src/policy/static.ts). Plain code: no model reads an answer.
 */

/** A grant lives until the turn ends, and at most this long (the user's choice, q43). */
export const GRANT_TTL_MS = 10 * 60_000;
/** How much of the transcript's end the check reads: the answer is a few tool calls back. */
export const TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;
/** Clock skew allowed between Claude's transcript timestamps and the hook's. */
const SKEW_MS = 60_000;
/** What a refusal that a repin fixes tells the leader to pass on (docs/notes/2026-10-11-flowryn-leader-repin-xv.md). */
export const REPIN_FIX = "run flowryn leader repin in your terminal";
const REPIN_HELP = "the user runs: flowryn leader repin (in their own terminal, not the leader's)";

/** When the session's directory was last repinned from your terminal; nothing from before it counts. */
export function pinnedAt(db: Db, session: string): number | null {
  return (db.query("SELECT pinned_at FROM leader_sessions WHERE session_id = ?1").get(session) as { pinned_at: number | null } | null)?.pinned_at ?? null;
}

export interface GrantRow {
  id: string;
  session_id: string;
  tool_use_id: string;
  item: string;
  action: GrantAction;
  task_id: string | null;
  choice: string;
  words: string | null;
  question: string;
  answer: string;
  binds: string | null;
  transcript_path: string;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
  consumed_by: string | null;
  voided_at: number | null;
  void_reason: string | null;
}

function nextGrantId(db: Db): string {
  const next = Number(getMeta(db, "next_grant_no") ?? "1");
  setMeta(db, "next_grant_no", String(next + 1));
  return `c${next}`;
}

export function getGrant(db: Db, id: string): GrantRow | null {
  return db.query("SELECT * FROM captain_grants WHERE id = ?1").get(id) as GrantRow | null;
}

/** The questions of an AskUserQuestion input, normalized; null when the input is not one. */
function questionsOf(input: unknown): ChatQuestion[] | null {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>).questions : undefined;
  if (!Array.isArray(raw)) return null;
  const out: ChatQuestion[] = [];
  for (const q of raw) {
    const n = normalizeQuestion(q);
    if (!n) return null;
    out.push(n);
  }
  return out;
}

function nonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "object" || Object.keys(value as object).length > 0);
}

// --- PreToolUse -----------------------------------------------------------------------------

/**
 * The leader is about to ask. A question that starts like a binding one must be exactly the form
 * Flowryn writes now; the call must not carry its own answers (or Claude would skip the dialog);
 * each item at most once. Returns the reason to deny it, or null. A call with no binding question
 * is not recorded and grants nothing. Call inside a transaction.
 */
export function preAsk(db: Db, a: { session: string; toolUseId: string; input: unknown; now: number }): string | null {
  const input = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  const questions = questionsOf(input);
  if (!questions) return null;
  const refs = questions.map((q) => bindingRef(q.question));
  if (refs.every((r) => r === null)) return null;
  const deny = (why: string) => {
    appendEvent(db, { source: "hook", kind: "chat.question_denied", payload: { session: a.session, tool_use: a.toolUseId, items: refs.filter((r) => r !== null), why }, ts: a.now });
    return `Flowryn: ${why}`;
  };
  if (nonEmpty(input.answers) || nonEmpty(input.annotations)) return deny("a binding question may not carry its own answers; ask it with questions only, so the user answers");
  if (!a.toolUseId) return deny("no tool use id, so no answer could be bound to this question");
  const seen = new Set<string>();
  for (let i = 0; i < questions.length; i++) {
    const ref = refs[i];
    if (!ref) continue;
    if (seen.has(ref)) return deny(`${ref} is asked twice in one call`);
    seen.add(ref);
    let form: ChatForm;
    try {
      form = chatForm(db, ref);
    } catch (error) {
      if (error instanceof FlowrynError) return deny(`${ref} cannot be asked: ${error.message}`);
      throw error;
    }
    if (!sameQuestion(questions[i]!, form.question)) {
      return deny(`the question for ${ref} must be exactly what \`flowryn chat-question ${ref.replace(/^merge:/, "merge:")}\` prints, unchanged (labels and descriptions included): ${JSON.stringify(form.question)}`);
    }
  }
  if (db.query("SELECT 1 FROM chat_questions WHERE tool_use_id = ?1").get(a.toolUseId)) return deny(`tool use ${a.toolUseId} was already asked`);
  db.query("INSERT INTO chat_questions (tool_use_id, session_id, input_hash, refs, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(
    a.toolUseId,
    a.session,
    questionsHash(questions),
    JSON.stringify([...seen]),
    a.now,
  );
  appendEvent(db, { source: "hook", kind: "chat.question_asked", payload: { session: a.session, tool_use: a.toolUseId, items: [...seen] }, ts: a.now });
  return null;
}

// --- PostToolUse ----------------------------------------------------------------------------

export interface PostAsk {
  session: string;
  toolUseId: string;
  input: unknown;
  response: unknown;
  /** The harness's own session id and transcript, from the hook payload. */
  claudeSession: string;
  transcriptPath: string;
  now: number;
}

/** A question line that names your answer and what it does. */
function grantLine(g: GrantRow): string {
  const what = g.action === "decide" ? `your answer to ${g.item} is "${g.choice}"` : g.action === "gate" ? `${g.choice} for gate ${g.item}` : g.action === "divergence" ? `${g.choice} for ${g.item}` : `merge ${g.task_id} at ${g.binds?.slice(0, 8) ?? "?"}`;
  return `Grant ${g.id}: ${what}. Run it now: flowryn grant use ${g.id}${g.action === "gate" && g.choice === "changes" && !g.words ? " --body-file - (the user's words: what to change)" : ""}. It ends with this turn.`;
}

/**
 * The user answered. For each binding question this tool call recorded, map the answer to a
 * choice and mint a grant. Returns the lines the leader sees beside the tool result. Call inside
 * a transaction.
 */
export function postAsk(db: Db, a: PostAsk): string[] {
  const questions = questionsOf(a.input);
  if (!questions) return [];
  const refs = questions.map((q) => bindingRef(q.question));
  if (refs.every((r) => r === null)) return [];
  const asked = db.query("SELECT * FROM chat_questions WHERE tool_use_id = ?1").get(a.toolUseId) as {
    session_id: string;
    input_hash: string;
    created_at: number;
    answered_at: number | null;
  } | null;
  const ignore = (why: string) => {
    appendEvent(db, { source: "hook", kind: "chat.answer_ignored", payload: { session: a.session, tool_use: a.toolUseId, items: refs.filter((r) => r !== null), why }, ts: a.now });
    return [`Flowryn: this answer grants nothing (${why}).`];
  };
  if (!asked || asked.session_id !== a.session) return ignore("Flowryn did not see this question asked");
  if (asked.answered_at !== null) return ignore("this question was already answered");
  if (asked.input_hash !== questionsHash(questions)) return ignore("the questions changed after they were asked");
  const pin = pinnedAt(db, a.session);
  if (pin !== null && asked.created_at < pin) return ignore("it was asked before the leader was repinned; ask again");
  if (basename(a.transcriptPath) !== `${a.claudeSession}.jsonl`) return ignore("the transcript does not belong to this session");
  db.query("UPDATE chat_questions SET answered_at = ?2 WHERE tool_use_id = ?1").run(a.toolUseId, a.now);
  const response = (a.response && typeof a.response === "object" ? a.response : {}) as Record<string, unknown>;
  const answers = (response.answers && typeof response.answers === "object" ? response.answers : {}) as Record<string, unknown>;
  const annotations = (response.annotations && typeof response.annotations === "object" ? response.annotations : {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const ref = refs[i];
    if (!ref) continue;
    const q = questions[i]!;
    const answer = typeof answers[q.question] === "string" ? (answers[q.question] as string) : null;
    const note = (annotations[q.question] as { notes?: unknown } | undefined)?.notes;
    const notes = typeof note === "string" && note.trim().length > 0 ? sanitizeBlock(note).trim().slice(0, 2_000) : null;
    const refuse = (why: string) => {
      appendEvent(db, { source: "hook", kind: "grant.refused", payload: { session: a.session, tool_use: a.toolUseId, item: ref, why }, ts: a.now });
      lines.push(`Flowryn: no grant for ${ref} (${why}).`);
    };
    if (answer === null) {
      refuse("no answer");
      continue;
    }
    let form: ChatForm;
    try {
      form = chatForm(db, ref);
    } catch (error) {
      if (!(error instanceof FlowrynError)) throw error;
      refuse(error.message);
      continue;
    }
    if (!sameQuestion(q, form.question)) {
      refuse("its facts changed while the user answered; ask again");
      continue;
    }
    const mapped = mapAnswer(form, sanitizeBlock(answer), notes);
    if (mapped.kind === "none") {
      refuse(mapped.why);
      continue;
    }
    replaceEarlierGrants(db, a.session, ref, a.now);
    if (mapped.kind === "declined") {
      appendEvent(db, { source: "hook", kind: "grant.declined", taskId: form.task, payload: { session: a.session, tool_use: a.toolUseId, item: ref, answer: mapped.label }, ts: a.now });
      lines.push(`Flowryn: the user answered "${mapped.label}" to ${ref}; nothing is granted.`);
      continue;
    }
    const id = nextGrantId(db);
    db.query(
      `INSERT INTO captain_grants (id, session_id, tool_use_id, item, action, task_id, choice, words, question, answer, binds, transcript_path, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).run(id, a.session, a.toolUseId, ref, form.action, form.task, mapped.choice, mapped.words, q.question, answer, form.binds, a.transcriptPath, a.now, a.now + GRANT_TTL_MS);
    appendEvent(db, {
      source: "hook",
      kind: "grant.recorded",
      taskId: form.task,
      payload: { grant: id, session: a.session, tool_use: a.toolUseId, item: ref, action: form.action, choice: mapped.choice, words: mapped.words, answer: sanitizeLine(answer, 300), binds: form.binds },
      ts: a.now,
    });
    lines.push(grantLine(getGrant(db, id)!));
  }
  return lines;
}

// --- voids ------------------------------------------------------------------------------------

function voidRows(db: Db, rows: { id: string; task_id: string | null }[], reason: string, now: number): number {
  for (const row of rows) {
    db.query("UPDATE captain_grants SET voided_at = ?2, void_reason = ?3 WHERE id = ?1 AND consumed_at IS NULL AND voided_at IS NULL").run(row.id, now, reason);
    appendEvent(db, { source: "hook", kind: "grant.voided", taskId: row.task_id, payload: { grant: row.id, why: reason }, ts: now });
  }
  return rows.length;
}

/** The user answered the same item again in this session: the later answer is the one that counts. */
function replaceEarlierGrants(db: Db, session: string, item: string, now: number): number {
  const rows = db.query("SELECT id, task_id FROM captain_grants WHERE session_id = ?1 AND item = ?2 AND consumed_at IS NULL AND voided_at IS NULL").all(session, item) as { id: string; task_id: string | null }[];
  return voidRows(db, rows, "a later answer replaced it", now);
}

/** The turn ended (Stop, your next message, the session's end): its grants end with it. Call inside a transaction. */
export function voidSessionGrants(db: Db, session: string, reason: string, now: number): number {
  const rows = db.query("SELECT id, task_id FROM captain_grants WHERE session_id = ?1 AND consumed_at IS NULL AND voided_at IS NULL").all(session) as { id: string; task_id: string | null }[];
  return voidRows(db, rows, reason, now);
}

/** A confirmed prompt answered the same item: your later word wins, and the chat grant ends. */
export function voidItemGrants(db: Db, item: string, reason: string, now: number): number {
  const rows = db.query("SELECT id, task_id FROM captain_grants WHERE item = ?1 AND consumed_at IS NULL AND voided_at IS NULL").all(item) as { id: string; task_id: string | null }[];
  return voidRows(db, rows, reason, now);
}

// --- use ----------------------------------------------------------------------------------------

export interface GrantAsk {
  session: string;
  item: string;
  /** The choice the command carries; a grant for another choice refuses it. */
  choice: string;
  /** `flowryn grant use <id>`: that grant only. */
  grantId: string | null;
  /** A merge: the head it would merge. */
  head?: string | null;
}

function normalChoice(choice: string): string {
  return choice.split(",").map((p) => p.trim()).filter((p) => p.length > 0).join(", ");
}

/** "a, b" and "a,b" are one multi choice. */
function sameChoice(a: string, b: string): boolean {
  return normalChoice(a) === normalChoice(b);
}

function liveState(g: GrantRow, now: number): string | null {
  if (g.consumed_at !== null) return `grant ${g.id} was already used (${g.consumed_by ?? "?"})`;
  if (g.voided_at !== null) return `grant ${g.id} was voided: ${g.void_reason ?? "?"}`;
  if (g.expires_at <= now) return `grant ${g.id} expired`;
  return null;
}

/**
 * The grant a command would use: the one named (`grant use`), or a live one of this session for
 * the item. None: null. A live grant for another choice, or a named one for another item,
 * session or choice, is refused. Throws approval_required or grant_mismatch.
 */
export function findGrant(db: Db, ask: GrantAsk, now: number): GrantRow | null {
  if (ask.grantId) {
    const g = getGrant(db, ask.grantId);
    if (!g) throw new FlowrynError("not_found", `no grant ${ask.grantId}`);
    if (g.session_id !== ask.session) throw new FlowrynError("approval_required", `grant ${g.id} belongs to another leader session`);
    const dead = liveState(g, now);
    if (dead) throw new FlowrynError("approval_required", dead, `ask the user again: flowryn chat-question ${g.item}`);
    if (g.item !== ask.item || !sameChoice(g.choice, ask.choice)) throw new FlowrynError("grant_mismatch", `grant ${g.id} is for ${g.item} = ${g.choice}, not ${ask.item} = ${ask.choice}`);
    return g;
  }
  const live = (db.query("SELECT * FROM captain_grants WHERE session_id = ?1 AND item = ?2 AND consumed_at IS NULL AND voided_at IS NULL ORDER BY created_at DESC").all(ask.session, ask.item) as GrantRow[]).filter(
    (g) => g.expires_at > now,
  );
  if (live.length === 0) return null;
  const match = live.find((g) => sameChoice(g.choice, ask.choice));
  if (match) return match;
  throw new FlowrynError("grant_mismatch", `the user's chat answer to ${ask.item} was "${live[0]!.choice}" (grant ${live[0]!.id}), not "${ask.choice}"`, `flowryn grant use ${live[0]!.id}`);
}

/** The last bytes of a file, split into whole lines. */
export function tailLines(path: string, bytes: number): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/** The folder Claude keeps a directory's transcripts in: every character but A-Z, a-z and 0-9 becomes '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function within(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir);
    return realpathSync(path).startsWith(root + sep);
  } catch {
    return false;
  }
}

/**
 * Claude's own record of the question and answer: the transcript the session started with,
 * directly in Claude's project folder for the directory `flowryn lead` opened the session in,
 * holding the AskUserQuestion tool use with the same questions and no answers of its own and,
 * after the question was recorded, its tool result with the same answer. Returns why it fails,
 * or null.
 */
export function transcriptProblem(
  g: GrantRow,
  check: { sessionTranscript: string | null; projectsDir: string; cwd: string | null; askedAt: number; inputHash: string; pinnedAt?: number | null },
): string | null {
  const pin = check.pinnedAt ?? null;
  if (!check.sessionTranscript || check.sessionTranscript !== g.transcript_path) return "the transcript is not the one this leader session started with";
  if (!within(check.projectsDir, g.transcript_path)) return `the transcript is not inside Claude's projects directory (${check.projectsDir})`;
  if (!check.cwd) return `the leader session has no working directory to find its transcript by; ${REPIN_FIX}`;
  if (!sameDir(dirname(g.transcript_path), join(check.projectsDir, claudeProjectSlug(check.cwd)))) return `the transcript is not in Claude's project folder for the leader's directory (${check.cwd}); ${REPIN_FIX}`;
  if (pin !== null && (g.created_at < pin || check.askedAt < pin)) return "it was asked before the leader was repinned";
  // After a repin no answer line older than the repin counts, whatever the skew allowance.
  const answeredFrom = pin === null ? check.askedAt - SKEW_MS : Math.max(check.askedAt - SKEW_MS, pin);
  const claudeSession = basename(g.transcript_path).replace(/\.jsonl$/, "");
  let lines: string[];
  try {
    lines = tailLines(g.transcript_path, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return "the transcript cannot be read";
  }
  let asked = false;
  let prefilled = false;
  let answered = false;
  for (const line of lines) {
    if (!line.includes(g.tool_use_id)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.sessionId !== claudeSession) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const content = ((entry.message as { content?: unknown } | undefined)?.content ?? []) as unknown[];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (entry.type === "assistant" && p.type === "tool_use" && p.id === g.tool_use_id && p.name === "AskUserQuestion") {
        const qs = questionsOf(p.input);
        if (qs && questionsHash(qs) === check.inputHash) asked = true;
        const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
        if (nonEmpty(input.answers) || nonEmpty(input.annotations)) prefilled = true;
      }
      if (entry.type === "user" && p.type === "tool_result" && p.tool_use_id === g.tool_use_id) {
        const result = entry.toolUseResult as { answers?: Record<string, unknown> } | undefined;
        if (result?.answers?.[g.question] === g.answer && Number.isFinite(at) && at >= answeredFrom) answered = true;
      }
    }
  }
  if (prefilled) return "the question carried its own answers";
  if (!asked) return "Claude's transcript has no such question";
  if (!answered) return "Claude's transcript has no such answer from the user";
  return null;
}

/**
 * Before a command uses a grant (outside its transaction): find it, and check it against Claude's
 * transcript. A refusal is recorded as an event in its own transaction, then thrown. Returns the
 * grant id to take in the command's transaction, or null when no grant applies.
 */
export function prepareGrant(ctx: { db: Db; now(): number }, ask: GrantAsk, projectsDir: string): string | null {
  const now = ctx.now();
  const refuse = (error: FlowrynError, grant: string | null): never => {
    tx(ctx.db, () => appendEvent(ctx.db, { source: "cli", kind: "grant.refused", payload: { grant, session: ask.session, item: ask.item, choice: ask.choice, why: error.message }, ts: now }));
    throw error;
  };
  let g: GrantRow | null;
  try {
    g = findGrant(ctx.db, ask, now);
  } catch (error) {
    if (error instanceof FlowrynError) return refuse(error, ask.grantId);
    throw error;
  }
  if (!g) return null;
  if (g.action === "merge" && ask.head !== undefined && ask.head !== g.binds) {
    return refuse(new FlowrynError("approval_required", `grant ${g.id} was for head ${g.binds?.slice(0, 8) ?? "?"}; the head is now ${ask.head?.slice(0, 8) ?? "?"}`, `ask the user again: flowryn chat-question merge:${g.task_id}`), g.id);
  }
  if (g.verified_at === null) {
    const session = ctx.db.query("SELECT transcript_path, cwd, pinned_at FROM leader_sessions WHERE session_id = ?1").get(g.session_id) as { transcript_path: string | null; cwd: string | null; pinned_at: number | null } | null;
    const asked = ctx.db.query("SELECT created_at, input_hash FROM chat_questions WHERE tool_use_id = ?1").get(g.tool_use_id) as { created_at: number; input_hash: string } | null;
    const problem = asked
      ? transcriptProblem(g, { sessionTranscript: session?.transcript_path ?? null, projectsDir, cwd: session?.cwd ?? null, askedAt: asked.created_at, inputHash: asked.input_hash, pinnedAt: session?.pinned_at ?? null })
      : "the question was never recorded";
    if (problem) return refuse(new FlowrynError("approval_required", `grant ${g.id} cannot be used: ${problem}`, problem.endsWith(REPIN_FIX) ? REPIN_HELP : undefined), g.id);
    tx(ctx.db, () => {
      ctx.db.query("UPDATE captain_grants SET verified_at = ?2 WHERE id = ?1").run(g!.id, now);
      appendEvent(ctx.db, { source: "cli", kind: "grant.verified", taskId: g!.task_id, payload: { grant: g!.id }, ts: now });
    });
  }
  return g.id;
}

/** Use the prepared grant, in the command's transaction: still live and verified, or refused. */
export function takeGrant(db: Db, id: string, usedBy: string, now: number): GrantRow {
  const g = getGrant(db, id);
  if (!g) throw new FlowrynError("not_found", `no grant ${id}`);
  const dead = liveState(g, now);
  if (dead) throw new FlowrynError("approval_required", dead);
  if (g.verified_at === null) throw new FlowrynError("approval_required", `grant ${id} is not verified`);
  const pin = pinnedAt(db, g.session_id);
  if (pin !== null && g.created_at < pin) throw new FlowrynError("approval_required", `grant ${id} was made before the leader was repinned`);
  db.query("UPDATE captain_grants SET consumed_at = ?2, consumed_by = ?3 WHERE id = ?1").run(id, now, usedBy);
  appendEvent(db, { source: "cli", kind: "grant.used", taskId: g.task_id, payload: { grant: id, item: g.item, choice: g.choice, by: usedBy }, ts: now });
  return { ...g, consumed_at: now, consumed_by: usedBy };
}

/** Grants for `flowryn show`: one line each, newest first. */
export function grantLines(db: Db, where: { item?: string; task?: string; session?: string }, now: number): string[] {
  const rows = (where.item
    ? db.query("SELECT * FROM captain_grants WHERE item = ?1 ORDER BY created_at DESC LIMIT 10").all(where.item)
    : where.session
      ? db.query("SELECT * FROM captain_grants WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 10").all(where.session)
      : db.query("SELECT * FROM captain_grants WHERE task_id = ?1 ORDER BY created_at DESC LIMIT 10").all(where.task ?? "")) as GrantRow[];
  return rows.map((g) => {
    const state = g.consumed_at !== null ? `used by ${g.consumed_by ?? "?"}` : g.voided_at !== null ? `voided: ${g.void_reason ?? "?"}` : g.expires_at <= now ? "expired" : "live";
    const words = g.words ? ` · words "${sanitizeLine(g.words, 80)}"` : "";
    return `${g.id} · ${g.item} = ${g.choice} · answer "${sanitizeLine(g.answer, 60)}"${words} · leader ${g.session_id} · ${new Date(g.created_at).toISOString()} · ${state}`;
  });
}

/** `flowryn show c<N>`: one grant in full. */
export function grantView(g: GrantRow, now: number): Record<string, unknown> {
  return {
    grant: g.id,
    item: g.item,
    action: g.action,
    task: g.task_id ?? "-",
    choice: g.choice,
    answer: sanitizeBlock(g.answer),
    words: g.words ? sanitizeBlock(g.words) : "-",
    question: sanitizeBlock(g.question),
    binds: g.binds ?? "-",
    session: g.session_id,
    tool_use: g.tool_use_id,
    created: new Date(g.created_at).toISOString(),
    expires: new Date(g.expires_at).toISOString(),
    verified: g.verified_at ? new Date(g.verified_at).toISOString() : "-",
    state: g.consumed_at !== null ? `used by ${g.consumed_by ?? "?"}` : g.voided_at !== null ? `voided: ${g.void_reason ?? "?"}` : g.expires_at <= now ? "expired" : "live",
  };
}

// --- the commands' side -----------------------------------------------------------------------

/**
 * `flowryn grant use <id>` passes its grant to the command it runs under this argument. It is not
 * a flag: the daemon refuses any argument a verb does not declare, so no CLI call can carry it.
 */
export const GRANT_ARG = "__grant";

/** The Claude leader session behind a call, or null for any other caller. */
export function claudeLeaderSession(ctx: Pick<HandlerCtx, "db" | "caller">): string | null {
  if (ctx.caller.role !== "leader" || !ctx.caller.session) return null;
  return getSession(ctx.db, ctx.caller.session)?.harness === "claude" ? ctx.caller.session : null;
}

/**
 * A command's prepare step: the chat-answer grant it would use, checked against Claude's
 * transcript, or null (another caller, no grant, or a confirmed prompt for the same command,
 * which wins). A grant for another choice of the same item refuses the command.
 */
export function prepareCaptainGrant(ctx: HandlerCtx, args: Args, ask: { item: string; choice: string; head?: string | null }, attempt: { action: ApprovalAction; task: string } | null): string | null {
  const named = stringArg(args, GRANT_ARG) ?? null;
  const session = claudeLeaderSession(ctx);
  if (!session) {
    if (named) throw new FlowrynError("role_refused", "only the Claude leader session that asked uses a chat-answer grant");
    return null;
  }
  if (!named && attempt && findAttempt(ctx.db, { session, action: attempt.action, task: attempt.task, now: ctx.now() })) return null;
  return prepareGrant(ctx, { session, item: ask.item, choice: ask.choice, grantId: named, ...(ask.head !== undefined ? { head: ask.head } : {}) }, grantsConfig(ctx.config()).claude_projects_dir);
}

/** Who answered, for an approval row or an event: you, through a chat answer the leader asked. */
export function grantActor(g: GrantRow): string {
  return `${process.env.USER || process.env.LOGNAME || "you"} (chat answer ${g.id}, leader ${g.session_id})`;
}
