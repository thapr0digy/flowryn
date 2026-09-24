import { PROJECT_VERBS } from "../lifecycle/projects.ts";
import { TODO_VERBS } from "../lifecycle/todos.ts";
import { WORKER_VERBS } from "../lifecycle/worker.ts";
import { HOOK_VERBS } from "../lifecycle/hooks.ts";
import { dispatchVerb } from "../lifecycle/dispatch.ts";
import { LEADER_RUN_VERBS } from "../lifecycle/leader-verbs.ts";
import { CONTRACT_VERBS } from "../contracts/verbs.ts";
import { systemVerbs } from "../daemon/system-verbs.ts";
import { LEASE_VERBS } from "../lease/verbs.ts";
import { ATTENTION_VERBS } from "../attention/verbs.ts";
import type { VerbSpec } from "./verbs.ts";

/** Every verb the daemon serves over the socket. The CLI adds its local verbs on top. */
export const SERVER_VERBS: readonly VerbSpec[] = [
  dispatchVerb,
  ...LEADER_RUN_VERBS,
  ...WORKER_VERBS,
  ...TODO_VERBS,
  ...PROJECT_VERBS,
  ...HOOK_VERBS,
  ...CONTRACT_VERBS,
  ...LEASE_VERBS,
  ...ATTENTION_VERBS,
  ...systemVerbs(),
];

const byName = new Map(SERVER_VERBS.map((v) => [v.name, v]));

export function serverVerb(name: string): VerbSpec | undefined {
  return byName.get(name);
}
