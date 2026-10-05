import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/config.ts";
import { flowrynHome, socketPath, stateFiles } from "../../config/paths.ts";
import { errorReply, okReply, type Reply } from "../../api/envelope.ts";
import { EXIT } from "../../api/errors.ts";
import type { CliIo, VerbSpec } from "../../api/verbs.ts";
import { boolArg } from "../../api/verbs.ts";
import { runDaemon } from "../../daemon/daemon.ts";
import { PING_VERB, RESTART_VERB, STOP_VERB, systemVerbs } from "../../daemon/system-verbs.ts";
import type { DaemonSnapshot } from "../../daemon/restart.ts";
import { callServerVerb } from "../client.ts";
import { installService, isLoaded, kickstart, plistPath, plistSpecFor, renderPlist, serviceLabel, selfCommand, uninstallService } from "../../service/launchd.ts";
import { request } from "../../transport/unix.ts";
import { ensureDir } from "../../util/fsx.ts";
import { isLockHeld } from "../../util/flock.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";
import { notHumanReason } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";

const START_WAIT_MS = 8_000;
/** How long `daemon restart` waits for the new daemon to answer. */
const RESTART_WAIT_MS = 30_000;
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
    let fresh: Reply | null = null;
    let dropped: { reason: string } | null = null;
    const up = await waitFor(async () => {
      const reply = await ping(io.env);
      if (!reply?.ok) return false;
      const data = reply.data as { pid?: number; restart_handoff?: boolean; restart_dropped?: { reason: string; ts: number } | null };
      if (data.pid !== old.pid) fresh = reply;
      // The old daemon still answers and withdrew its handoff: its supervisor refused, so no new daemon is coming.
      else if (data.restart_handoff === false) dropped = { reason: data.restart_dropped && data.restart_dropped.ts >= started - 1_000 ? data.restart_dropped.reason : "the old daemon withdrew it" };
      return fresh !== null || dropped !== null;
    }, RESTART_WAIT_MS);
    if (dropped) {
      return print(io, errorReply({ code: "restart_dropped", message: `the restart was dropped and the old daemon (pid ${old.pid}) still runs: ${(dropped as { reason: string }).reason}`, help: "flowryn daemon status; tell the user" }));
    }
    if (!up || !fresh) {
      const { config } = loadConfig(flowrynHome(io.env));
      return print(io, errorReply({ code: "daemon_unavailable", message: `the old daemon (pid ${old.pid}) was asked to restart, but no new daemon answered within ${RESTART_WAIT_MS / 1000} s`, help: `launchd keeps retrying it; see ${stateFiles(config.state_dir).logs}` }));
    }
    const next = (fresh as Reply).data as { pid: number; version: string; proto: number; build: string | null; uptime_s: number | null };
    return print(
      io,
      okReply({ restarted: String(asked.data.supervisor), old: describe(old), new: describe(next), waited: `${((Date.now() - started) / 1000).toFixed(1)} s` }, ["flowryn daemon status", "flowryn fleet"]),
    );
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
    const spec = plistSpecFor(config, home);
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

export const DAEMON_VERBS: VerbSpec[] = [run, start, stop, restart, status, install, uninstall];
