import { FlowrynError } from "../api/errors.ts";
import type { VerbSpec } from "../api/verbs.ts";
import { appendEvent } from "../db/events.ts";
import { getRunWithPolicy, isTerminal } from "../lifecycle/runs.ts";

/** Recovery waits for a probe, `lavish-axi stop`, a second probe and every open page hosted again (each host bounded at 30 s). */
const RECOVER_REPLY_MS = 150_000;

/**
 * `flowryn lavish recover` (workers only): a worker's lavish-axi call failed with
 * `code: SERVER_ERROR`. The daemon checks the shared Lavish server with its own probe
 * page and, when that fails too, restarts it and hosts every open review page again
 * (src/lavish/recovery.ts), then answers. It takes no arguments: it acts only on
 * Flowryn's own probe page and the review pages it records, never a path a worker names.
 */
const lavishRecover: VerbSpec = {
  name: "lavish recover",
  summary: "Your lavish-axi call failed with code: SERVER_ERROR: check the Lavish server, restart it when broken, then run your call again",
  positionals: [],
  flags: {},
  kind: "mutation",
  roles: ["worker"],
  scope: { kind: "self" },
  replyMs: RECOVER_REPLY_MS,
  apply(ctx) {
    const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
    if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
    if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
    appendEvent(ctx.db, { source: "cli", kind: "lavish.recover_asked", runId: run.id, taskId: run.task_id, payload: {}, ts: ctx.now() });
    return { data: { run: run.id } };
  },
  async settle(ctx, result) {
    const outcome = await ctx.lavish.recover(`worker:${String(result.data.run)}`);
    const data = { ...result.data, state: outcome.state, ...(outcome.item ? { item: outcome.item } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.pages !== undefined ? { pages: outcome.pages } : {}) };
    const hint =
      outcome.state === "ok"
        ? "the Lavish server answers: run your lavish-axi command again"
        : outcome.state === "restarted"
          ? "Flowryn restarted the Lavish server: run your lavish-axi command again"
          : outcome.state === "gave_up"
            ? `Flowryn gave up restarting Lavish (item ${outcome.item}): report blocked naming that item; never run lavish-axi stop yourself`
            : "lavish-axi is not installed for the daemon: report blocked with your lavish-axi output";
    return { ...result, data, hints: [hint] };
  },
};

export const LAVISH_VERBS: VerbSpec[] = [lavishRecover];
