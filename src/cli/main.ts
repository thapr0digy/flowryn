import { okReply, errorReply, type Reply } from "../api/envelope.ts";
import { EXIT, toErrorBody } from "../api/errors.ts";
import { usage, validateArgs, type CliIo, type VerbSpec } from "../api/verbs.ts";
import { parseArgv } from "./argv.ts";
import { readFileArgs, runServerVerb } from "./client.ts";
import { CLI_VERBS } from "./registry.ts";
import { exitCodeOf, renderReply } from "./render.ts";

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

function verbHelp(spec: VerbSpec): Record<string, unknown> {
  const help: Record<string, unknown> = { usage: usage(spec), summary: spec.summary };
  const args = spec.positionals.map((p) => ({ arg: `<${p.name}>`, help: p.help }));
  const flags = Object.entries(spec.flags).map(([name, f]) => ({ arg: `--${name}`, help: f.help }));
  if (args.length + flags.length > 0) help.args = [...args, ...flags];
  if (spec.kind !== "local") help.roles = spec.roles.join(" · ");
  return help;
}

function overview(): Record<string, unknown> {
  return {
    usage: "flowryn <command> [args] [--json]",
    commands: CLI_VERBS.map((v) => ({ command: v.name, summary: v.summary })),
    exit: "0 ok · 2 policy · 3 validation · 4 not found · 69 daemon down · 75 spooled · 76 protocol · 77 role",
  };
}

/** Parse argv, then run the verb locally or through the daemon. Returns the exit code. */
export async function cliMain(argv: string[], io: CliIo, readStdin: () => Promise<string>): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv, CLI_VERBS);
  } catch (error) {
    return print(io, errorReply(toErrorBody(error)));
  }
  const { command } = parsed;
  if (!command) {
    if (parsed.words.length > 0 && !parsed.help) {
      return print(io, errorReply({ code: "unknown_verb", message: `unknown command: ${parsed.words.join(" ")}`, help: "flowryn help" }));
    }
    const topic = parsed.words.length > 0 ? CLI_VERBS.find((v) => v.name === parsed.words.join(" ")) : undefined;
    return print(io, okReply(topic ? verbHelp(topic) : overview(), topic ? [] : ["flowryn help <command>", "flowryn doctor"]));
  }
  if (parsed.help) return print(io, okReply(verbHelp(command.spec)));

  const { spec } = command;
  try {
    const args = { ...command.args, ...(await readFileArgs(command.files, readStdin)) };
    const validated = validateArgs(spec, args);
    if (spec.kind === "local") return await spec.local!(validated, io);
    return await runServerVerb(spec, validated, io);
  } catch (error) {
    const reply = errorReply(toErrorBody(error));
    if (reply.error?.code === "internal") io.stderr(`${(error as Error).stack ?? String(error)}\n`);
    print(io, reply);
    return reply.error?.code === "internal" ? EXIT.failure : exitCodeOf(reply);
  }
}
