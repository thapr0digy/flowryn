/**
 * A shell line read just far enough for the toolkit rules (src/policy/toolkit.ts):
 * the simple commands it runs, each with its words (quotes removed), its
 * redirections and the text it reads on stdin. It is not a shell: it never
 * expands a variable or a glob, and it never throws. Command substitutions,
 * process substitutions, `bash -c` strings and `eval` are read as commands
 * of their own; wrappers (env, sudo, timeout, xargs, ...) are peeled off so
 * the command they run is what the rules see.
 *
 * Misses by design (the confused-agent threat model, docs/cutover-notes.md
 * C1): variable indirection, functions and aliases, scripts written then run,
 * subprocesses of python or node, make and npm-run targets, obfuscation.
 */

export interface Redirect {
  op: string;
  target: string;
}

/** One simple command as written: words with quotes removed. */
export interface RawCommand {
  words: string[];
  redirects: Redirect[];
  /** Heredoc and here-string text, and the words of the command piped into this one. */
  stdin: string;
}

/** A command after its assignments and wrappers are peeled off. */
export interface Command {
  argv: string[];
  /** argv[0]'s basename, lowercased: `/opt/homebrew/bin/gh` is `gh`. */
  name: string;
  /** `VAR=value` assignments before it (and from `env`). */
  assignments: Record<string, string>;
  redirects: Redirect[];
  stdin: string;
}

const MAX_DEPTH = 4;
const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")"]);
/** Words that start a command list rather than name a command. */
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case", "esac", "in", "for", "select", "function"]);

type Token = { kind: "word"; text: string } | { kind: "op"; text: string } | { kind: "redir"; text: string } | { kind: "heredoc"; text: string };

interface Scan {
  tokens: Token[];
  /** Commands found inside substitutions, read at the same depth plus one. */
  nested: string[];
}

/** The commands of a shell line, wrappers peeled, substitutions and `-c` strings included. */
export function shellCommands(line: string): Command[] {
  return commandsAt(line, 0);
}

function commandsAt(line: string, depth: number): Command[] {
  if (depth > MAX_DEPTH) return [];
  const { raw, nested } = rawCommands(line);
  const out: Command[] = [];
  for (const command of raw) out.push(...peel(command, depth));
  for (const inner of nested) out.push(...commandsAt(inner, depth + 1));
  return out;
}

/** Split a line into raw commands; text inside substitutions is returned to read separately. */
export function rawCommands(line: string): { raw: RawCommand[]; nested: string[] } {
  const { tokens, nested } = scan(line.replace(/\\\r?\n/g, ""));
  const raw: RawCommand[] = [];
  let current: RawCommand = { words: [], redirects: [], stdin: "" };
  let pipedText = "";
  const finish = (op: string | null) => {
    if (current.words.length > 0 || current.redirects.length > 0) {
      raw.push(current);
      pipedText = op === "|" || op === "|&" ? current.words.join(" ") + (current.stdin ? `\n${current.stdin}` : "") : "";
    } else if (op !== "|" && op !== "|&") pipedText = "";
    current = { words: [], redirects: [], stdin: pipedText };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op") {
      finish(token.text);
      continue;
    }
    if (token.kind === "heredoc") {
      current.stdin += (current.stdin ? "\n" : "") + token.text;
      continue;
    }
    if (token.kind === "redir") {
      if (token.text === "dup") continue;
      const next = tokens[i + 1];
      const target = next && next.kind === "word" ? next.text : "";
      if (next && next.kind === "word") i++;
      if (token.text === "<<<") current.stdin += (current.stdin ? "\n" : "") + target;
      else if (!token.text.startsWith("<<")) current.redirects.push({ op: token.text, target });
      continue;
    }
    if (current.words.length === 0 && KEYWORDS.has(token.text)) continue;
    current.words.push(token.text);
  }
  finish(null);
  return { raw, nested };
}

function scan(src: string): Scan {
  const tokens: Token[] = [];
  const nested: string[] = [];
  const pendingHeredocs: { delimiter: string; strip: boolean }[] = [];
  let i = 0;
  let word: string | null = null;
  const pushWord = () => {
    if (word !== null) tokens.push({ kind: "word", text: word });
    word = null;
  };
  const append = (text: string) => {
    word = (word ?? "") + text;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      pushWord();
      i++;
      // Heredoc bodies belong to the command before the newline.
      if (pendingHeredocs.length > 0) i = readHeredocs(src, i, pendingHeredocs.splice(0), tokens);
      tokens.push({ kind: "op", text: "\n" });
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      append(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      append(src.slice(i + 1, stop));
      i = stop + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      const { text, end } = readAnsiC(src, i + 2);
      append(text);
      i = end;
      continue;
    }
    if (c === '"') {
      const { text, end } = readDouble(src, i + 1, nested);
      append(text);
      i = end;
      continue;
    }
    if (c === "`") {
      const end = closingBacktick(src, i + 1);
      nested.push(src.slice(i + 1, end));
      append("`…`");
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const arithmetic = src[i + 2] === "(";
      const end = closingParen(src, i + 2);
      if (!arithmetic) nested.push(src.slice(i + 2, end));
      append("$(…)");
      i = end + 1;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(" && word === null) {
      const end = closingParen(src, i + 2);
      nested.push(src.slice(i + 2, end));
      append(`${c}(…)`);
      i = end + 1;
      continue;
    }
    const redirect = readRedirect(src, i, word);
    if (redirect) {
      if (redirect.fd) word = null;
      pushWord();
      tokens.push({ kind: "redir", text: redirect.op });
      i = redirect.end;
      if (redirect.op === "<<" || redirect.op === "<<-") {
        while (src[i] === " " || src[i] === "\t") i++;
        const { text, end } = readDelimiter(src, i);
        pendingHeredocs.push({ delimiter: text, strip: redirect.op === "<<-" });
        i = end;
      }
      continue;
    }
    const op = readOperator(src, i);
    if (op) {
      pushWord();
      tokens.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    append(c);
    i++;
  }
  pushWord();
  return { tokens, nested };
}

function readOperator(src: string, i: number): string | null {
  for (const op of ["&&", "||", "|&", ";;", ";", "|", "&", "(", ")"]) {
    if (src.startsWith(op, i)) return op === ";;" ? ";" : op;
  }
  return null;
}

/** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<<`, `<<-`, `<<<`, `<>`, `>&`, with an optional fd before (`2>`). */
function readRedirect(src: string, i: number, word: string | null): { op: string; end: number; fd: boolean } | null {
  // `2>` names an fd; `x>file` ends the word x before the redirection.
  const fd = word !== null && /^\d+$/.test(word);
  const rest = src.slice(i, i + 3);
  for (const op of ["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<<", "<>", ">", "<"]) {
    if (rest.startsWith(op)) {
      if (op === ">&" || (op === "<" && src[i + 1] === "&")) {
        // fd duplication (2>&1): no file is written.
        let end = i + 2;
        while (end < src.length && /[\d-]/.test(src[end]!)) end++;
        return { op: "dup", end, fd };
      }
      return { op, end: i + op.length, fd };
    }
  }
  return null;
}

function readDelimiter(src: string, i: number): { text: string; end: number } {
  let text = "";
  while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) {
    const c = src[i]!;
    if (c !== "'" && c !== '"' && c !== "\\") text += c;
    i++;
  }
  return { text, end: i };
}

function readHeredocs(src: string, i: number, docs: { delimiter: string; strip: boolean }[], tokens: Token[]): number {
  for (const doc of docs) {
    const lines: string[] = [];
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const lineEnd = nl === -1 ? src.length : nl;
      const line = src.slice(i, lineEnd);
      i = nl === -1 ? src.length : nl + 1;
      if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      lines.push(line);
    }
    tokens.push({ kind: "heredoc", text: lines.join("\n") });
  }
  return i;
}

function readAnsiC(src: string, i: number): { text: string; end: number } {
  let text = "";
  while (i < src.length && src[i] !== "'") {
    if (src[i] === "\\" && i + 1 < src.length) {
      const n = src[i + 1]!;
      text += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i += 2;
      continue;
    }
    text += src[i];
    i++;
  }
  return { text, end: i + 1 };
}

function readDouble(src: string, i: number, nested: string[]): { text: string; end: number } {
  let text = "";
  while (i < src.length && src[i] !== '"') {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      const n = src[i + 1]!;
      text += '"\\$`\n'.includes(n) ? (n === "\n" ? "" : n) : c + n;
      i += 2;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = closingParen(src, i + 2);
      if (src[i + 2] !== "(") nested.push(src.slice(i + 2, end));
      text += "$(…)";
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = closingBacktick(src, i + 1);
      nested.push(src.slice(i + 1, end));
      text += "`…`";
      i = end + 1;
      continue;
    }
    text += c;
    i++;
  }
  return { text, end: i + 1 };
}

/** The index of the `)` closing a paren opened just before `i`, skipping quotes and nested parens; the end of src when unbalanced. */
function closingParen(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      i = readDouble(src, i + 1, []).end;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return i;
    i++;
  }
  return src.length;
}

function closingBacktick(src: string, i: number): number {
  while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
  return Math.min(i, src.length);
}

// --- peeling wrappers ------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
/** Wrappers that run the rest of their arguments, with the flags of each that take a value. */
const WRAPPERS: Record<string, { valued: Set<string>; positional?: number }> = {
  command: { valued: new Set() },
  builtin: { valued: new Set() },
  exec: { valued: new Set(["-a"]) },
  nohup: { valued: new Set() },
  time: { valued: new Set(["-f", "-o"]) },
  nice: { valued: new Set(["-n"]) },
  timeout: { valued: new Set(["-s", "-k", "--signal", "--kill-after"]), positional: 1 },
  sudo: { valued: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group"]) },
  doas: { valued: new Set(["-u", "-C"]) },
  stdbuf: { valued: new Set(["-i", "-o", "-e"]) },
  xargs: { valued: new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a", "-J", "-R", "-S"]) },
};
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);

export function basename(word: string): string {
  const parts = word.split("/");
  return (parts[parts.length - 1] ?? word).toLowerCase();
}

function peel(raw: RawCommand, depth: number): Command[] {
  return peelWords(raw.words, {}, raw, depth);
}

function peelWords(words: string[], assignments: Record<string, string>, raw: RawCommand, depth: number): Command[] {
  let i = 0;
  const env = { ...assignments };
  while (i < words.length && ASSIGNMENT.test(words[i]!)) {
    const [key, ...value] = words[i]!.split("=");
    env[key!] = value.join("=");
    i++;
  }
  const rest = words.slice(i);
  if (rest.length === 0) return [];
  // A scoped package run by npx keeps its scope: `@playwright/mcp`, not `mcp`.
  const name = rest[0]!.startsWith("@") ? rest[0]!.toLowerCase() : basename(rest[0]!);
  const command: Command = { argv: rest, name, assignments: env, redirects: raw.redirects, stdin: raw.stdin };

  if (name === "command" && rest.slice(1).some((w) => w === "-v" || w === "-V")) return [command];
  if (name === "env") return peelEnv(rest, env, raw, depth);
  const wrapper = WRAPPERS[name];
  if (wrapper) {
    const inner = skipFlags(rest, 1, wrapper.valued);
    const start = inner + (wrapper.positional ?? 0);
    if (start >= rest.length) return [command];
    return peelWords(rest.slice(start), env, raw, depth);
  }
  if (SHELLS.has(name)) {
    const script = shellScript(rest);
    if (script === null) return [command];
    return [command, ...commandsAt(script, depth + 1)];
  }
  if (name === "eval") return [command, ...commandsAt(rest.slice(1).join(" "), depth + 1)];
  const runner = packageRun(rest);
  if (runner) return peelWords(runner, env, raw, depth);
  return [command];
}

/** `env [-i] [-u NAME] [-S 'string'] [VAR=value]... command`. */
function peelEnv(words: string[], assignments: Record<string, string>, raw: RawCommand, depth: number): Command[] {
  const env = { ...assignments };
  let i = 1;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir") {
      i += 2;
      continue;
    }
    if (w === "-S" || w === "--split-string") {
      return peelWords([...splitWords(words[i + 1] ?? ""), ...words.slice(i + 2)], env, raw, depth);
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    if (ASSIGNMENT.test(w)) {
      const [key, ...value] = w.split("=");
      env[key!] = value.join("=");
      i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return [{ argv: words, name: "env", assignments: env, redirects: raw.redirects, stdin: raw.stdin }];
  return peelWords(words.slice(i), env, raw, depth);
}

function splitWords(text: string): string[] {
  return rawCommands(text).raw[0]?.words ?? [];
}

/** The index of the first word after the flags (`--` ends them); flags in `valued` take the next word. */
function skipFlags(words: string[], from: number, valued: Set<string>): number {
  let i = from;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    if (valued.has(w)) i += 2;
    else i++;
  }
  return i;
}

/** `bash -c 'script'`, `sh -ec 'script'`, `zsh -lc 'script'`: the script, or null. */
function shellScript(words: string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (!w.startsWith("-") || w === "--") return null;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) return words[i + 1] ?? null;
    if (w === "-o" || w === "+o") i++;
  }
  return null;
}

/**
 * `npx [-y] [-p pkg] <pkg> args`, `bunx`, `pnpx`, `pnpm dlx|exec`, `yarn dlx|exec`,
 * `npm exec [--] <pkg>`: the words with the package (version dropped) as argv0.
 */
function packageRun(words: string[]): string[] | null {
  const name = basename(words[0]!);
  let from: number;
  if (PACKAGE_RUNNERS.has(name)) from = 1;
  else if ((name === "pnpm" || name === "yarn") && (words[1] === "dlx" || words[1] === "exec")) from = 2;
  else if (name === "npm" && (words[1] === "exec" || words[1] === "x")) from = 2;
  else return null;
  let i = from;
  let pkg: string | null = null;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") {
      i++;
      break;
    }
    if (w === "-p" || w === "--package") {
      pkg = words[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (w.startsWith("--package=")) {
      pkg = w.slice("--package=".length);
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return pkg ? [packageName(pkg)] : null;
  return [packageName(words[i]!), ...words.slice(i + 1)];
}

/** `chrome-devtools-mcp@latest` is `chrome-devtools-mcp`; `@playwright/mcp@1.2` is `@playwright/mcp`. */
export function packageName(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
}
