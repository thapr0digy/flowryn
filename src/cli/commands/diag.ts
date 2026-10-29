import { closeSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { errorReply, okReply } from "../../api/envelope.ts";
import { EXIT, type ErrorCode } from "../../api/errors.ts";
import { serverVerb } from "../../api/registry.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { callServerVerb } from "../client.ts";
import { renderReply } from "../render.ts";

/**
 * `flowryn diag export <task|run> --out <file>` (docs/notes/2026-10-13-next-steps-md-wq.md):
 * one run's diagnostic record, redacted, to a local JSON file. The daemon
 * (or, with it down, the read-only fallback) reads the record; this process
 * writes the file, so a caller in a sandbox writes only where it may. The
 * file is new (an existing one is never overwritten) and readable by you
 * alone. Nothing is uploaded.
 */

function fail(io: CliIo, code: ErrorCode, message: string, help?: string): number {
  io.stdout(renderReply(errorReply({ code, message, ...(help ? { help } : {}) }), { json: io.json }));
  return EXIT.validation;
}

/** Create the file only if it does not exist, mode 0600, and write it whole. */
function writeNew(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const diagExport: VerbSpec = {
  name: "diag export",
  summary: "Write one run's redacted diagnostic record (run, stages, gates, decisions, wait explanations, events, config) to a local file",
  positionals: [{ name: "target", required: true, help: "task or run id", complete: "task" }],
  flags: {
    out: { type: "string", help: "the file to create (refused if it exists)", placeholder: "file" },
    "include-text": { type: "boolean", help: "include decision, gate and event text (tokens and config secrets stay redacted)" },
  },
  kind: "local",
  roles: ["leader", "human"],
  async local(args, io) {
    const out = stringArg(args, "out");
    if (!out) return fail(io, "bad_args", "--out <file> is required", "flowryn diag export <task> --out <file>");
    const includeText = boolArg(args, "include-text");
    const reply = await callServerVerb(serverVerb("diag.export")!, { target: stringArg(args, "target"), "include-text": includeText }, io);
    if (!reply.ok) {
      io.stdout(renderReply(errorReply(reply.error ?? { code: "internal", message: "the export was not read" }), { json: io.json }));
      return reply.exitCode;
    }
    const path = resolve(out);
    try {
      writeNew(path, `${JSON.stringify(reply.data, null, 2)}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return fail(io, "already_exists", `${path} already exists; the export never overwrites a file`, "pick a new --out path");
      return fail(io, "bad_args", `cannot write ${path}: ${code ?? (error as Error).message}`);
    }
    const count = (key: string) => (Array.isArray(reply.data[key]) ? (reply.data[key] as unknown[]).length : 0);
    const data = {
      exported: path,
      task: reply.data.task,
      text: reply.data.text,
      contents: `${count("decisions")} decisions · ${count("gates")} gates · ${count("explanations")} explanations · ${count("events")} events · config (secrets redacted)`,
      ...(reply.data.events_truncated ? { events_truncated: reply.data.events_truncated } : {}),
    };
    io.stdout(renderReply(okReply(data, includeText ? ["the file holds decision and event text: share it with care"] : [`flowryn show ${String(reply.data.task)} --timeline --full`]), { json: io.json }));
    return EXIT.ok;
  },
};

export const DIAG_CLI_VERBS: VerbSpec[] = [diagExport];
