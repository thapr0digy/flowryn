import { errorReply } from "../../api/envelope.ts";
import { EXIT } from "../../api/errors.ts";
import { COMPLETION_SOURCES, stringArg, type CliIo, type CompletionSource, type VerbSpec } from "../../api/verbs.ts";
import { VERSION } from "../../version.ts";
import { completionValues, describeLines } from "../completion/values.ts";
import { zshScript } from "../completion/zsh.ts";
import { exitCodeOf, renderReply } from "../render.ts";

/**
 * `flowryn completion zsh` and the lookup its script calls on Tab
 * (docs/notes/2026-10-29-zsh-completions-for-49.md). Both print plain text,
 * not a reply: one is a script to source, the other `id:description` lines.
 */

export const COMPLETION_SHELLS = ["zsh"] as const;

function refuse(io: CliIo, message: string, help: string): number {
  const reply = errorReply({ code: "bad_args", message, help });
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

const completion: VerbSpec = {
  name: "completion",
  summary: "Print the shell completion script: source <(flowryn completion zsh)",
  positionals: [{ name: "shell", required: true, help: "the shell: zsh", values: COMPLETION_SHELLS }],
  flags: {},
  kind: "local",
  roles: ["leader", "reader", "worker", "human", "anonymous"],
  async local(args, io) {
    const shell = stringArg(args, "shell")!;
    if (shell !== "zsh") return refuse(io, `no completion for ${shell}: only zsh is supported`, "flowryn completion zsh");
    // The registry imports this file, so it is read here, once it has loaded.
    const { CLI_VERBS } = await import("../registry.ts");
    io.stdout(zshScript(CLI_VERBS, VERSION));
    return EXIT.ok;
  },
};

const completionValuesVerb: VerbSpec = {
  name: "completion values",
  summary: "Print the open ids of one kind for shell completion, from a read-only look at local state; nothing when it cannot read",
  positionals: [{ name: "source", required: true, help: COMPLETION_SOURCES.join(", "), values: COMPLETION_SOURCES }],
  flags: {},
  kind: "local",
  roles: ["leader", "reader", "worker", "human", "anonymous"],
  async local(args, io) {
    const source = stringArg(args, "source")!;
    if (!(COMPLETION_SOURCES as readonly string[]).includes(source)) return refuse(io, `unknown source ${source}`, `one of: ${COMPLETION_SOURCES.join(", ")}`);
    let lines = "";
    try {
      lines = describeLines(completionValues(io.env, source as CompletionSource));
    } catch {
      // A Tab offers nothing rather than an error: no config, no database, a bad token, a locked file.
      lines = "";
    }
    io.stdout(lines);
    return EXIT.ok;
  },
};

export const COMPLETION_VERBS: VerbSpec[] = [completion, completionValuesVerb];
