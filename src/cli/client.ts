import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config/config.ts";
import { flowrynHome, socketPath, spoolDir, stateFiles } from "../config/paths.ts";
import { openDb } from "../db/db.ts";
import { authorize, resolveCaller } from "../api/auth.ts";
import { errorReply, okReply, type Envelope, type Reply } from "../api/envelope.ts";
import { EXIT, FlowrynError, toErrorBody, type ErrorBody, type ExitCode } from "../api/errors.ts";
import { writeSpoolFile } from "../api/spool.ts";
import { validateArgs, type CliIo, type VerbSpec } from "../api/verbs.ts";
import { request, TransportError, type RequestTimeouts } from "../transport/unix.ts";
import { ulid } from "../util/ulid.ts";
import { PROTO } from "../version.ts";
import { notHumanReason } from "./human.ts";
import { exitCodeOf, renderReply } from "./render.ts";

/** Worker verbs and hooks: 300 ms connect, 2 s reply, then spool or step aside (design section 12). */
export const WORKER_TIMEOUTS: RequestTimeouts = { connectMs: 300, replyMs: 2_000 };
/** Leader and human verbs may wait for git or the journal, so they get longer. */
export const LEADER_TIMEOUTS: RequestTimeouts = { connectMs: 1_000, replyMs: 30_000 };

export const READ_ONLY_BANNER = "daemon down; read-only view of the last saved state (flowryn daemon status)";

/** Read `--x-file` arguments: a path, or - for stdin. Free text never goes through shell quoting. */
export async function readFileArgs(files: Record<string, string>, readStdin: () => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(files)) {
    if (source === "-") out[name] = await readStdin();
    else {
      try {
        out[name] = readFileSync(source, "utf8");
      } catch (error) {
        throw new FlowrynError("bad_args", `cannot read ${source}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
    }
  }
  return out;
}

function buildEnvelope(spec: VerbSpec, args: Record<string, unknown>, io: CliIo): Envelope {
  const token = io.env.FLOWRYN_TOKEN && io.env.FLOWRYN_TOKEN.length > 0 ? io.env.FLOWRYN_TOKEN : null;
  const human = !token && notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty }) === null;
  return { proto: PROTO, ulid: ulid(), verb: spec.name, token, channel: human ? "tty" : null, args };
}

function print(io: CliIo, reply: Reply, banner?: string): number {
  io.stdout(renderReply(reply, { json: io.json, banner }));
  return exitCodeOf(reply);
}

/** The read-only fallback's reply, with the banner to show alongside it on success (none on failure). */
function readOfflineReply(spec: VerbSpec, envelope: Envelope, io: CliIo): { reply: Reply; banner?: string } {
  const home = flowrynHome(io.env);
  const { config } = loadConfig(home);
  const dbPath = stateFiles(config.state_dir).db;
  if (!existsSync(dbPath)) {
    return { reply: errorReply({ code: "daemon_unavailable", message: "the daemon is down and there is no database yet", help: "flowryn init, then flowryn daemon start" }) };
  }
  const db = openDb(dbPath, { readonly: true });
  try {
    const caller = resolveCaller(db, envelope.token, envelope.channel);
    authorize(spec, caller, db);
    const args = validateArgs(spec, envelope.args);
    const result = spec.read!({ db, config, now: Date.now(), caller }, args);
    return { reply: okReply(result.data, result.hints), banner: READ_ONLY_BANNER };
  } finally {
    db.close();
  }
}

type Outcome = { reply: Reply; banner?: string } | { spooled: string };

/** Write the call to the spool, for worker verbs when the daemon cannot take it. */
function spool(spec: VerbSpec, envelope: Envelope, io: CliIo, why: string): Outcome {
  const runId = io.env.FLOWRYN_RUN;
  if (!runId || !envelope.token) {
    return { reply: errorReply({ code: "daemon_unavailable", message: `${why}; ${spec.name} can only spool inside a run (FLOWRYN_RUN and FLOWRYN_TOKEN)` }) };
  }
  const { config } = loadConfig(flowrynHome(io.env));
  writeSpoolFile(spoolDir(config.data_dir), runId, envelope);
  return { spooled: envelope.ulid };
}

/**
 * Send a server verb over the socket, and when the daemon is down, spool
 * (worker verbs), read SQLite read-only (reads, with a banner) or refuse
 * (everything else).
 */
async function sendServerVerb(spec: VerbSpec, args: Record<string, unknown>, io: CliIo): Promise<Outcome> {
  const envelope = buildEnvelope(spec, args, io);
  const sock = socketPath(flowrynHome(io.env), io.env);
  const base = spec.spool ? WORKER_TIMEOUTS : LEADER_TIMEOUTS;
  const timeouts = spec.replyMs ? { ...base, replyMs: spec.replyMs } : base;
  let reply: Reply;
  try {
    reply = (await request(sock, envelope, timeouts)) as Reply;
  } catch (error) {
    if (!(error instanceof TransportError)) throw error;
    if (spec.spool) return spool(spec, envelope, io, error.message);
    if (spec.kind === "read" && error.kind === "unavailable") {
      try {
        return readOfflineReply(spec, envelope, io);
      } catch (offlineError) {
        return { reply: errorReply(toErrorBody(offlineError)) };
      }
    }
    const message = error.kind === "timeout" ? `the daemon did not answer in time (${error.message}); the change may still apply` : `the daemon is not running (${error.message})`;
    return { reply: errorReply({ code: "daemon_unavailable", message, help: "flowryn daemon status" }) };
  }
  if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
    return { reply: errorReply({ code: "internal", message: "the daemon sent a malformed reply" }) };
  }
  return { reply };
}

/**
 * Run a server verb and print its reply: spooled worker verbs exit 75, reads
 * served read-only while the daemon is down exit 0 with a banner, and
 * anything else the daemon could not take exits 69.
 */
export async function runServerVerb(spec: VerbSpec, args: Record<string, unknown>, io: CliIo): Promise<number> {
  const outcome = await sendServerVerb(spec, args, io);
  if ("spooled" in outcome) {
    if (io.json) io.stdout(JSON.stringify({ ok: true, spooled: outcome.spooled }) + "\n");
    else io.stdout(`spooled: ${outcome.spooled}\nhelp: delivered when the daemon is back; do not retry in a loop\n`);
    return EXIT.spooled;
  }
  return print(io, outcome.reply, outcome.banner);
}

export interface ServerVerbResult {
  ok: boolean;
  data: Record<string, unknown>;
  error?: ErrorBody;
  exitCode: ExitCode;
}

/**
 * Like `runServerVerb`, for a local verb (`daemon restart`) that needs the
 * reply's data to keep going, rather than having it printed. Same envelope
 * and transport, so a token-less caller in a real terminal still gets
 * `channel: "tty"`.
 */
export async function callServerVerb(spec: VerbSpec, args: Record<string, unknown>, io: CliIo): Promise<ServerVerbResult> {
  const outcome = await sendServerVerb(spec, args, io);
  if ("spooled" in outcome) return { ok: true, data: { spooled: outcome.spooled }, exitCode: EXIT.spooled };
  const { reply } = outcome;
  return { ok: reply.ok, data: (reply.data as Record<string, unknown>) ?? {}, error: reply.error, exitCode: exitCodeOf(reply) };
}
