import { PROJECT_VERBS } from "../lifecycle/projects.ts";
import { TODO_VERBS } from "../lifecycle/todos.ts";
import { WORKER_VERBS } from "../lifecycle/worker.ts";
import { systemVerbs } from "../daemon/system-verbs.ts";
import type { VerbSpec } from "./verbs.ts";

/** Every verb the daemon serves over the socket. The CLI adds its local verbs on top. */
export const SERVER_VERBS: readonly VerbSpec[] = [...TODO_VERBS, ...PROJECT_VERBS, ...WORKER_VERBS, ...systemVerbs()];

const byName = new Map(SERVER_VERBS.map((v) => [v.name, v]));

export function serverVerb(name: string): VerbSpec | undefined {
  return byName.get(name);
}
