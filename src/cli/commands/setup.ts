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
import { BUILD_STAMP } from "../../build-stamp.ts";
import { LATEST_SCHEMA_VERSION } from "../../db/schema.ts";
import { callServerVerb, runServerVerb } from "../client.ts";
import { agentIdentity, notHumanReason } from "../human.ts";
import { LineReader } from "../line-reader.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { ping } from "./daemon.ts";
import { runContract } from "../../contracts/runner.ts";
import { HARNESS_IDS, type HarnessId } from "../../harness/types.ts";
import { resolveTool } from "../../config/config.ts";
import { resolveHerdrSocket } from "../../runtime/herdr/socket.ts";
import { dataDirReport } from "../../contracts/report.ts";
import { contractEstimateSeconds, contractSteps } from "../../contracts/suite.ts";
import type { Check } from "../../doctor/doctor.ts";
import type { ReportStamp } from "../../contracts/grant.ts";
import { buildIdOf } from "../../daemon/restart.ts";
import { selfCommand } from "../../service/launchd.ts";

function minutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** The up-front line: what will run, how many steps, and roughly how long it takes. */
export function contractPlan(harnesses: readonly HarnessId[]): string {
  if (harnesses.length === 0) return "contracts: no harness installed to test";
  const steps = harnesses.reduce((total, h) => total + contractSteps(h).length, 0);
  const seconds = harnesses.reduce((total, h) => total + contractEstimateSeconds(h), 0);
  return `contracts: ${harnesses.join(", ")}; ${steps} steps, about ${minutes(seconds)} (each step's own timeout is the real bound)`;
}

/** Who is running doctor, by its environment: a run is a worker, any other token the leader. */
function contractCaller(env: NodeJS.ProcessEnv): ReportStamp["by"] {
  if ((env.FLOWRYN_RUN ?? "").length > 0) return "worker";
  return (env.FLOWRYN_TOKEN ?? "").length > 0 ? "leader" : "human";
}

/**
 * Whether this run may record, asked before the suite starts. Your own
 * terminal records as it always has. A worker never records. A token asks
 * the daemon (contracts.may_record), which answers by role, [policy] mode and
 * build id; `contracts.record` checks again once the suite passes.
 */
async function recordRefusal(by: ReportStamp["by"], build: string | null, io: CliIo): Promise<Reply | null> {
  if (by === "human") return null;
  if (by === "worker") {
    return errorReply({ code: "worker_token", message: "a worker never records a contract pass", help: "flowryn doctor --contracts --verify-only runs the suite without recording" });
  }
  const answer = await callServerVerb(serverVerb("contracts.may_record")!, build ? { build } : {}, io);
  return answer.ok ? null : errorReply(answer.error ?? { code: "internal", message: "the daemon did not say whether this run may record" });
}

/** How a contract run ends: recorded through the daemon, verify-only, or for the daemon's automatic check to record. */
type ContractMode = "record" | "verify-only" | "for-daemon";

interface ContractRun {
  checks: Check[];
  /** The last harness's report and version: what a --for-daemon run hands the daemon. */
  report: string | null;
  version: string | null;
}

/**
 * `flowryn doctor --contracts`: run each harness's contract suite in a
 * scratch home against a real Herdr session and harness (design section 5),
 * then record every passing version with the daemon, which is the only writer
 * of flowryn.db. `--verify-only` records nothing and is open to any caller;
 * recording is your own terminal's, or the leader's under recordGrant
 * (src/contracts/grant.ts). `--for-daemon` is the daemon's automatic check
 * (src/contracts/auto.ts): the daemon starts it from its own pinned build,
 * and it writes a recording report and prints its path, recording nothing
 * itself; the daemon checks that report and records it.
 */
async function contractRun(args: Parameters<NonNullable<VerbSpec["local"]>>[0], io: CliIo, mode: ContractMode): Promise<ContractRun> {
  const run: ContractRun = { checks: [], report: null, version: null };
  const fail = (detail: string): ContractRun => ({ ...run, checks: [{ check: "contracts", status: "fail", detail }] });
  const verifyOnly = mode === "verify-only";
  const { config } = loadConfig(flowrynHome(io.env));
  const wanted = stringArg(args, "harness");
  if (wanted && !(HARNESS_IDS as readonly string[]).includes(wanted)) return fail("--harness must be claude or pi");
  if (mode === "for-daemon" && !wanted) return fail("--for-daemon runs one harness: pass --harness");
  const harnesses = (wanted ? [wanted] : HARNESS_IDS.filter((h) => resolveTool(config, h))) as HarnessId[];
  const socket = stringArg(args, "herdr-socket") ?? (await resolveHerdrSocket(config)).socket;
  if (!socket) return fail("no Herdr session to run in; pass --herdr-socket or set [herdr]");
  const by = mode === "for-daemon" ? "daemon" : contractCaller(io.env);
  const build = buildIdOf(selfCommand());
  const stamp: ReportStamp = { mode: verifyOnly ? "verify-only" : "record", build, by };
  io.stderr(`${contractPlan(harnesses)}${verifyOnly ? "; verify-only: nothing is recorded" : mode === "for-daemon" ? "; for the daemon to record" : ""}\n`);
  const checks = run.checks;
  for (const [index, harness] of harnesses.entries()) {
    io.stderr(`contract ${harness} (${index + 1}/${harnesses.length}): ${contractSteps(harness).length} steps, about ${minutes(contractEstimateSeconds(harness))}\n`);
    try {
      const result = await runContract({
        harness,
        config,
        herdrSocket: socket,
        project: stringArg(args, "project") ?? null,
        model: stringArg(args, "model") ?? null,
        keep: boolArg(args, "keep"),
        log: (line) => io.stderr(`contract ${harness}: ${line}\n`),
      });
      const report = dataDirReport(config, result, stamp);
      run.report = report;
      run.version = result.version;
      for (const step of result.steps) checks.push({ check: `contract ${harness} ${step.step}`, status: step.ok ? "ok" : "fail", detail: `${step.detail} (${step.seconds}s)` });
      if (!result.passed) {
        checks.push({ check: `contract ${harness}`, status: "fail", detail: `${result.version} did not pass; report ${report}${boolArg(args, "keep") ? `; scratch ${result.scratch}` : ""}` });
        continue;
      }
      if (verifyOnly) {
        checks.push({ check: `contract ${harness}`, status: "ok", detail: `${result.version} passed (verify-only, not recorded); report ${report}` });
        continue;
      }
      if (mode === "for-daemon") {
        checks.push({ check: `contract ${harness}`, status: "ok", detail: `${result.version} passed; the daemon records it; report ${report}` });
        continue;
      }
      const recorded = await callServerVerb(serverVerb("contracts.record")!, { harness, version: result.version, report, ...(build ? { build } : {}) }, io);
      checks.push(
        recorded.ok
          ? { check: `contract ${harness}`, status: "ok", detail: `${result.version} passed and was recorded; report ${report}` }
          : { check: `contract ${harness}`, status: "fail", detail: `${result.version} passed but was not recorded (${recorded.error?.code ?? `exit ${recorded.exitCode}`}: ${recorded.error?.message ?? "is the daemon up?"}); report ${report}` },
      );
    } catch (error) {
      checks.push({ check: `contract ${harness}`, status: "fail", detail: (error as Error).message });
    }
  }
  return run;
}

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
          const checks = await runChecks({ env: io.env, ping: () => ping(io.env) });
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
    contracts: { type: "boolean", help: "run the harness contract suites and record each passing version" },
    "verify-only": { type: "boolean", help: "with --contracts: run the suites and report, record nothing (any caller, the leader included)" },
    harness: { type: "string", help: "with --contracts: claude or pi (default: every installed harness)", placeholder: "harness" },
    project: { type: "string", help: "with --contracts: a checkout to base the test worktree on (default: a scratch repo)", placeholder: "path" },
    "herdr-socket": { type: "string", help: "with --contracts: the Herdr session socket to run in (default: [herdr])", placeholder: "path" },
    model: { type: "string", help: "with --contracts: the worker model for the run", placeholder: "model" },
    keep: { type: "boolean", help: "with --contracts: keep the scratch home for inspection" },
    "for-daemon": { type: "boolean", help: "with --contracts: the daemon's automatic check (it starts this itself); writes the report, records nothing" },
    restore: { type: "boolean", help: "replace flowryn.db with a nightly backup (daemon stopped)" },
    backup: { type: "string", help: "which backup to restore: a date or file name (default: newest)", placeholder: "date" },
  },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const contracts = boolArg(args, "contracts");
    const verifyOnly = boolArg(args, "verify-only");
    const forDaemon = boolArg(args, "for-daemon");
    if (verifyOnly && !contracts) return print(io, errorReply({ code: "bad_args", message: "--verify-only goes with --contracts" }));
    if (forDaemon && !contracts) return print(io, errorReply({ code: "bad_args", message: "--for-daemon goes with --contracts" }));
    if (forDaemon && verifyOnly) return print(io, errorReply({ code: "bad_args", message: "--for-daemon does not go with --verify-only" }));
    const restore = boolArg(args, "restore");
    const identity = agentIdentity(io.env);
    if (identity && restore) return print(io, errorReply({ code: "human_only", message: `doctor --restore runs only in your own terminal: ${identity} is set` }));
    if (restore && contracts) return print(io, errorReply({ code: "bad_args", message: "--restore does not go with --contracts" }));
    if (identity && !contracts) return print(io, errorReply({ code: "human_only", message: `doctor runs only in your own terminal: ${identity} is set`, help: "an agent may run flowryn doctor --contracts --verify-only" }));
    if (forDaemon && identity) return print(io, errorReply({ code: "human_only", message: `--for-daemon is the daemon's own check: ${identity} is set`, help: "an agent may run flowryn doctor --contracts --verify-only" }));
    if (contracts && !verifyOnly && !forDaemon) {
      const refusal = await recordRefusal(contractCaller(io.env), buildIdOf(selfCommand()), io);
      if (refusal) return print(io, refusal);
    }
    if (restore) {
      try {
        const { config } = loadConfig(flowrynHome(io.env));
        const result = restoreBackup(config, stringArg(args, "backup"));
        return print(io, okReply({ ...result, previous: result.previous ?? "-" }, ["flowryn daemon start", "flowryn doctor"]));
      } catch (error) {
        return print(io, errorReply({ ...toErrorBody(error), code: "internal" }));
      }
    }
    const run = contracts ? await contractRun(args, io, forDaemon ? "for-daemon" : verifyOnly ? "verify-only" : "record") : null;
    const checks = run ? run.checks : await runChecks({ env: io.env, ping: () => ping(io.env) });
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    const handed = forDaemon && run ? { report: run.report ?? "-", version: run.version ?? "-" } : {};
    io.stdout(renderReply(okReply({ checks, summary: `${failed} failed · ${warned} warnings`, ...handed }), { json: io.json }));
    return doctorExitCode(checks);
  },
};

const config: VerbSpec = {
  name: "config",
  summary: "Show the effective configuration and where it comes from",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["leader", "reader", "worker", "human", "anonymous"],
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
  roles: ["leader", "reader", "worker", "human", "anonymous"],
  async local(_args, io) {
    return print(io, okReply({ flowryn: VERSION, proto: PROTO, schema: LATEST_SCHEMA_VERSION, commit: BUILD_STAMP?.commit ?? null, dirty: BUILD_STAMP?.dirty ?? null, source: BUILD_STAMP?.source ?? null, bun: Bun.version, exec: process.execPath }));
  },
};

export const SETUP_VERBS: VerbSpec[] = [init, doctor, config, version];

