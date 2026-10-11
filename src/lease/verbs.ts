import { FlowrynError } from "../api/errors.ts";
import { intArg, stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { appendEvent } from "../db/events.ts";
import { grantsConfig } from "../config/leader.ts";
import { readIdentity } from "../runtime/proc.ts";
import { applyRepin, planRepin, processCwd, type RepinPlan } from "./repin.ts";
import { attachProcess, claim, closeSession, getLease, getSession, openSession, openSessions, type LeaderHarness } from "./lease.ts";

/**
 * The lease verbs (design section 10). `lead.*` are internal: `flowryn lead`
 * opens a session from your terminal before it launches the harness, tells
 * the daemon the harness process once it runs, and closes the session when
 * it exits. `leader status` and `leader claim` are the verbs you and the
 * leader use.
 */

function age(now: number, since: number | null): string {
  if (since === null) return "-";
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function sessionOfCaller(ctx: HandlerCtx): string {
  const session = ctx.caller.session;
  if (!session) throw new FlowrynError("role_refused", "only a leader session can do this");
  return session;
}

const leadOpen: VerbSpec = {
  name: "lead.open",
  summary: "Register a leader session before `flowryn lead` launches its harness; returns the session's token",
  positionals: [],
  flags: {
    harness: { type: "string", help: "claude or pi" },
    pane: { type: "string", help: "the Herdr pane the leader runs in (HERDR_PANE_ID)" },
    cwd: { type: "string", help: "the leader's working directory" },
  },
  kind: "mutation",
  roles: ["human"],
  // The reply carries the session token, so it is never stored for idempotency (tokens live only as hashes).
  ephemeral: true,
  apply(ctx, args) {
    const harness = stringArg(args, "harness");
    if (harness !== "claude" && harness !== "pi") throw new FlowrynError("bad_args", "--harness must be claude or pi");
    const opened = openSession(ctx.db, { harness: harness as LeaderHarness, pane: stringArg(args, "pane") ?? null, cwd: stringArg(args, "cwd") ?? null, now: ctx.now() });
    return { data: { session: opened.session, token: opened.token } };
  },
};

const leadAttach: VerbSpec = {
  name: "lead.attach",
  summary: "Record the leader harness process, so a dead holder's lease can be proven stale",
  positionals: [],
  flags: { pid: { type: "int", help: "the harness process id" } },
  kind: "mutation",
  roles: ["hook"],
  ephemeral: true,
  async prepare(_ctx, args) {
    const pid = intArg(args, "pid");
    if (pid === undefined || pid <= 1) throw new FlowrynError("bad_args", "--pid must be a process id");
    const identity = await readIdentity(pid);
    if (!identity) throw new FlowrynError("not_found", `no process ${pid}`);
    return identity;
  },
  apply(ctx, _args, prepared) {
    const session = sessionOfCaller(ctx);
    attachProcess(ctx.db, session, prepared as { pid: number; start: number; exe: string }, ctx.now());
    return { data: { session } };
  },
};

const leadClose: VerbSpec = {
  name: "lead.close",
  summary: "The leader harness exited: close the session and release the lease it held",
  positionals: [],
  flags: { reason: { type: "string", help: "why, one word" } },
  kind: "mutation",
  roles: ["hook"],
  ephemeral: true,
  apply(ctx, args) {
    const session = sessionOfCaller(ctx);
    const closed = closeSession(ctx.db, session, stringArg(args, "reason") ?? "harness exited", ctx.now());
    return { data: { session, released: closed.released } };
  },
  async settle(ctx, result) {
    ctx.attention.bus.forget(String(result.data.session));
    return result;
  },
};

const leaderStatus: VerbSpec = {
  name: "leader status",
  summary: "Which session leads: the lease, its epoch and heartbeat, and every open leader session",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx) {
    const lease = getLease(ctx.db);
    const holder = lease.session_id ? getSession(ctx.db, lease.session_id) : null;
    const sessions = openSessions(ctx.db).map((s) => ({
      session: s.session_id,
      harness: s.harness,
      pane: s.pane_id ?? "-",
      lease: s.session_id === lease.session_id ? "holder" : "read-only",
      busy: s.busy === 1 && s.busy_until !== null && s.busy_until > ctx.now ? "yes" : "no",
      you: s.user_inactive_since === null ? "active" : "inactive",
      seen: age(ctx.now, s.last_event_at),
    }));
    return {
      data: {
        lease: lease.session_id
          ? { session: lease.session_id, harness: holder?.harness ?? lease.harness ?? "-", pane: holder?.pane_id ?? "-", epoch: lease.epoch, heartbeat: age(ctx.now, lease.heartbeat_at) }
          : { session: "vacant", epoch: lease.epoch },
        you: ctx.caller.session ?? ctx.caller.role,
        sessions,
      },
      hints: ctx.caller.role === "reader" ? ["flowryn leader claim"] : [],
    };
  },
};

/**
 * `flowryn leader claim`: move the lease to this session (run by a leader
 * session), or to `--session <id>` from your own terminal. Epoch + 1; the old
 * holder's waiter exits and its next hook shows one banner line.
 */
const leaderClaim: VerbSpec = {
  name: "leader claim",
  summary: "Take the leader lease for this session, or for --session <id> from your terminal",
  positionals: [],
  flags: { session: { type: "string", help: "your terminal only: the leader session to hand the lease to", placeholder: "L<n>" } },
  kind: "mutation",
  roles: ["leader", "reader", "human"],
  apply(ctx, args) {
    const named = stringArg(args, "session");
    if (ctx.caller.session && named && named !== ctx.caller.session) throw new FlowrynError("bad_args", "a leader session claims for itself; --session is for your own terminal");
    const target = ctx.caller.session ?? named;
    if (!target) throw new FlowrynError("bad_args", "name the session: flowryn leader claim --session <id>", "flowryn leader status");
    const session = getSession(ctx.db, target);
    if (!session || session.ended_at !== null) throw new FlowrynError("not_found", `no open leader session ${target}`, "flowryn leader status");
    const lease = getLease(ctx.db);
    const now = ctx.now();
    if (lease.session_id === target) return { data: { session: target, epoch: lease.epoch, already: true } };
    const claimed = claim(ctx.db, target, `claim by ${ctx.caller.role}`, now);
    appendEvent(ctx.db, { source: "cli", kind: "leader.claim_requested", payload: { session: target, by: ctx.caller.role, epoch: claimed.epoch } });
    return { data: { session: target, epoch: claimed.epoch, previous: claimed.previous ?? "-" }, hints: ["flowryn brief"] };
  },
  async settle(ctx, result) {
    if (typeof result.data.previous === "string" && result.data.previous !== "-") ctx.attention.bus.forget(result.data.previous);
    ctx.attention.bus.notify(String(result.data.session));
    return result;
  },
};

// --- leader repin (behind `flowryn leader repin`) ---------------------------------------------

interface RepinPrepared {
  plan: RepinPlan;
  processCwd: string | null;
  challenge: { id: string; code: string };
}

/**
 * Start a repin from your terminal: what it would change, and the code to type back. Only the
 * token-less caller on your own terminal (`human`) reaches it; `flowryn leader repin` reads the
 * code from /dev/tty.
 */
const leaderRepinBegin: VerbSpec = {
  name: "leader.repin.begin",
  summary: "Start a /dev/tty repin: the leader's pinned and new directory, and the code to type back",
  positionals: [],
  flags: { dir: { type: "string", help: "the directory to pin (absolute); default: the one the transcript names" } },
  kind: "mutation",
  roles: ["human"],
  // The reply carries the challenge code: never kept in the reply table.
  ephemeral: true,
  async prepare(ctx, args): Promise<RepinPrepared> {
    const now = ctx.now();
    const plan = planRepin(ctx.db, { dir: stringArg(args, "dir") ?? null, projectsDir: grantsConfig(ctx.config()).claude_projects_dir, now });
    const s = getSession(ctx.db, plan.session)!;
    const identity = s.proc_pid !== null && s.proc_start !== null && s.proc_exe !== null ? { pid: s.proc_pid, start: s.proc_start, exe: s.proc_exe } : null;
    const cwd = await processCwd(identity, ctx.attention.ps);
    const challenge = ctx.delivery.challenges.create(
      { task: plan.session, action: "repin", ref: plan.newCwd, head: plan.transcript, allowRed: null, channel: "cli-tty", repin: { oldCwd: plan.oldCwd, newCwd: plan.newCwd, transcript: plan.transcript } },
      now,
    );
    return { plan, processCwd: cwd, challenge: { id: challenge.id, code: challenge.code } };
  },
  apply(_ctx, _args, prepared) {
    const { plan, processCwd: cwd, challenge } = prepared as RepinPrepared;
    return {
      data: {
        challenge: challenge.id,
        code: challenge.code,
        session: plan.session,
        pane: plan.pane ?? "-",
        transcript: plan.transcript,
        claude_session: plan.claudeSession,
        process_cwd: cwd ?? "unknown",
        old_cwd: plan.oldCwd ?? "-",
        new_cwd: plan.newCwd,
        from: plan.from,
        live_grants: plan.liveGrants,
      },
    };
  },
};

const leaderRepinConfirm: VerbSpec = {
  name: "leader.repin.confirm",
  summary: "Finish a /dev/tty repin: the code you typed back",
  positionals: [],
  flags: {
    challenge: { type: "string", help: "the challenge id" },
    code: { type: "string", help: "the code you typed" },
    actor: { type: "string", help: "who you are ($USER)" },
  },
  kind: "mutation",
  roles: ["human"],
  apply(ctx, args) {
    const taken = ctx.delivery.challenges.take(stringArg(args, "challenge") ?? "", stringArg(args, "code") ?? "", ctx.now());
    if (taken === "unknown") throw new FlowrynError("challenge_failed", "no such repin challenge (a daemon restart forgets them)", "run flowryn leader repin again");
    if (taken === "expired") throw new FlowrynError("challenge_failed", "the repin challenge expired", "run flowryn leader repin again");
    if (taken === "wrong") throw new FlowrynError("challenge_failed", "the code does not match; nothing was repinned", "run flowryn leader repin again");
    if (taken.action !== "repin" || !taken.repin) throw new FlowrynError("challenge_failed", "that challenge is not a repin; nothing was repinned", "run flowryn leader repin again");
    const actor = (stringArg(args, "actor") ?? "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64) || "you";
    const { voided } = applyRepin(ctx.db, { session: taken.task, ...taken.repin, actor, now: ctx.now() });
    return {
      data: { session: taken.task, old_cwd: taken.repin.oldCwd ?? "-", new_cwd: taken.repin.newCwd, grants_voided: voided },
      hints: [`flowryn show ${taken.task}`],
    };
  },
};

export const LEASE_VERBS: VerbSpec[] = [leadOpen, leadAttach, leadClose, leaderStatus, leaderClaim, leaderRepinBegin, leaderRepinConfirm];
