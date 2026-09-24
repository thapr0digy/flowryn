import { loadConfig } from "../../config/config.ts";
import { flowrynHome } from "../../config/paths.ts";
import { errorReply, okReply, type Reply } from "../../api/envelope.ts";
import { toErrorBody } from "../../api/errors.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { serverVerb } from "../../api/registry.ts";
import { doctorExitCode, restoreBackup, runChecks } from "../../doctor/doctor.ts";
import { runInit } from "../../init/init.ts";
import { listTasks, processRunner } from "../../journal/tasks-axi.ts";
import { installService, plistPath, plistSpecFor } from "../../service/launchd.ts";
import { PROTO, VERSION } from "../../version.ts";
import { runServerVerb } from "../client.ts";
import { agentIdentity, notHumanReason } from "../human.ts";
import { LineReader } from "../line-reader.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { ping } from "./daemon.ts";

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

async function firstLine(path: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? (out.trim().split("\n")[0] ?? null) : null;
  } catch {
    return null;
  }
}

function captureIo(io: CliIo): { io: CliIo; text: () => string } {
  let buffer = "";
  return {
    io: { ...io, json: false, stdout: (t) => (buffer += t), stderr: (t) => (buffer += t) },
    text: () => buffer.trimEnd(),
  };
}

const init: VerbSpec = {
  name: "init",
  summary: "Set up Flowryn interactively: tools, directories, tasks-axi files, service",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(_args, io) {
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason || !io.stdinIsTty) {
      return print(io, errorReply({ code: "human_only", message: `init is interactive and runs only in your own terminal: ${reason ?? "stdin is not a terminal"}` }));
    }
    const input = new LineReader(process.stdin);
    const answer = async (prompt: string): Promise<string> => {
      io.stdout(prompt);
      const line = await input.next();
      if (line === null) throw new Error("input ended before init finished; nothing more was written");
      return line.trim();
    };
    try {
      return await runInit({
        env: io.env,
        platform: process.platform,
        io: {
          print: (line) => io.stdout(line + "\n"),
          ask: async (question, fallback) => (await answer(`${question} [${fallback}]: `)) || fallback,
          confirm: async (question, fallback) => {
            const reply = (await answer(`${question} [${fallback ? "Y/n" : "y/N"}]: `)).toLowerCase();
            return reply === "" ? fallback : reply.startsWith("y");
          },
        },
        which: (binary) => Bun.which(binary),
        version: firstLine,
        listTasks: async (tasksAxi, node, file) => (await listTasks(processRunner(tasksAxi, node), file)).length,
        installService: async (config, home) => {
          const spec = plistSpecFor(config, home);
          await installService(spec, plistPath(spec.label));
          return `installed ${plistPath(spec.label)}`;
        },
        addProject: async (path) => {
          const captured = captureIo(io);
          await runServerVerb(serverVerb("project add")!, { path }, captured.io);
          return captured.text();
        },
        doctor: async () => {
          const checks = await runChecks({ env: io.env, ping: () => ping(io.env) }, false);
          return renderReply(okReply({ checks }), { json: false }).trimEnd();
        },
      });
    } catch (error) {
      return print(io, errorReply({ code: "bad_args", message: (error as Error).message }));
    } finally {
      input.close();
    }
  },
};

const doctor: VerbSpec = {
  name: "doctor",
  summary: "Check config, tools, tasks-axi files, database, daemon and service",
  positionals: [],
  flags: {
    contracts: { type: "boolean", help: "also run the harness contract suites (M2)" },
    restore: { type: "boolean", help: "replace flowryn.db with a nightly backup (daemon stopped)" },
    backup: { type: "string", help: "which backup to restore: a date or file name (default: newest)", placeholder: "date" },
  },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const identity = agentIdentity(io.env);
    if (identity) return print(io, errorReply({ code: "human_only", message: `doctor runs only in your own terminal: ${identity} is set` }));
    if (boolArg(args, "restore")) {
      try {
        const { config } = loadConfig(flowrynHome(io.env));
        const result = restoreBackup(config, stringArg(args, "backup"));
        return print(io, okReply({ ...result, previous: result.previous ?? "-" }, ["flowryn daemon start", "flowryn doctor"]));
      } catch (error) {
        return print(io, errorReply({ ...toErrorBody(error), code: "internal" }));
      }
    }
    const checks = await runChecks({ env: io.env, ping: () => ping(io.env) }, boolArg(args, "contracts"));
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    io.stdout(renderReply(okReply({ checks, summary: `${failed} failed · ${warned} warnings` }), { json: io.json }));
    return doctorExitCode(checks);
  },
};

const config: VerbSpec = {
  name: "config",
  summary: "Show the effective configuration and where it comes from",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["leader", "worker", "human", "anonymous"],
  async local(_args, io) {
    try {
      const loaded = loadConfig(flowrynHome(io.env));
      const { config: c } = loaded;
      return print(
        io,
        okReply({
          path: loaded.path,
          exists: loaded.exists ? "yes" : "no (defaults)",
          data_dir: c.data_dir,
          state_dir: c.state_dir,
          morning_hour: c.morning_hour,
          backlog: c.tasks.backlog,
          todos: c.tasks.todos,
          tools: Object.keys(c.tools).length > 0 ? c.tools : "none recorded (flowryn init)",
        }),
      );
    } catch (error) {
      return print(io, errorReply(toErrorBody(error)));
    }
  },
};

const version: VerbSpec = {
  name: "version",
  summary: "Print the Flowryn version and protocol",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["leader", "worker", "human", "anonymous"],
  async local(_args, io) {
    return print(io, okReply({ flowryn: VERSION, proto: PROTO, bun: Bun.version, exec: process.execPath }));
  },
};

export const SETUP_VERBS: VerbSpec[] = [init, doctor, config, version];

