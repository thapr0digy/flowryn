import type { BacklogTask } from "./tasks-axi.ts";
import type { AppliedPayload, IntentArgs } from "./journal.ts";

export type TaskField = "title" | "state" | "kind" | "repo" | "priority" | "body" | "deps" | "hold" | "links";
const DIFF_FIELDS: readonly TaskField[] = ["title", "state", "kind", "repo", "priority", "body", "deps", "hold", "links"];

/**
 * tasks-axi appends link URLs to the title it reads back after `done --pr`
 * (M0 finding 7). Strip them so that is not mistaken for a hand edit.
 */
export function normalizedTitle(task: BacklogTask): string {
  let title = task.title;
  for (const link of task.links) {
    const url = link.slice(link.indexOf(":") + 1);
    if (url.length > 0) title = title.split(` ${url}`).join("").split(url).join("");
  }
  return title.trim();
}

function fieldValue(task: BacklogTask, field: TaskField): string {
  switch (field) {
    case "title":
      return normalizedTitle(task);
    case "deps":
    case "links":
      return task[field].toSorted().join(",");
    case "hold":
      return task.hold ? JSON.stringify([task.hold.kind, task.hold.reason, task.hold.until]) : "";
    default:
      return String(task[field] ?? "");
  }
}

export interface TaskChange {
  id: string;
  fields: TaskField[];
}

export interface BacklogDiff {
  added: string[];
  removed: string[];
  changed: TaskChange[];
}

export function diffTasks(before: BacklogTask[], after: BacklogTask[]): BacklogDiff {
  const beforeById = new Map(before.map((t) => [t.id, t]));
  const afterById = new Map(after.map((t) => [t.id, t]));
  const added = after.filter((t) => !beforeById.has(t.id)).map((t) => t.id);
  const removed = before.filter((t) => !afterById.has(t.id)).map((t) => t.id);
  const changed: TaskChange[] = [];
  for (const task of after) {
    const old = beforeById.get(task.id);
    if (!old) continue;
    const fields = DIFF_FIELDS.filter((f) => fieldValue(old, f) !== fieldValue(task, f));
    if (fields.length > 0) changed.push({ id: task.id, fields });
  }
  return { added, removed, changed };
}

export function isEmptyDiff(diff: BacklogDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** The fields an intent sets, which decide whether a later read shows it or shows it erased. */
export function fieldsSetBy(verb: AppliedPayload["verb"], args: IntentArgs): TaskField[] {
  switch (verb) {
    case "start":
    case "done":
    case "reopen":
      return ["state"];
    case "hold":
    case "unhold":
      return ["hold"];
    case "update": {
      const fields: TaskField[] = [];
      if ("title" in args.flags) fields.push("title");
      if ("body" in args.flags || "body-file" in args.flags) fields.push("body");
      if ("priority" in args.flags) fields.push("priority");
      if ("repo" in args.flags) fields.push("repo");
      if ("kind" in args.flags) fields.push("kind");
      if ("pr" in args.flags || "report" in args.flags) fields.push("links");
      return fields;
    }
    case "block":
    case "unblock":
      return ["deps"];
    case "add":
    case "rm":
      return [];
  }
}

/**
 * Was this applied intent erased by a later write? True when the task now
 * reads exactly as it did before the intent on every field the intent set,
 * and the intent actually changed something. A value that differs from both is
 * your edit, and your edit wins.
 */
export function intentErased(applied: AppliedPayload, current: BacklogTask | undefined): boolean {
  if (applied.verb === "add") return current === undefined;
  // A task back after its rm is your edit, like a just-added task you delete: it stays.
  if (applied.verb === "rm") return false;
  if (!current || !applied.pre || !applied.post) return false;
  const fields = fieldsSetBy(applied.verb, applied.args);
  if (fields.length === 0) return false;
  const changedSomething = fields.some((f) => fieldValue(applied.pre!, f) !== fieldValue(applied.post!, f));
  if (!changedSomething) return false;
  return fields.every((f) => fieldValue(current, f) === fieldValue(applied.pre!, f));
}
