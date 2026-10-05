import { FlowrynError } from "../api/errors.ts";
import { usage, type VerbSpec } from "../api/verbs.ts";

export interface ParsedCommand {
  spec: VerbSpec;
  /** Positionals by name and flags by name; `--x-file` flags still hold their path here. */
  args: Record<string, unknown>;
  /** File-backed flags (and stdin flags given -) to read before sending: argument name -> path or "-". */
  files: Record<string, string>;
}

export interface ParsedArgv {
  command: ParsedCommand | null;
  json: boolean;
  help: boolean;
  /** Leading words when no verb matched, for help and errors. */
  words: string[];
}

const GLOBAL_JSON = "--json";
const GLOBAL_HELP = new Set(["--help", "-h"]);

/** Find the verb whose name matches the longest run of leading words. */
function matchVerb(words: string[], verbs: readonly VerbSpec[]): { spec: VerbSpec; used: number } | null {
  for (let n = Math.min(words.length, 3); n >= 1; n--) {
    const name = words.slice(0, n).join(" ");
    const spec = verbs.find((v) => v.name === name);
    if (spec) return { spec, used: n };
  }
  return null;
}

/**
 * Parse argv against the registry: `flowryn <verb words> [positionals] [--flag value]`.
 * `--flag=value` works too, `--` ends flag parsing, and --json and --help are
 * accepted anywhere.
 */
export function parseArgv(argv: string[], verbs: readonly VerbSpec[]): ParsedArgv {
  let json = false;
  let help = false;
  const rest: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (!passthrough && arg === "--") {
      passthrough = true;
      rest.push(arg);
    } else if (!passthrough && arg === GLOBAL_JSON) json = true;
    else if (!passthrough && GLOBAL_HELP.has(arg)) help = true;
    else rest.push(arg);
  }
  const leading: string[] = [];
  for (const word of rest) {
    if (word.startsWith("-")) break;
    leading.push(word);
  }
  if (leading[0] === "help") return { command: null, json, help: true, words: leading.slice(1) };
  const match = matchVerb(leading, verbs);
  if (!match) return { command: null, json, help, words: leading };
  if (help) return { command: { spec: match.spec, args: {}, files: {} }, json, help, words: leading };

  const { spec } = match;
  const tokens = rest.slice(match.used);
  const args: Record<string, unknown> = {};
  const files: Record<string, string> = {};
  const positionals: string[] = [];
  let flagsDone = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!flagsDone && token === "--") {
      flagsDone = true;
      if (spec.rest) {
        // Everything after -- belongs to the command this verb runs, untouched.
        args[spec.rest.name] = tokens.slice(i + 1);
        break;
      }
      continue;
    }
    if (flagsDone || !token.startsWith("--") || token === "-") {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const flag = spec.flags[name];
    if (!flag) throw new FlowrynError("bad_args", `unknown flag --${name} for ${spec.name}`, `usage: ${usage(spec)}`);
    let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);
    if (flag.type === "boolean") {
      if (value !== undefined) throw new FlowrynError("bad_args", `--${name} takes no value`);
      args[name] = true;
      continue;
    }
    if (value === undefined) {
      value = tokens[i + 1];
      if (value === undefined) throw new FlowrynError("bad_args", `--${name} needs a value`, `usage: ${usage(spec)}`);
      i++;
    }
    if (flag.fileFor) files[flag.fileFor] = value;
    else if (flag.stdin && value === "-") files[name] = "-";
    else if (flag.type === "list") args[name] = [...((args[name] as string[] | undefined) ?? []), value];
    else args[name] = value;
  }
  const fromStdin = Object.keys(files).filter((name) => files[name] === "-");
  if (fromStdin.length > 1) throw new FlowrynError("bad_args", `only one flag can read stdin (-); got ${fromStdin.length}`, `usage: ${usage(spec)}`);
  if (positionals.length > spec.positionals.length) {
    throw new FlowrynError("bad_args", `too many arguments for ${spec.name}: ${positionals.slice(spec.positionals.length).join(" ")}`, `usage: ${usage(spec)}`);
  }
  spec.positionals.forEach((p, index) => {
    if (positionals[index] !== undefined) args[p.name] = positionals[index];
  });
  return { command: { spec, args, files }, json, help, words: leading };
}
