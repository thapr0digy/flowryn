import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type Args, type Caller, type HandlerResult, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { learningsConfig } from "../config/leader.ts";
import type { Db } from "../db/db.ts";
import { localDate, parseDueArg } from "../lifecycle/dates.ts";
import { getLesson, learn, LESSON_MAX_CHARS, lessonId, parseLessonId, unlearn, visibleLessons, type LearningRow } from "./learnings.ts";
import { defaultScope, lensFor, projectScopeById, requireInScope } from "./scope.ts";

/**
 * `flowryn learn`, `flowryn learnings` and `flowryn unlearn`
 * (docs/notes/2026-10-29-leader-learnings-file-j6.md). Workers cannot call
 * them: a lesson is the leader's or yours.
 */

/** A lesson by its id, refused as not found when it does not exist. */
function lessonArg(db: Db, ref: string): LearningRow {
  const id = parseLessonId(ref);
  const row = id === null ? null : getLesson(db, id);
  if (!row) throw new FlowrynError("not_found", `no lesson ${ref}`, "list them with: flowryn learnings");
  return row;
}

function untilArg(value: string | undefined, now: number): string | null {
  if (value === undefined) return null;
  const date = parseDueArg(value, new Date(now));
  if (!date) throw new FlowrynError("bad_args", `cannot read the date "${value}"`, "use YYYY-MM-DD, today, tomorrow or +Nd");
  if (date < localDate(new Date(now))) throw new FlowrynError("bad_args", `--until ${date} has already passed`);
  return date;
}

/** Where a new lesson belongs: its project's scope, else the caller's (your terminal's: the default scope). */
function lessonScope(db: Db, config: FlowrynConfig, caller: Caller, project: string | null, replaces: LearningRow | null): string {
  if (project !== null) {
    if (!db.query("SELECT 1 FROM projects WHERE id = ?1").get(project)) throw new FlowrynError("not_found", `no project ${project}`, "list them with: flowryn project list");
    const scope = projectScopeById(db, config, project);
    if (scope === null) throw new FlowrynError("config_invalid", `project ${project} has no scope: its scope rules are broken`, "fix [scopes] in config, then learn it again");
    return scope;
  }
  if (replaces) return replaces.scope;
  if ((caller.role === "leader" || caller.role === "reader") && caller.scope) return caller.scope;
  return defaultScope(config);
}

const learnVerb: VerbSpec = {
  name: "learn",
  summary: "Record a one-line fact about the projects for later leader sessions",
  positionals: [{ name: "lesson", required: false, help: `one line, at most ${LESSON_MAX_CHARS} characters (or --body-file -)` }],
  flags: {
    project: { type: "string", help: "the project it is about", placeholder: "id" },
    until: { type: "string", help: "set it aside after this day: YYYY-MM-DD, tomorrow or +Nd", placeholder: "date" },
    replaces: { type: "string", help: "a lesson this one corrects, set aside as replaced", placeholder: "l<N>" },
    "body-file": { type: "string", help: "the lesson, read from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "replaces", optional: true, project: "project" },
  apply(ctx, args) {
    const positional = stringArg(args, "lesson");
    const body = stringArg(args, "body");
    if (positional !== undefined && body !== undefined) throw new FlowrynError("bad_args", "give the lesson once: as an argument or with --body-file, not both");
    const text = positional ?? body;
    if (text === undefined) throw new FlowrynError("bad_args", "missing the lesson", 'flowryn learn "<one-line fact>" or flowryn learn --body-file -');
    const now = ctx.now();
    const config = ctx.config();
    const replacesRef = stringArg(args, "replaces");
    const replaces = replacesRef === undefined ? null : lessonArg(ctx.db, replacesRef);
    if (replaces && replaces.archived_at !== null) throw new FlowrynError("bad_args", `${replacesRef} is already set aside (${replaces.archive_reason})`, "learn the new fact without --replaces");
    const project = stringArg(args, "project") ?? replaces?.project ?? null;
    const scope = lessonScope(ctx.db, config, ctx.caller, stringArg(args, "project") ?? null, replaces);
    if (replaces && replaces.scope !== scope) throw new FlowrynError("bad_args", `${replacesRef} is in scope ${replaces.scope}, not ${scope}`, "a lesson replaces one of its own scope");
    requireInScope(config, ctx.caller, scope, `scope ${scope}`);
    const result = learn(ctx.db, { scope, project, text, until: untilArg(stringArg(args, "until"), now), replaces, max: learningsConfig(config).max, now, source: "cli" });
    const data: Record<string, unknown> = { lesson: lessonId(result.lesson.id), action: result.action, scope, project: result.lesson.project ?? "-" };
    if (replaces) data.replaced = lessonId(replaces.id);
    if (result.setAside.length > 0) data.set_aside = result.setAside.map((r) => ({ lesson: lessonId(r.id), text: r.text }));
    const hints = result.setAside.length > 0 ? ["the cap set these aside: learn one again if it still matters", "flowryn learnings --archived"] : ["flowryn learnings"];
    return { data, hints };
  },
};

const unlearnVerb: VerbSpec = {
  name: "unlearn",
  summary: "Set a lesson aside (it stays listed with learnings --archived)",
  positionals: [{ name: "id", required: true, help: "lesson id, l<N>" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "id" },
  apply(ctx, args) {
    const row = lessonArg(ctx.db, stringArg(args, "id")!);
    const changed = unlearn(ctx.db, row, ctx.now(), "cli");
    return { data: { lesson: lessonId(row.id), set_aside: true, already: !changed }, hints: ["flowryn learnings"] };
  },
};

function listLearnings(ctx: ReadCtx, args: Args): HandlerResult {
  const archived = boolArg(args, "archived");
  const lens = lensFor(ctx.db, ctx.config, ctx.caller.scope);
  const rows = visibleLessons(ctx.db, lens, { archived, project: stringArg(args, "project"), now: ctx.now });
  const max = learningsConfig(ctx.config).max;
  const lessons = rows.map((r) => {
    const view: Record<string, unknown> = { id: lessonId(r.id), project: r.project ?? "-", confirmed: localDate(new Date(r.reinforced_at)), until: r.until ?? "-", text: r.text };
    if (!lens.restricted) view.scope = r.scope;
    if (archived) view.reason = r.replaced_by !== null ? `${r.archive_reason} by ${lessonId(r.replaced_by)}` : r.archive_reason;
    return view;
  });
  const data: Record<string, unknown> = { lessons, summary: archived ? `${rows.length} set aside` : `${rows.length} active · cap ${max} per scope` };
  const hints = rows.length === 0 ? ['flowryn learn "<one-line fact>" --project <id>'] : archived ? ["learn one again to bring it back"] : ["flowryn unlearn <id>", 'flowryn learn "<fact>" --replaces <id>'];
  return { data, hints };
}

const learningsVerb: VerbSpec = {
  name: "learnings",
  summary: "List the leader's lessons: active ones newest-confirmed first",
  positionals: [],
  flags: {
    archived: { type: "boolean", help: "the set-aside ones instead, and why" },
    project: { type: "string", help: "only this project's", placeholder: "id" },
  },
  kind: "read",
  roles: ["leader", "reader", "human"],
  scope: { kind: "list" },
  read: listLearnings,
};

export const LEARNING_VERBS: VerbSpec[] = [learnVerb, learningsVerb, unlearnVerb];
