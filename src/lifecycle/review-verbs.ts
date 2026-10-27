import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { addReviewMessage, replyGate, REVIEW_REPLY_MAX } from "./review-chat.ts";
import { getRunWithPolicy, isTerminal } from "./runs.ts";

/**
 * `flowryn review reply --body-file -` (workers only): answer what the user
 * wrote on your review page. The reply is kept in the review's conversation and
 * shown in the page by the daemon (`lavish-axi reply`), the page's one owner;
 * a reply Lavish refuses rides on the daemon's next poll instead.
 */
const reviewReply: VerbSpec = {
  name: "review reply",
  summary: "Answer the user on your open review page; the reply shows in the page's conversation",
  positionals: [],
  flags: {
    "body-file": { type: "string", help: "the reply, from a file or - for stdin (Markdown: paragraphs, lists, headings)", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  // Showing the reply waits for Lavish to accept it (lavish-axi reply's own 10 s, bounded at 15 s).
  replyMs: 20_000,
  apply(ctx, args) {
    const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
    if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
    if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the reply goes in --body-file -");
    if (body.length > REVIEW_REPLY_MAX) throw new FlowrynError("bad_args", `the reply is ${body.length} characters; keep it to ${REVIEW_REPLY_MAX}`, "say the rest by revising the page");
    const gate = replyGate(ctx.db, run.id);
    if (!gate) throw new FlowrynError("review_closed", "you have no open review page to reply on (the review closed, or the user ended its session)", "carry on with the steer you were given; anything for the user goes to your leader: $FLOWRYN_BIN report finding --body-file -");
    const seq = addReviewMessage(ctx.db, gate, "worker", body, ctx.now());
    return { data: { gate: gate.id, seq, chars: body.length } };
  },
  async settle(ctx, result) {
    const gateId = String(result.data.gate);
    const seq = Number(result.data.seq);
    // A replayed call (spool, retry) shows its reply once.
    const shown = ctx.db.query("SELECT 1 FROM events WHERE kind = 'review.reply_shown' AND json_extract(payload, '$.gate') = ?1 AND json_extract(payload, '$.seq') = ?2").get(gateId, seq);
    if (shown) return { ...result, data: { ...result.data, shown: "already" } };
    const row = ctx.db.query("SELECT m.body, g.page_path, g.run_id FROM review_messages m JOIN gates g ON g.id = m.gate_id WHERE m.gate_id = ?1 AND m.seq = ?2").get(gateId, seq) as {
      body: string;
      page_path: string | null;
      run_id: string;
    } | null;
    if (!row?.page_path) return result;
    const outcome = await ctx.lavish.reply(gateId, row.page_path, row.body);
    tx(ctx.db, () => appendEvent(ctx.db, { source: "daemon", kind: "review.reply_shown", runId: row.run_id, payload: { gate: gateId, seq, outcome }, ts: ctx.now() }));
    const hints = outcome === "shown" ? [] : outcome === "queued" ? ["Lavish refused it just now; Flowryn's next poll of the page carries it"] : ["lavish-axi is not installed, so the page cannot show it; your leader sees it in the review's summary"];
    return { ...result, data: { ...result.data, shown: outcome }, ...(hints.length > 0 ? { hints } : {}) };
  },
};

export const REVIEW_VERBS: VerbSpec[] = [reviewReply];
