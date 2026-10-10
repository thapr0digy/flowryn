import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { DECISION_VERBS } from "../lifecycle/decision-verbs.ts";
import { DIVERGENCE_VERBS } from "../lifecycle/divergences.ts";
import { chatForm, parseRef } from "./chat-questions.ts";
import { GATE_VERBS } from "./gates.ts";
import { claudeLeaderSession, getGrant, GRANT_ARG, type GrantRow } from "./grants.ts";
import { POLICY_VERBS } from "./verbs.ts";

/**
 * The leader's side of chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md):
 * `chat-question` prints the one form a binding AskUserQuestion question may take, and
 * `grant use` runs exactly the action your answer granted, through that action's own command.
 * Neither can make a grant: only the Claude leader's hooks do.
 */

const chatQuestion: VerbSpec = {
  name: "chat-question",
  summary: "The AskUserQuestion question that lets the user's chat answer authorise an item (q<N>, k<N>, g<N>, d<N>, merge:<task>)",
  positionals: [{ name: "item", required: true, help: "a decision, review gate, divergence, or merge:<task>" }],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const form = chatForm(ctx.db, parseRef(stringArg(args, "item")!));
    return {
      data: { item: form.ref, action: form.action, question: JSON.stringify(form.question) },
      hints: ["pass question unchanged as the one element of AskUserQuestion's questions (up to 4 such questions per call); then flowryn grant use <grant>"],
    };
  },
};

/** The commands a grant can run (a function: the lists are read after every module has loaded). */
const TARGETS = (): VerbSpec[] => [...DECISION_VERBS, ...GATE_VERBS, ...DIVERGENCE_VERBS, ...POLICY_VERBS];

function verb(list: VerbSpec[], name: string): VerbSpec {
  const found = list.find((v) => v.name === name);
  if (!found) throw new Error(`no verb ${name}`);
  return found;
}

/** The command a grant runs, and its arguments; the grant travels under GRANT_ARG. */
function targetOf(g: GrantRow, body: string | undefined): { spec: VerbSpec; args: Args } {
  const withBody = body !== undefined ? { body } : {};
  switch (g.action) {
    case "decide":
      return { spec: verb(DECISION_VERBS, "decide"), args: { decision: g.item, choice: g.choice, by: "captain", ...withBody, [GRANT_ARG]: g.id } };
    case "gate":
      return g.choice === "pass"
        ? { spec: verb(GATE_VERBS, "gate pass"), args: { task: g.task_id!, "gate-id": g.item, [GRANT_ARG]: g.id } }
        : { spec: verb(GATE_VERBS, "gate changes"), args: { task: g.task_id!, ...withBody, [GRANT_ARG]: g.id } };
    case "divergence":
      return { spec: verb(DIVERGENCE_VERBS, "divergence resolve"), args: { id: g.item, resolution: g.choice, [GRANT_ARG]: g.id } };
    case "merge":
      return { spec: verb(POLICY_VERBS, "merge"), args: { task: g.task_id!, [GRANT_ARG]: g.id } };
  }
}

interface UsePrepared {
  grant: string;
  spec: string;
  args: Args;
  prepared: unknown;
}

function targetFor(ctx: HandlerCtx, args: Args): { g: GrantRow; spec: VerbSpec; args: Args } {
  const id = stringArg(args, "grant")!;
  const session = claudeLeaderSession(ctx);
  if (!session) throw new FlowrynError("role_refused", "only the Claude leader session that asked uses a chat-answer grant");
  const g = getGrant(ctx.db, id);
  if (!g) throw new FlowrynError("not_found", `no grant ${id}`, "flowryn show <item> lists its grants");
  return { g, ...targetOf(g, stringArg(args, "body")) };
}

const grantUse: VerbSpec = {
  name: "grant use",
  summary: "Run the one action the user's chat answer granted (decide, gate pass or changes, divergence resolve, merge)",
  positionals: [{ name: "grant", required: true, help: "the grant id, such as c7" }],
  flags: { "body-file": { type: "string", help: "your relay of the user's words (gate changes needs some)", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader"],
  replyMs: 120_000,
  async prepare(ctx, args): Promise<UsePrepared> {
    const { g, spec, args: target } = targetFor(ctx, args);
    const prepared = spec.prepare ? await spec.prepare(ctx, target) : undefined;
    return { grant: g.id, spec: spec.name, args: target, prepared };
  },
  apply(ctx, _args, prepared) {
    const p = prepared as UsePrepared;
    const spec = TARGETS().find((v) => v.name === p.spec)!;
    const result = spec.apply!(ctx, p.args, p.prepared);
    // The command used the grant (each takes it in its own transaction step); say which ran.
    return { data: { ...result.data, grant: p.grant, ran: p.spec }, hints: result.hints ?? [] };
  },
  async settle(ctx, result): Promise<HandlerResult> {
    const spec = TARGETS().find((v) => v.name === result.data.ran);
    return spec?.settle ? spec.settle(ctx, result) : result;
  },
};

export const GRANT_VERBS: VerbSpec[] = [chatQuestion, grantUse];
