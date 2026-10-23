import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/config.ts";
import { flowrynHome, socketPath, stateFiles } from "../../config/paths.ts";
import { errorReply, okReply, type Reply } from "../../api/envelope.ts";
import { EXIT } from "../../api/errors.ts";
import type { CliIo, VerbSpec } from "../../api/verbs.ts";
import { boolArg, intArg } from "../../api/verbs.ts";
import { runDaemon } from "../../daemon/daemon.ts";
import { PING_VERB, RESTART_VERB, STOP_VERB, systemVerbs } from "../../daemon/system-verbs.ts";
import type { DaemonSnapshot } from "../../daemon/restart.ts";
import { callServerVerb } from "../client.ts";
import { LAUNCHD_DEPS, agentPid, installService, isLoaded, kickstart, loadAgent, plistPath, plistSpecFor, renderPlist, serviceLabel, selfCommand, uninstallService } from "../../service/launchd.ts";
import { RELAUNCH_ANSWER_MS, RELAUNCH_BOOTSTRAP_BACKOFF_MS, RELAUNCH_BOUND_MS, RELAUNCH_POLL_MS, RELAUNCH_UNLOAD_TIMEOUT_MS, relaunch } from "../../service/relaunch.ts";
import { RECOVERY_COMMAND, type RestartFailure, failureLine, readRestartFailure, writeRestartFailure } from "../../service/restart-failure.ts";
import { fileLogger } from "../../daemon/logger.ts";
import { notifyConfig, notificationsOff, recordingNotifierPath } from "../../config/leader.ts";
import { osascriptNotify, recordingNotify } from "../../attention/notify.ts";
import { request } from "../../transport/unix.ts";
import { ensureDir } from "../../util/fsx.ts";
import { isLockHeld } from "../../util/flock.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";
import { notHumanReason } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";

const START_WAIT_MS = 8_000;
/** How long `daemon restart` waits for the new daemon to answer: as long as its relaunch helper keeps trying. */
const RESTART_WAIT_MS = RELAUNCH_BOUND_MS;
const STOP_WAIT_MS = 15_000;

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

/** Ping the daemon: the handshake reply, or null when nothing answers. */
export async function ping(env: NodeJS.ProcessEnv): Promise<Reply | null> {
  const sock = socketPath(flowrynHome(env), env);
  try {
    return (await request(sock, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 3_000 })) as Reply;
  } catch {
    return null;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
}

function refuseAgent(io: CliIo, verb: string): number | null {
  const reason = notHumanReason({ env: io.env, stdinIsTty: true, stdoutIsTty: true });
  if (!reason) return null;
  return print(io, errorReply({ code: "human_only", message: `${verb} runs only in your own terminal: ${reason}` }));
}

const run: VerbSpec = {
  name: "daemon run",
  summary: "Run flowrynd in the foreground (what launchd runs)",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(_args, io) {
    const refused = refuseAgent(io, "daemon run");
    if (refused !== null) return refused;
    return runDaemon({ env: io.env, logToStderr: io.env.FLOWRYN_LOG_STDERR === "1" || io.stdoutIsTty });
  },
};

const status: VerbSpec = {
  name: "daemon status",
  summary: "Is flowrynd running? Protocol, version and journal state",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["leader", "reader", "worker", "human", "anonymous"],
  async local(_args, io) {
    const reply = await ping(io.env);
    if (reply && reply.ok) return print(io, okReply(reply.data, []));
    if (reply && !reply.ok) return print(io, reply);
    const home = flowrynHome(io.env);
    const { config } = loadConfig(home);
    const label = serviceLabel(home);
    const lock = stateFiles(config.state_dir).lock;
    const data = {
      daemon: "down",
      socket: socketPath(home, io.env),
      lock: existsSync(lock) && isLockHeld(lock) ? "held (a daemon is starting or wedged)" : "free",
      launchd: existsSync(plistPath(label)) ? ((await isLoaded(label)) ? "loaded" : "installed, not loaded") : "not installed",
    };
    const failure = readRestartFailure(config.state_dir);
    if (failure) {
      io.stdout(renderReply(okReply({ ...data, last_restart: failureLine(failure) }, [failure.run]), { json: io.json }));
      return EXIT.unavailable;
    }
    io.stdout(renderReply(okReply(data, ["flowryn daemon start"]), { json: io.json }));
    return EXIT.unavailable;
  },
};

const start: VerbSpec = {
  name: "daemon start",
  summary: "Start flowrynd: through launchd when installed, else in the background",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(_args, io) {
    const refused = refuseAgent(io, "daemon start");
    if (refused !== null) return refused;
    const existing = await ping(io.env);
    if (existing?.ok) return print(io, okReply({ daemon: "already running", ...(existing.data as object) }));
    const home = flowrynHome(io.env);
    const { config } = loadConfig(home);
    const label = serviceLabel(home);
    let how: string;
    if (process.platform === "darwin" && existsSync(plistPath(label)) && (await isLoaded(label))) {
      await kickstart(label);
      how = "launchd";
      // A kickstart launchd will not act on (the 2026-10-23 "spawn scheduled", exit 78): load the agent afresh, as install does.
      // A daemon launchd runs but that does not answer yet is still starting: wait for it rather than boot it out.
      if (!(await waitFor(async () => (await ping(io.env))?.ok === true, START_WAIT_MS)) && (await agentPid(label)) === null) {
        try {
          await loadAgent(label, plistPath(label));
        } catch (error) {
          return print(io, errorReply({ code: "daemon_unavailable", message: `the kickstart did not start flowrynd, and loading the agent again failed: ${(error as Error).message}`, help: `see ${stateFiles(config.state_dir).logs}, then run ${RECOVERY_COMMAND}` }));
        }
        how = "launchd (re-bootstrapped after the kickstart did not start it)";
      }
    } else {
      const logs = stateFiles(config.state_dir).logs;
      ensureDir(config.state_dir, 0o700);
      ensureDir(logs, 0o700);
      const out = openSync(join(logs, "daemon-start.log"), "a", 0o600);
      const [bin, ...rest] = selfCommand();
      const child = spawn(bin!, [...rest, "daemon", "run"], { detached: true, stdio: ["ignore", out, out], env: io.env });
      child.unref();
      how = "background process";
    }
    const up = await waitFor(async () => (await ping(io.env))?.ok === true, START_WAIT_MS);
    if (!up) return print(io, errorReply({ code: "daemon_unavailable", message: `flowrynd did not answer within ${START_WAIT_MS / 1000} s`, help: `see ${stateFiles(config.state_dir).logs}` }));
    const reply = await ping(io.env);
    return print(io, okReply({ started: how, ...(reply?.data as object | undefined) }, ["flowryn daemon status"]));
  },
};

const stop: VerbSpec = {
  name: "daemon stop",
  summary: "Stop flowrynd cleanly; launchd leaves a clean exit stopped",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(_args, io) {
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason) return print(io, errorReply({ code: "human_only", message: `daemon stop runs only in your own terminal: ${reason}` }));
    const sock = socketPath(flowrynHome(io.env), io.env);
    let reply: Reply;
    try {
      reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb: STOP_VERB, channel: "tty", args: {} }, { connectMs: 300, replyMs: 5_000 })) as Reply;
    } catch {
      return print(io, okReply({ daemon: "not running" }));
    }
    if (!reply.ok) return print(io, reply);
    const gone = await waitFor(async () => (await ping(io.env)) === null, STOP_WAIT_MS);
    return print(io, gone ? okReply({ daemon: "stopped" }) : errorReply({ code: "internal", message: "flowrynd acknowledged the stop but is still answering" }));
  },
};

function uptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function describe(d: { pid: number; version: string; proto: number; build: string | null; uptime_s?: number | null }): string {
  const parts = [`pid ${d.pid}`, d.version, `proto ${d.proto}`, `build ${d.build ?? "dev"}`];
  if (typeof d.uptime_s === "number") parts.push(`up ${uptime(d.uptime_s)}`);
  return parts.join(" · ");
}

export type RestartWait = { outcome: "fresh"; reply: Reply } | { outcome: "dropped"; reason: string } | { outcome: "failed"; failure: RestartFailure } | { outcome: "timeout" };

/**
 * Wait for what a restart asked at `started` comes to: a daemon with another
 * pid answers, the old daemon withdraws its handoff (its supervisor refused),
 * or the relaunch helper leaves a failure record newer than the request.
 */
export async function waitForRestart(
  oldPid: number,
  started: number,
  deps: { ping(): Promise<Reply | null>; readFailure(): RestartFailure | null; timeoutMs: number; pollMs: number },
): Promise<RestartWait> {
  const deadline = started + deps.timeoutMs;
  for (;;) {
    const reply = await deps.ping();
    if (reply?.ok) {
      const data = reply.data as { pid?: number; restart_handoff?: boolean; restart_dropped?: { reason: string; ts: number } | null };
      if (data.pid !== oldPid) return { outcome: "fresh", reply };
      if (data.restart_handoff === false) return { outcome: "dropped", reason: data.restart_dropped && data.restart_dropped.ts >= started - 1_000 ? data.restart_dropped.reason : "the old daemon withdrew it" };
    }
    const failure = deps.readFailure();
    if (failure && failure.at >= started) return { outcome: "failed", failure };
    if (Date.now() >= deadline) return { outcome: "timeout" };
    await Bun.sleep(deps.pollMs);
  }
}

/**
 * The leader may restart the daemon, unlike stop and start: every rule is the
 * daemon's (src/daemon/restart.ts), which checks the caller's role from its
 * token, refuses while a restart would break something, checks the new
 * binary, and has launchd restart it. This side only waits for the new
 * daemon and reports it. A worker is refused here before it reaches the daemon.
 */
const restart: VerbSpec = {
  name: "daemon restart",
  summary: "Restart flowrynd onto the installed build (leader or you); refused while a restart would break something",
  positionals: [],
  flags: {
    "when-idle": { type: "boolean", help: "wait for what blocks it to clear, instead of refusing (returns at once)" },
    "wait-min": { type: "int", help: "with --when-idle: give up after this many minutes (default 30, at most 240)" },
    cancel: { type: "boolean", help: "drop a pending --when-idle restart" },
    force: { type: "boolean", help: "restart even when the installed build is the one running" },
  },
  kind: "local",
  roles: ["leader", "human"],
  async local(args, io) {
    if ((io.env.FLOWRYN_RUN ?? "").length > 0) {
      return print(io, errorReply({ code: "worker_token", message: "a worker cannot restart the daemon", help: "report, ask or fail instead; the leader decides" }));
    }
    const spec = systemVerbs().find((v) => v.name === RESTART_VERB)!;
    const asked = await callServerVerb(spec, args, io);
    if (!asked.ok) return print(io, errorReply(asked.error ?? { code: "internal", message: "the restart failed" }));
    if (asked.data.restart !== "restarting") {
      const hints = asked.data.restart === "pending" ? ["flowryn daemon status", "flowryn daemon restart --cancel"] : [];
      return print(io, okReply(asked.data, hints));
    }
    const old = asked.data.old as DaemonSnapshot;
    const started = Date.now();
    const { config } = loadConfig(flowrynHome(io.env));
    const waited = await waitForRestart(old.pid, started, { ping: () => ping(io.env), readFailure: () => readRestartFailure(config.state_dir), timeoutMs: RESTART_WAIT_MS, pollMs: 100 });
    if (waited.outcome === "dropped") {
      return print(io, errorReply({ code: "restart_dropped", message: `the restart was dropped and the old daemon (pid ${old.pid}) still runs: ${waited.reason}`, help: "flowryn daemon status; tell the user" }));
    }
    if (waited.outcome === "failed") {
      return print(io, errorReply({ code: "daemon_unavailable", message: failureLine(waited.failure), help: `tell the user to run ${waited.failure.run} in their terminal` }));
    }
    if (waited.outcome === "timeout") {
      return print(
        io,
        errorReply({
          code: "daemon_unavailable",
          message: `the old daemon (pid ${old.pid}) was asked to restart, but no new daemon answered within ${RESTART_WAIT_MS / 1000} s and its relaunch helper left no failure record`,
          help: `flowryn daemon status shows the outcome; if it stays down, run ${RECOVERY_COMMAND} (logs: ${stateFiles(config.state_dir).logs})`,
        }),
      );
    }
    const next = waited.reply.data as { pid: number; version: string; proto: number; build: string | null; uptime_s: number | null };
    return print(
      io,
      okReply(
        {
          restarted: String(asked.data.supervisor),
          old: describe(old),
          new: describe(next),
          waited: `${((Date.now() - started) / 1000).toFixed(1)} s`,
          // Validations run in no-mistakes and go on across a restart: say which it carried.
          ...(Array.isArray(asked.data.carried) && asked.data.carried.length > 0 ? { carried: asked.data.carried } : {}),
        },
        ["flowryn daemon status", "flowryn fleet"],
      ),
    );
  },
};

/**
 * What a launchd restart runs (src/service/relaunch.ts): the old daemon spawns
 * it detached with its own pid, and it re-bootstraps this home's agent and
 * waits for a new daemon. Exit 0 once one answers; on failure it leaves the
 * failure record and a notification. Nothing else needs to run it.
 */
const relaunchVerb: VerbSpec = {
  name: "daemon relaunch",
  summary: "Re-bootstrap the launchd agent and wait for the new daemon (what a restart runs)",
  positionals: [],
  flags: { "old-pid": { type: "int", help: "the daemon being replaced", placeholder: "pid" } },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const refused = refuseAgent(io, "daemon relaunch");
    if (refused !== null) return refused;
    const oldPid = intArg(args, "old-pid");
    if (oldPid === undefined || oldPid <= 0) return print(io, errorReply({ code: "bad_args", message: "daemon relaunch needs --old-pid" }));
    if (process.platform !== "darwin") return print(io, errorReply({ code: "not_supported", message: "daemon relaunch is launchd only (macOS)" }));
    const home = flowrynHome(io.env);
    const { config } = loadConfig(home);
    const label = serviceLabel(home);
    const recorder = recordingNotifierPath(io.env);
    const notify = recorder ? recordingNotify(recorder) : notificationsOff(io.env) || !notifyConfig(config).macos ? async () => {} : osascriptNotify;
    const outcome = await relaunch(
      { label, plist: plistPath(label), oldPid },
      {
        launchd: { ...LAUNCHD_DEPS, unloadTimeoutMs: RELAUNCH_UNLOAD_TIMEOUT_MS, bootstrapBackoffMs: RELAUNCH_BOOTSTRAP_BACKOFF_MS },
        probe: async () => {
          const reply = await ping(io.env);
          const pid = reply?.ok ? (reply.data as { pid?: unknown }).pid : null;
          return typeof pid === "number" ? pid : null;
        },
        now: Date.now,
        log: fileLogger(stateFiles(config.state_dir).logs, false),
        notify,
        recordFailure: (failure) => writeRestartFailure(config.state_dir, failure),
        answerWaitMs: RELAUNCH_ANSWER_MS,
        pollMs: RELAUNCH_POLL_MS,
      },
    );
    if (outcome.ok) return EXIT.ok;
    // Only the old daemon, still alive, reads this: it takes its handoff back with the reason. After the bootout nobody does.
    if (outcome.oldStillUp) io.stderr(`${outcome.reason}\n`);
    return EXIT.unavailable;
  },
};

const install: VerbSpec = {
  name: "daemon install",
  summary: "Install the launchd agent (KeepAlive) and start it",
  positionals: [],
  flags: { print: { type: "boolean", help: "print the plist instead of installing it" } },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const refused = refuseAgent(io, "daemon install");
    if (refused !== null) return refused;
    const home = flowrynHome(io.env);
    const { config } = loadConfig(home);
    const spec = plistSpecFor(config, home, io.env);
    const path = plistPath(spec.label);
    if (boolArg(args, "print")) {
      io.stdout(renderPlist(spec));
      return EXIT.ok;
    }
    await installService(spec, path);
    const up = await waitFor(async () => (await ping(io.env))?.ok === true, START_WAIT_MS);
    return print(io, okReply({ installed: path, label: spec.label, daemon: up ? "running" : "not answering yet" }, ["flowryn daemon status", "flowryn doctor"]));
  },
};

const uninstall: VerbSpec = {
  name: "daemon uninstall",
  summary: "Stop and remove the launchd agent",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(_args, io) {
    const refused = refuseAgent(io, "daemon uninstall");
    if (refused !== null) return refused;
    const home = flowrynHome(io.env);
    const label = serviceLabel(home);
    const path = plistPath(label);
    const wasLoaded = await uninstallService(label, path);
    return print(io, okReply({ removed: path, was_loaded: wasLoaded ? "yes" : "no" }));
  },
};

export const DAEMON_VERBS: VerbSpec[] = [run, start, stop, restart, relaunchVerb, status, install, uninstall];
