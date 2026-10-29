import type { VerbSpec } from "../../api/verbs.ts";
import { sanitizeLine } from "../../util/sanitize.ts";
import { allNodes, completionTree, GLOBAL_FLAGS, nodeSummary, SHORT_HELP, type CompletionArg, type CompletionFlag, type CompletionNode, type ValueAction } from "./model.ts";

/**
 * The zsh completion script, printed from the registry (`flowryn completion
 * zsh`). It works sourced (`source <(flowryn completion zsh)`, after compinit)
 * and saved as `_flowryn` in a directory on $fpath. The verb words are found
 * the way src/cli/argv.ts finds them (the longest run of up to three leading
 * words, --json and --help anywhere), then zsh's `_arguments` completes that
 * verb's flags and positionals. Ids come from `flowryn completion values`,
 * which prints nothing when it cannot read, so Tab then offers nothing.
 */

const MAX_HELP = 100;

/** Wrap text in zsh single quotes. */
export function zshQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Text inside an `_arguments` option description, `--flag[...]`. */
function bracketText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** Text in a colon-separated field: an `_arguments` message, or a `_describe` word. */
function colonText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

/** One value inside an `_arguments` `(a b c)` list. */
function listWord(text: string): string {
  return text.replace(/[\\\s()'":]/g, (c) => `\\${c}`);
}

function oneLine(text: string): string {
  return sanitizeLine(text, MAX_HELP);
}

function actionText(action: ValueAction): string {
  switch (action.kind) {
    case "none":
      return " ";
    case "files":
      return action.dirsOnly ? "_files -/" : "_files";
    case "source":
      return `{_flowryn_ids ${action.source}}`;
    case "values":
      if (action.source) return `{_flowryn_ids ${action.source} ${action.values.map(listWord).join(" ")}}`;
      return `(${action.values.map(listWord).join(" ")})`;
  }
}

function flagSpec(flag: CompletionFlag, spelling = `--${flag.name}`, exclusive = ""): string {
  const repeat = flag.repeatable ? "*" : "";
  const help = `[${bracketText(oneLine(flag.help))}]`;
  if (!flag.takesValue) return zshQuote(`${exclusive}${repeat}${spelling}${help}`);
  return zshQuote(`${exclusive}${repeat}${spelling}=${help}:${colonText(oneLine(flag.label))}:${actionText(flag.action)}`);
}

function positionalSpec(arg: CompletionArg, index: number): string {
  const message = colonText(oneLine(arg.help || arg.name));
  return zshQuote(`${index + 1}:${arg.required ? "" : ":"}${message}:${actionText(arg.action)}`);
}

function globalSpecs(): string[] {
  const [json, help] = GLOBAL_FLAGS as [CompletionFlag, CompletionFlag];
  const exclusive = `(--help -${SHORT_HELP})`;
  return [flagSpec(json), flagSpec(help, "--help", exclusive), flagSpec(help, `-${SHORT_HELP}`, exclusive)];
}

function childrenFunction(root: CompletionNode): string[] {
  const branches = [root, ...allNodes(root)].filter((node) => node.children.length > 0);
  const lines = ["_flowryn_children() {", "  case $1 in"];
  for (const node of branches) {
    const items = node.children.map((child) => zshQuote(`${colonText(child.word)}:${oneLine(nodeSummary(child))}`));
    lines.push(`    (${zshQuote(node.path)}) reply=(`, ...items.map((item) => `      ${item}`), "    ) ;;");
  }
  lines.push("  esac", "}");
  return lines;
}

function isVerbFunction(root: CompletionNode): string[] {
  const names = allNodes(root).filter((node) => node.verb).map((node) => zshQuote(node.path));
  return ["_flowryn_is_verb() {", "  case $1 in", `    (${names.join("|")}) return 0 ;;`, "  esac", "  return 1", "}"];
}

function verbArgsFunction(root: CompletionNode): string[] {
  const lines = ["_flowryn_verb_args() {", "  case $1 in"];
  for (const node of allNodes(root)) {
    if (!node.verb) continue;
    const specs = [...node.verb.positionals.map(positionalSpec), ...node.verb.flags.map((flag) => flagSpec(flag))];
    if (specs.length === 0) continue;
    lines.push(`    (${zshQuote(node.path)}) specs+=(`, ...specs.map((spec) => `      ${spec}`), "    ) ;;");
  }
  lines.push("  esac", "}");
  return lines;
}

const IDS_FUNCTION = `_flowryn_ids() {
  # Ids from a read-only look at Flowryn's state; the fixed values after the source are the fallback.
  local src=$1
  shift
  local -a found fixed
  fixed=("$@")
  found=(\${(f)"$(\${_flowryn_cmd:-flowryn} completion values $src 2>/dev/null)"})
  if (( \${#found} )); then
    _describe -t $src $src found
  elif (( \${#fixed} )); then
    _describe -t $src $src fixed
  else
    return 1
  fi
}`;

const MAIN_FUNCTION = `_flowryn() {
  local _flowryn_cmd=$words[1]
  local -a lead lead_at reply specs rest
  local i n word verb="" ret=1
  # The leading words, as the parser reads them: --json and --help anywhere, the first other flag ends them.
  for (( i = 2; i < CURRENT; i++ )); do
    word=$words[i]
    case $word in
      (--json|--help|-h) continue ;;
      (-*) break ;;
    esac
    lead+=("$word")
    lead_at+=($i)
  done
  # The verb is the longest run of up to three leading words that names one.
  for (( n = \${#lead} < 3 ? \${#lead} : 3; n >= 1; n-- )); do
    if _flowryn_is_verb "\${(j: :)lead[1,n]}"; then
      verb="\${(j: :)lead[1,n]}"
      break
    fi
  done
  _flowryn_children "\${(j: :)lead}"
  if (( \${#reply} )); then
    _describe -t commands 'flowryn command' reply && ret=0
  fi
  if [[ -n $verb ]]; then
    # Drop the verb's words, so _arguments sees only the verb's own arguments.
    rest=("$words[1]")
    for (( i = 2; i <= \${#words}; i++ )); do
      (( \${lead_at[(Ie)$i]} && \${lead_at[(Ie)$i]} <= n )) && continue
      rest+=("$words[i]")
    done
    (( CURRENT -= n ))
    words=("\${rest[@]}")
    specs=(GLOBAL_SPECS)
    _flowryn_verb_args "$verb"
    _arguments -S : "\${specs[@]}" && ret=0
  elif (( \${#lead} == 0 )) && [[ $PREFIX == -* ]]; then
    compadd -- --json --help -h && ret=0
  fi
  return ret
}`;

const LOADER = `if [[ $funcstack[1] == _flowryn ]]; then
  # Autoloaded from $fpath: this file is the body of _flowryn's first call.
  _flowryn "$@"
elif (( $+functions[compdef] )); then
  compdef _flowryn flowryn
else
  print -ru2 -- "flowryn completion: run compinit first (autoload -Uz compinit && compinit), then load this script"
fi`;

export function zshScript(verbs: readonly VerbSpec[], version: string): string {
  const root = completionTree(verbs);
  return [
    "#compdef flowryn",
    `# zsh completion for flowryn ${version}, printed by \`flowryn completion zsh\` from its command registry.`,
    "# Load it with: source <(flowryn completion zsh)   (after compinit)",
    "# or save it as _flowryn in a directory on $fpath; regenerate it after upgrading flowryn.",
    "",
    ...childrenFunction(root),
    "",
    ...isVerbFunction(root),
    "",
    ...verbArgsFunction(root),
    "",
    IDS_FUNCTION,
    "",
    MAIN_FUNCTION.replace("GLOBAL_SPECS", globalSpecs().join(" ")),
    "",
    LOADER,
    "",
  ].join("\n");
}
