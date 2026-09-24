import { appendEvent } from "../db/events.ts";
import { pendingIntents } from "../journal/journal.ts";
import type { VerbSpec } from "../api/verbs.ts";

/**
 * Socket verbs the CLI uses under the hood. `daemon.ping` is the handshake:
 * every role, even an anonymous caller, may ask who is listening.
 */
export const PING_VERB = "daemon.ping";
export const STOP_VERB = "daemon.stop";

export function systemVerbs(): VerbSpec[] {
  return [
    {
      name: PING_VERB,
      summary: "Handshake: protocol, version and journal state of the running daemon",
      positionals: [],
      flags: {},
      kind: "read",
      roles: ["leader", "worker", "hook", "human", "anonymous"],
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
  ];
}
