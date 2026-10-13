import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { effectiveConfig, redactConfig, REDACTED, redactUrlSecrets, TOKEN_LIKE } from "../config/effective.ts";
import { findRun } from "./runs.ts";
import { runWorkflow } from "./stages.ts";

/**
 * The diagnostic export's data (docs/notes/2026-10-13-next-steps-md-wq.md):
 * one run's row, stages, gates, decisions, wait explanations and events,
 * and the effective configuration, redacted. A plain read, so the read-only
 * fallback serves it with the daemon down; `flowryn diag export` (the CLI's
 * local verb) writes the file in the caller's own process, never here.
 */

export const DIAG_FORMAT = "flowryn-diag/1";
const MAX_EVENTS = 2_000;
/** Shortest decision or gate text matched inside other strings: shorter ones would hide ordinary words. */
const MIN_QUOTED_CHARS = 8;

/** Event payload keys that hold free text: a worker's words, a question, an answer, a comment. */
const TEXT_KEYS = new Set([
  "body",
  "summary",
  "text",
  "question",
  "answer",
  "choice",
  "options",
  "context",
  "recommend",
  "recommendation",
  "rationale",
  "note",
  "blocks",
  "feedback",
  "comment",
  "line",
  "full_line",
  "words",
  "prompt",
  "title",
  "screen",
]);
const DECISION_TEXT = ["question", "options", "answer", "context", "recommendation", "rationale", "note", "blocks"] as const;
const GATE_TEXT = ["feedback", "comment", "decided"] as const;

const TOKEN_ANYWHERE = new RegExp(TOKEN_LIKE.source, "g");

function hidden(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `<redacted: ${text.length} chars>`;
}

/**
 * Every string: URL credentials and token-looking runs replaced. Applied to
 * the whole export, whatever --include-text says, so tool and stderr text
 * kept as-is (a failure reason, a channel error, a cleanup detail) still
 * never carries a credential.
 */
function scrubTokens(value: unknown): unknown {
  if (typeof value === "string") return redactUrlSecrets(value).replace(TOKEN_ANYWHERE, REDACTED);
  if (Array.isArray(value)) return value.map(scrubTokens);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubTokens(v)]));
  return value;
}

/** Hide the named free-text columns of a row (null stays null, so an empty field stays visibly empty). */
function hideColumns(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out = { ...row };
  for (const column of columns) if (out[column] !== null && out[column] !== undefined) out[column] = hidden(out[column]);
  return out;
}

/** An event payload with free-text keys hidden, and any string quoting one of the run's decision or gate texts. */
function hidePayload(value: unknown, quoted: readonly string[], key = ""): unknown {
  if (TEXT_KEYS.has(key) && value !== null && value !== undefined) return hidden(value);
  if (typeof value === "string") return quoted.some((q) => value.includes(q)) ? hidden(value) : value;
  if (Array.isArray(value)) return value.map((v) => hidePayload(v, quoted));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hidePayload(v, quoted, k)]));
  return value;
}

/** Fact names whose value quotes the worker's screen (the dialog's prompt line). */
const SCREEN_FACTS = new Set(["prompt"]);

/** An explanation with its screen-quoting facts hidden, its signature (which repeats every fact value) hidden, and any string quoting a decision or gate text. */
function hideExplanation(x: Record<string, unknown>, quoted: readonly string[]): Record<string, unknown> {
  const facts = Array.isArray(x.facts)
    ? x.facts.map((f: Record<string, unknown>) => (SCREEN_FACTS.has(String(f?.name)) ? { ...f, value: hidden(f.value) } : f))
    : x.facts;
  return hidePayload({ ...x, facts, signature: hidden(x.signature) }, quoted) as Record<string, unknown>;
}

/**
 * The cancel reasons Flowryn itself writes (`flowryn cancel` without
 * --reason, src/lifecycle/leader-verbs.ts; an accepted backlog edit,
 * src/lifecycle/divergences.ts). Any other reason is the caller's own words.
 */
const GENERATED_CANCEL_REASON = /^(by [a-z]+|your backlog edit won \(divergence [\w-]+\))$/;

/** An event's payload, redacted: free-text keys, quoted decision and gate texts, and a cancel reason someone typed. */
function hideEvent(kind: string, payload: unknown, quoted: readonly string[]): unknown {
  const hiddenPayload = hidePayload(payload, quoted);
  if (kind !== "run.cancelled" || !payload || typeof payload !== "object") return hiddenPayload;
  const reason = (payload as Record<string, unknown>).reason;
  if (typeof reason !== "string" || GENERATED_CANCEL_REASON.test(reason)) return hiddenPayload;
  return { ...(hiddenPayload as Record<string, unknown>), reason: hidden(reason) };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function diagExport(ctx: ReadCtx, target: string, includeText: boolean): Record<string, unknown> {
  const run = findRun(ctx.db, target);
  if (!run) throw new FlowrynError("not_found", `no run or task ${target}`, "flowryn fleet");
  const runRow = { ...(ctx.db.query("SELECT * FROM runs WHERE id = ?1").get(run.id) as Record<string, unknown>) };
  delete runRow.token_hash;
  delete runRow.workflow_def;
  const kind = (ctx.db.query("SELECT kind FROM task_policy WHERE task_id = ?1").get(run.task_id) as { kind: "ship" | "scout" } | null)?.kind;
  const workflow = runWorkflow(ctx.db, run, kind);
  const leases = ctx.db.query("SELECT pool, stage, granted_at, released_at FROM pool_leases WHERE run_id = ?1 ORDER BY granted_at").all(run.id);
  const gates = ctx.db.query("SELECT * FROM gates WHERE run_id = ?1 ORDER BY opened_at").all(run.id) as Record<string, unknown>[];
  const decisions = ctx.db.query("SELECT * FROM decisions WHERE run_id = ?1 ORDER BY created_at, id").all(run.id) as Record<string, unknown>[];
  const explanations = (ctx.db.query("SELECT * FROM explanations WHERE run_id = ?1 ORDER BY id").all(run.id) as Record<string, unknown>[]).map((x) => ({
    ...x,
    facts: parsed(String(x.facts)),
    unblock: parsed(String(x.unblock)),
  }));
  const total = (ctx.db.query("SELECT COUNT(*) AS n FROM events WHERE run_id = ?1").get(run.id) as { n: number }).n;
  const rawEvents = (ctx.db.query("SELECT seq, ts, source, kind, payload FROM events WHERE run_id = ?1 ORDER BY seq DESC LIMIT ?2").all(run.id, MAX_EVENTS) as {
    seq: number;
    ts: number;
    source: string;
    kind: string;
    payload: string;
  }[]).toReversed();
  // What a redacted export must not quote anywhere: the run's decision and gate texts.
  const quoted = includeText
    ? []
    : [...decisions.flatMap((d) => DECISION_TEXT.map((c) => d[c])), ...gates.flatMap((g) => GATE_TEXT.map((c) => g[c]))].filter(
        (t): t is string => typeof t === "string" && t.length >= MIN_QUOTED_CHARS,
      );
  const events = rawEvents.map((e) => ({ ...e, payload: includeText ? parsed(e.payload) : hideEvent(e.kind, parsed(e.payload), quoted) }));
  const info = ctx.info;
  const out = {
    format: DIAG_FORMAT,
    exported_at: new Date(ctx.now).toISOString(),
    flowryn: info ? { version: info.version, build: info.build ?? null, commit: info.commit ?? null } : "read-only fallback (daemon down)",
    text: includeText ? "included" : "redacted",
    task: run.task_id,
    run: includeText ? runRow : hideColumns(runRow, ["stage_note"]),
    stages: {
      workflow: workflow.id,
      stages: workflow.stages.map((s) => ({ id: s.id, gate: s.gate, skill: s.skill, pools: s.pools, fresh: s.fresh })),
      current: run.stage,
      state: runRow.stage_state ?? null,
      leases,
    },
    gates: includeText ? gates : gates.map((g) => hideColumns(g, GATE_TEXT)),
    decisions: includeText ? decisions : decisions.map((d) => hideColumns(d, DECISION_TEXT)),
    explanations: includeText ? explanations : explanations.map((x) => hideExplanation(x, quoted)),
    events,
    ...(total > rawEvents.length ? { events_truncated: `${total - rawEvents.length} older events left out` } : {}),
    config: redactConfig(effectiveConfig(ctx.config).sections),
  };
  return scrubTokens(out) as Record<string, unknown>;
}

/**
 * `diag.export` (internal: `flowryn diag export` calls it and writes the
 * file). Leader and human only: a worker or a read-only reader gets no dump.
 */
const diagExportVerb: VerbSpec = {
  name: "diag.export",
  summary: "One run's diagnostic record, redacted (flowryn diag export writes it to a file)",
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: { "include-text": { type: "boolean", help: "include decision, gate and event text" } },
  kind: "read",
  roles: ["leader", "human"],
  read(ctx, args) {
    return { data: diagExport(ctx, stringArg(args, "target")!, boolArg(args, "include-text")) };
  },
};

export const DIAG_VERBS: VerbSpec[] = [diagExportVerb];
