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
import { PING_VERB, STOP_VERB } from "../../daemon/system-verbs.ts";
import { installService, isLoaded, kickstart, plistPath, plistSpecFor, renderPlist, serviceLabel, selfCommand, uninstallService } from "../../service/launchd.ts";
import { request } from "../../transport/unix.ts";
import { ensureDir } from "../../util/fsx.ts";
import { isLockHeld } from "../../util/flock.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";
import { notHumanReason } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";

const START_WAIT_MS = 8_000;
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

export const DAEMON_VERBS: VerbSpec[] = [run, start, stop, status, install, uninstall];
