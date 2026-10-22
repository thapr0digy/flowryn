import { errorReply, okReply, type Reply } from "../../api/envelope.ts";
import { EXIT } from "../../api/errors.ts";
import { serverVerb } from "../../api/registry.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { callServerVerb } from "../client.ts";
import { renderReply } from "../render.ts";

/**
 * `flowryn verify <task|pr>` (leader and human): test a PR head, or a
 * local-only task's worktree head, in a clean worktree with the project's
 * configured steps. The daemon runs the job
 * (outside every sandbox); this command starts it and then follows it, one
 * line per step as it ends. Ctrl-C stops following, never the job, which
 * still records its result. --detach returns at once with the id.
 */

const POLL_MS = 1_000;
/** How long following tolerates a daemon that does not answer (a restart) before it gives up. */
const UNREACHABLE_MS = 30_000;

interface StepView {
  step: string;
  state: string;
  ms: number | string;
  exit: number | string;
  tests: string;
  detail: string;
  attempts?: number | string;
}

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return reply.ok ? EXIT.ok : EXIT.policy;
}

function seconds(ms: number | string): string {
  if (typeof ms !== "number") return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

const MARKS: Record<string, string> = { passed: "✓", failed: "✗", stopped: "·" };

/** A step that ended: its mark, time and counts, and why (a failure, or a hang it recovered from). */
function stepLine(s: StepView): string {
  const mark = MARKS[s.state] ?? "?";
  const why = s.detail !== "-" ? s.detail : s.state === "failed" ? `exit ${s.exit}` : "";
  const extra = [s.tests !== "-" ? s.tests : "", why].filter(Boolean).join("  ");
  return `  ${mark} ${s.step}  ${seconds(s.ms)}${extra ? `  ${extra}` : ""}\n`;
}

function finalReply(data: Record<string, unknown>): Reply {
  if (data.state === "passed") return okReply(data, data.task !== "-" ? [`flowryn merge ${String(data.task)}`] : []);
  return errorReply({ code: "verify_failed", message: `${String(data.verification)} ${String(data.state)}: ${String(data.detail)}`, help: `flowryn verify show ${String(data.verification)}; logs in ${String(data.logs)}` });
}

const verify: VerbSpec = {
  name: "verify",
  summary: "Test a PR or local-only head in a clean worktree with the project's verify steps; a pass at the exact head is what the merge gate requires",
  positionals: [{ name: "target", required: true, help: "task, PR number or PR URL" }],
  flags: {
    project: { type: "string", help: "the project a PR number belongs to (default: the only project with a GitHub remote)", placeholder: "id" },
    detach: { type: "boolean", help: "start it and return the id; follow with flowryn verify show <id>" },
  },
  kind: "local",
  roles: ["leader", "human"],
  async local(args, io) {
    const started = await callServerVerb(serverVerb("verify.start")!, { target: stringArg(args, "target"), project: stringArg(args, "project"), path: io.env.PATH }, io);
    if (!started.ok) {
      io.stdout(renderReply(errorReply(started.error ?? { code: "internal", message: "verify did not start" }), { json: io.json }));
      return started.exitCode;
    }
    const id = String(started.data.verification);
    if (boolArg(args, "detach")) return print(io, okReply(started.data, [`flowryn verify show ${id}`]));
    if (!io.json) io.stdout(`${id} · ${String(started.data.project)} ${String(started.data.pr)} at ${String(started.data.head).slice(0, 8)}${started.data.attached ? " (already running; following it)" : ""}\n`);
    const shown = new Set<number>();
    // Several steps run at once in a parallel group; a retried step is announced again.
    const announced = new Map<number, number | string | undefined>();
    let lastAnswer = Date.now();
    for (;;) {
      const reply = await callServerVerb(serverVerb("verify show")!, { id }, io);
      if (!reply.ok) {
        if (reply.error?.code !== "daemon_unavailable" || Date.now() - lastAnswer > UNREACHABLE_MS) {
          io.stdout(renderReply(errorReply(reply.error ?? { code: "internal", message: "cannot read the verification" }), { json: io.json }));
          return reply.exitCode;
        }
      } else {
        lastAnswer = Date.now();
        const data = reply.data;
        const steps = (data.steps as StepView[]) ?? [];
        if (!io.json) {
          steps.forEach((s, i) => {
            if (s.state in MARKS && !shown.has(i)) {
              shown.add(i);
              io.stdout(stepLine(s));
            } else if (s.state === "running" && (!announced.has(i) || announced.get(i) !== s.attempts)) {
              const retry = announced.has(i);
              announced.set(i, s.attempts);
              io.stdout(`  … ${s.step}${retry ? " (hung; retrying)" : ""}\n`);
            }
          });
        }
        if (data.state !== "running") {
          if (!io.json) {
            if (data.tail !== "-") io.stdout(`--- the last lines of its output ---\n${String(data.tail)}\n---\n`);
            io.stdout(data.state === "passed" ? `passed in ${seconds(Number(data.duration_ms))}${data.binary !== "-" ? ` · binary ${String(data.binary)}` : ""}\n` : "");
          }
          const final = finalReply(data);
          if (io.json || !final.ok) return print(io, final);
          return EXIT.ok;
        }
      }
      await Bun.sleep(POLL_MS);
    }
  },
};

export const VERIFY_CLI_VERBS: readonly VerbSpec[] = [verify];
