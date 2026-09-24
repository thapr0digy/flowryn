import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";

const STATUS = /^[a-z][a-z-]{0,23}$/;
const MAX_REPORT_CHARS = 4_000;

/**
 * `flowryn report <status>`: a worker's own account of a change a supervisor
 * would act on. Rank-4 evidence (design section 6), so M1 records it as an
 * event and nothing more; the reconciler and lanes that act on it are M2/M3.
 * It is the first spooling verb: with the daemon down it lands in the spool
 * and is ingested exactly once at the next start.
 */
const report: VerbSpec = {
  name: "report",
  summary: "Report a change your supervisor would act on (workers only)",
  positionals: [{ name: "status", required: true, help: "one word, such as blocked or progress" }],
  flags: {
    "body-file": { type: "string", help: "details, read from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  apply(ctx, args) {
    const status = stringArg(args, "status")!;
    if (!STATUS.test(status)) throw new FlowrynError("bad_args", "status must be one lowercase word, such as blocked or progress");
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim().slice(0, MAX_REPORT_CHARS);
    const event = appendEvent(ctx.db, {
      source: "cli",
      kind: "worker.report",
      runId: ctx.caller.runId,
      taskId: ctx.caller.taskId,
      payload: { status, summary: sanitizeLine(body), body, via: ctx.via },
    });
    return { data: { run: ctx.caller.runId, status, event: event.seq } };
  },
};

export const WORKER_VERBS: VerbSpec[] = [report];
