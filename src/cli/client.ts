import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config/config.ts";
import { flowrynHome, socketPath, spoolDir, stateFiles } from "../config/paths.ts";
import { openDb } from "../db/db.ts";
import { authorize, resolveCaller } from "../api/auth.ts";
import { errorReply, okReply, type Envelope, type Reply } from "../api/envelope.ts";
import { EXIT, FlowrynError, toErrorBody } from "../api/errors.ts";
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

/** Serve a read from SQLite read-only when the daemon is down (WAL allows concurrent readers). */
function readOffline(spec: VerbSpec, envelope: Envelope, io: CliIo): number {
  const home = flowrynHome(io.env);
  const { config } = loadConfig(home);
  const dbPath = stateFiles(config.state_dir).db;
  if (!existsSync(dbPath)) {
    return print(io, errorReply({ code: "daemon_unavailable", message: "the daemon is down and there is no database yet", help: "flowryn init, then flowryn daemon start" }));
  }
  const db = openDb(dbPath, { readonly: true });
  try {
    const caller = resolveCaller(db, envelope.token, envelope.channel);
    authorize(spec, caller, db);
    const args = validateArgs(spec, envelope.args);
    const result = spec.read!({ db, config, now: Date.now(), caller }, args);
    return print(io, okReply(result.data, result.hints), READ_ONLY_BANNER);
  } finally {
    db.close();
  }
}

/** Write the call to the spool and exit 75, for worker verbs when the daemon cannot take it. */
function spool(spec: VerbSpec, envelope: Envelope, io: CliIo, why: string): number {
  const runId = io.env.FLOWRYN_RUN;
  if (!runId || !envelope.token) {
    return print(io, errorReply({ code: "daemon_unavailable", message: `${why}; ${spec.name} can only spool inside a run (FLOWRYN_RUN and FLOWRYN_TOKEN)` }));
  }
  const { config } = loadConfig(flowrynHome(io.env));
  writeSpoolFile(spoolDir(config.data_dir), runId, envelope);
  if (io.json) io.stdout(JSON.stringify({ ok: true, spooled: envelope.ulid }) + "\n");
  else io.stdout(`spooled: ${envelope.ulid}\nhelp: delivered when the daemon is back; do not retry in a loop\n`);
  return EXIT.spooled;
}

/**
 * Run a server verb: send it over the socket, and when the daemon is down,
 * spool (worker verbs, exit 75), read SQLite read-only (reads, exit 0 with a
 * banner) or refuse (everything else, exit 69).
 */
export async function runServerVerb(spec: VerbSpec, args: Record<string, unknown>, io: CliIo): Promise<number> {
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
        return readOffline(spec, envelope, io);
      } catch (offlineError) {
        return print(io, errorReply(toErrorBody(offlineError)));
      }
    }
    const message = error.kind === "timeout" ? `the daemon did not answer in time (${error.message}); the change may still apply` : `the daemon is not running (${error.message})`;
    return print(io, errorReply({ code: "daemon_unavailable", message, help: "flowryn daemon status" }));
  }
  if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
    return print(io, errorReply({ code: "internal", message: "the daemon sent a malformed reply" }));
  }
  return print(io, reply);
}
