import { PROJECT_VERBS } from "../lifecycle/projects.ts";
import { TODO_VERBS } from "../lifecycle/todos.ts";
import { WORKER_VERBS } from "../lifecycle/worker.ts";
import { HOOK_VERBS } from "../lifecycle/hooks.ts";
import { dispatchVerb, planVerb } from "../lifecycle/dispatch.ts";
import { STAGE_VERBS } from "../lifecycle/stages.ts";
import { GATE_VERBS } from "../policy/gates.ts";
import { SCHED_VERBS } from "../sched/verbs.ts";
import { LEADER_RUN_VERBS } from "../lifecycle/leader-verbs.ts";
import { DECISION_VERBS } from "../lifecycle/decision-verbs.ts";
import { DIVERGENCE_VERBS } from "../lifecycle/divergences.ts";
import { PROMOTE_VERBS } from "../lifecycle/promote.ts";
import { CONTRACT_VERBS } from "../contracts/verbs.ts";
import { systemVerbs } from "../daemon/system-verbs.ts";
import { LEASE_VERBS } from "../lease/verbs.ts";
import { ATTENTION_VERBS } from "../attention/verbs.ts";
import { POLICY_VERBS } from "../policy/verbs.ts";
import { VERIFY_VERBS } from "../verify/verbs.ts";
import type { VerbSpec } from "./verbs.ts";

/** Every verb the daemon serves over the socket. The CLI adds its local verbs on top. */
export const SERVER_VERBS: readonly VerbSpec[] = [
  dispatchVerb,
  planVerb,
  ...STAGE_VERBS,
  ...GATE_VERBS,
  ...SCHED_VERBS,
  ...LEADER_RUN_VERBS,
  ...DECISION_VERBS,
  ...DIVERGENCE_VERBS,
  ...PROMOTE_VERBS,
  ...WORKER_VERBS,
  ...TODO_VERBS,
  ...PROJECT_VERBS,
  ...HOOK_VERBS,
  ...CONTRACT_VERBS,
  ...LEASE_VERBS,
  ...ATTENTION_VERBS,
  ...POLICY_VERBS,
  ...VERIFY_VERBS,
  ...systemVerbs(),
];

const byName = new Map(SERVER_VERBS.map((v) => [v.name, v]));

export function serverVerb(name: string): VerbSpec | undefined {
  return byName.get(name);
}
