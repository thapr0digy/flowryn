import { appendEvent } from "../db/events.ts";
import { pendingIntents } from "../journal/journal.ts";
import { boolArg, intArg, type VerbSpec } from "../api/verbs.ts";
import { FlowrynError } from "../api/errors.ts";
import { effectiveConfig, redactConfig } from "../config/effective.ts";
import { DEFAULT_WAIT_MIN, MAX_WAIT_MIN, handoffPending, lastDropped, readPending, type Preflight } from "./restart.ts";

/**
 * Socket verbs the CLI uses under the hood. `daemon.ping` is the handshake:
 * every role, even an anonymous caller, may ask who is listening.
 */
export const PING_VERB = "daemon.ping";
export const STOP_VERB = "daemon.stop";
export const RESTART_VERB = "daemon.restart";
/** The configuration the running daemon accepted, for `flowryn config`. */
export const CONFIG_VERB = "daemon.config";

/**
 * Verbs the gateway serves whatever protocol the caller speaks: after a build
 * that bumps PROTO, the new CLI must still be able to ask the old daemon to
 * restart and recognize the new one. Their arguments are frozen (a unit test
 * pins them); every other verb refuses a protocol mismatch.
 */
export const PROTO_EXEMPT_VERBS: ReadonlySet<string> = new Set([PING_VERB, RESTART_VERB]);

interface RestartPrepared {
  preflight: Preflight | null;
}

export function systemVerbs(): VerbSpec[] {
  return [
    {
      name: PING_VERB,
      summary: "Handshake: protocol, version and journal state of the running daemon",
      positionals: [],
      flags: {},
      kind: "read",
      roles: ["leader", "reader", "worker", "hook", "human", "anonymous"],
      read(ctx) {
        const pending = pendingIntents(ctx.db).length;
        const failed = (ctx.db.query("SELECT COUNT(*) AS n FROM intents WHERE state = 'failed'").get() as { n: number }).n;
        const info = ctx.info;
        return {
          data: {
            daemon: "up",
            pid: info?.pid ?? null,
            version: info?.version ?? null,
            proto: info?.proto ?? null,
            instance: info?.instance ?? null,
            uptime_s: info ? Math.round((ctx.now - info.startedAt) / 1000) : null,
            state_dir: info?.stateDir ?? null,
            pending_intents: pending,
            failed_intents: failed,
            build: info?.build ?? null,
            restart_pending: readPending(ctx.db),
            restart_handoff: handoffPending(ctx.db),
            restart_dropped: lastDropped(ctx.db),
          },
        };
      },
    },
    {
      name: CONFIG_VERB,
      summary: "The configuration the running daemon accepted: every section resolved, secrets redacted",
      positionals: [],
      flags: {},
      kind: "read",
      roles: ["leader", "reader", "worker", "human"],
      read(ctx) {
        // The read-only fallback has only the file on disk, which is not what a running daemon accepted.
        if (!ctx.info) throw new FlowrynError("daemon_unavailable", "the daemon is not running, so it has no accepted configuration", "flowryn daemon status");
        const snapshot = effectiveConfig(ctx.config);
        const status = ctx.configStatus;
        return {
          data: {
            loaded_at: status ? new Date(status.loaded_at).toISOString() : null,
            reload: status?.reload ? { at: new Date(status.reload.at).toISOString(), outcome: status.reload.outcome, error: status.reload.error } : null,
            problems: snapshot.problems,
            sections: redactConfig(snapshot.sections),
          },
        };
      },
    },
    {
      name: STOP_VERB,
      summary: "Stop the daemon cleanly (exit 0, so launchd leaves it stopped)",
      positionals: [],
      flags: {},
      kind: "mutation",
      roles: ["human"],
      apply(ctx) {
        appendEvent(ctx.db, { source: "daemon", kind: "daemon.stop_requested", payload: { via: "cli" } });
        return { data: { stopping: true, pid: ctx.info().pid } };
      },
      async settle(ctx, result) {
        ctx.requestShutdown("flowryn daemon stop");
        return result;
      },
    },
    {
      name: RESTART_VERB,
      summary: "Restart the daemon through its supervisor, onto the installed build, once nothing would break",
      positionals: [],
      flags: {
        "when-idle": { type: "boolean", help: "wait for the guards to clear instead of refusing" },
        "wait-min": { type: "int", help: `with --when-idle: give up after this many minutes (default ${DEFAULT_WAIT_MIN}, at most ${MAX_WAIT_MIN})` },
        cancel: { type: "boolean", help: "drop a pending --when-idle restart" },
        force: { type: "boolean", help: "restart even when the installed build is the one running" },
      },
      kind: "mutation",
      roles: ["leader", "human"],
      // Never replayed from the idempotency table or the spool: a stored "restarting" reply must not kick a later daemon.
      ephemeral: true,
      // The binary check runs the target's version (and codesign) with a 10 s limit each.
      replyMs: 30_000,
      async prepare(ctx, args): Promise<RestartPrepared> {
        const waitMin = intArg(args, "wait-min");
        if (waitMin !== undefined && (waitMin < 1 || waitMin > MAX_WAIT_MIN)) throw new FlowrynError("bad_args", `--wait-min must be 1 to ${MAX_WAIT_MIN}`);
        if (boolArg(args, "cancel")) return { preflight: null };
        // Guards first, so a refusal (or a parked --when-idle) is fast; the binary check runs once they are clear.
        // A validation is judged on a fresh no-mistakes read: one only waiting on external CI does not block.
        await ctx.restart.refreshValidations();
        if (ctx.restart.guards().length > 0) return { preflight: null };
        return { preflight: await ctx.restart.preflight(boolArg(args, "force")) };
      },
      apply(ctx, args, prepared) {
        const outcome = ctx.restart.request(ctx.caller, {
          cancel: boolArg(args, "cancel"),
          whenIdle: boolArg(args, "when-idle"),
          waitMin: intArg(args, "wait-min"),
          force: boolArg(args, "force"),
          preflight: (prepared as RestartPrepared).preflight,
        });
        return { data: { ...outcome }, hints: outcome.restart === "pending" ? ["flowryn daemon status", "flowryn daemon restart --cancel"] : [] };
      },
      async settle(ctx, result) {
        if (result.data.restart === "restarting") ctx.restart.kick();
        return result;
      },
    },
  ];
}
