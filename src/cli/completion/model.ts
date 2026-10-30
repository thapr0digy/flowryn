import type { CompletionSource, FlagSpec, PositionalSpec, VerbSpec } from "../../api/verbs.ts";

/**
 * A shell-neutral view of the command registry for tab completion: the verb
 * words as a tree, and each verb's arguments with what completes them. Every
 * shell printer (only zsh today, src/cli/completion/zsh.ts) reads this, so
 * nothing about a verb is written down twice.
 */

/** What completes one value. */
export type ValueAction =
  | { kind: "none" }
  | { kind: "files"; dirsOnly: boolean }
  /** Fixed values, and when `source` is set, ids looked up at Tab time first (the values are the fallback). */
  | { kind: "values"; values: readonly string[]; source?: CompletionSource }
  | { kind: "source"; source: CompletionSource };

export interface CompletionArg {
  name: string;
  help: string;
  required: boolean;
  action: ValueAction;
}

export interface CompletionFlag {
  /** Without the leading dashes. */
  name: string;
  help: string;
  takesValue: boolean;
  repeatable: boolean;
  /** What the value is called in the prompt (its placeholder, else the flag's name). */
  label: string;
  action: ValueAction;
}

export interface CompletionVerb {
  name: string;
  summary: string;
  positionals: CompletionArg[];
  flags: CompletionFlag[];
}

export interface CompletionNode {
  word: string;
  /** The words from the root, space-joined; "" for the root. */
  path: string;
  /** The verb these words name, when they name one (`verify` is a verb and the parent of `verify show`). */
  verb: CompletionVerb | null;
  children: CompletionNode[];
}

/** Accepted anywhere on the line (src/cli/argv.ts). */
export const GLOBAL_FLAGS: readonly CompletionFlag[] = [
  { name: "json", help: "print the reply as JSON", takesValue: false, repeatable: false, label: "json", action: { kind: "none" } },
  { name: "help", help: "print help for the command", takesValue: false, repeatable: false, label: "help", action: { kind: "none" } },
];

/** The short spelling of --help. */
export const SHORT_HELP = "h";

const FILE_PLACEHOLDERS = new Set(["path", "file"]);
const DIR_NAMES = new Set(["path", "dir"]);

function hintAction(hint: { values?: readonly string[]; complete?: CompletionSource }): ValueAction | null {
  if (hint.values && hint.values.length > 0) return { kind: "values", values: hint.values, ...(hint.complete ? { source: hint.complete } : {}) };
  if (hint.complete) return { kind: "source", source: hint.complete };
  return null;
}

function flagAction(flag: FlagSpec): ValueAction {
  const hinted = hintAction(flag);
  if (hinted) return hinted;
  if (flag.fileFor) return { kind: "files", dirsOnly: false };
  if (flag.placeholder === "dir") return { kind: "files", dirsOnly: true };
  if (flag.placeholder && FILE_PLACEHOLDERS.has(flag.placeholder)) return { kind: "files", dirsOnly: false };
  return { kind: "none" };
}

function positionalAction(positional: PositionalSpec): ValueAction {
  return hintAction(positional) ?? (DIR_NAMES.has(positional.name) ? { kind: "files", dirsOnly: true } : { kind: "none" });
}

function flagLabel(name: string, flag: FlagSpec): string {
  if (flag.placeholder) return flag.placeholder;
  if (flag.fileFor) return "path|-";
  return name;
}

export function completionVerb(spec: VerbSpec): CompletionVerb {
  return {
    name: spec.name,
    summary: spec.summary,
    positionals: spec.positionals.map((p) => ({ name: p.name, help: p.help, required: p.required, action: positionalAction(p) })),
    flags: Object.entries(spec.flags).map(([name, flag]) => ({
      name,
      help: flag.help,
      takesValue: flag.type !== "boolean",
      repeatable: flag.type === "list",
      label: flagLabel(name, flag),
      action: flagAction(flag),
    })),
  };
}

/** The verb words of the registry as a tree, children in registry order. */
export function completionTree(verbs: readonly VerbSpec[]): CompletionNode {
  const root: CompletionNode = { word: "", path: "", verb: null, children: [] };
  for (const spec of verbs) {
    let node = root;
    for (const word of spec.name.split(" ")) {
      let child = node.children.find((c) => c.word === word);
      if (!child) {
        child = { word, path: node.path ? `${node.path} ${word}` : word, verb: null, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.verb = completionVerb(spec);
  }
  return root;
}

/** Every node below `node`, depth first. */
export function allNodes(node: CompletionNode): CompletionNode[] {
  return node.children.flatMap((child) => [child, ...allNodes(child)]);
}

/** The line a word is offered with: the verb's summary, else the sub-commands under it. */
export function nodeSummary(node: CompletionNode): string {
  if (node.verb) return node.verb.summary;
  return `${node.children.map((c) => c.word).join(", ")}`;
}
