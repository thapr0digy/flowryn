import { isAbsolute, resolve } from "node:path";
import { basename, shellCommands, type Command } from "./shell.ts";

/**
 * The toolkit rules (toolkit-enforcement scout, section 3): Flowryn's agents
 * do each of these jobs with one fixed tool, and a tool call that does the job
 * another way is denied with a reason naming the right tool. Pure: no I/O, no
 * clock, never throws. `flowryn hook pre-tool` (Claude) and `flowryn hook
 * tool-check` (both Pi extensions) evaluate it in the hook process itself,
 * before any daemon call, so a denial holds with the daemon down.
 *
 * Every decision is a lookup on a tool name, a normalized argv0 (src/policy/shell.ts),
 * a URL host or a file path; no model is involved.
 */

export const TOOLKIT_RULES = ["github", "sqlite", "worktree", "jira", "browser", "tasks", "flowryn-tasks", "leader-shell"] as const;
export type ToolkitRule = (typeof TOOLKIT_RULES)[number];

export interface ToolkitVerdict {
  rule: ToolkitRule;
  /** The tool the agent should use instead. */
  tool: string;
  reason: string;
}

export interface ToolCall {
  harness: "claude" | "pi";
  role: "worker" | "leader";
  /** Claude's tool_name (Bash, Edit, mcp__x__y, Skill) or Pi's toolName (bash, edit, write). */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** The session's working directory, for relative paths. */
  cwd: string | null;
}

/** Flowryn's own files: its backlog and to-dos (`[tasks]`) and its database. */
export interface ToolkitPaths {
  home: string;
  flowrynBacklog: string;
  flowrynTodos: string;
  flowrynDb: string;
  /** TASKS_AXI_FILE in the hook's environment, if set. */
  tasksAxiFile?: string | null;
}

/** The fixed instruction block for workers and leaders, after [style] (scout section 2, L1). Fixed text, so the prompt cache holds. */
export const TOOL_MAP = [
  "Tools (Flowryn blocks the other ways):",
  "- GitHub: gh-axi (not gh, not curl api.github.com).",
  "- Jira: jira-axi. Browser: chrome-devtools-axi (a project's playwright test is fine).",
  "- SQLite reads: sqlite-axi. Git worktrees: treehouse.",
  "- A project's backlog.md and todos.md: tasks-axi. Flowryn's own backlog: flowryn verbs.",
  "- Visuals for review: lavish-axi.",
].join("\n");

/** Pi leader only: shell calls that need the user or belong to the harness (moved here from the Pi leader bridge). */
// Over-matches by design (the controller's ruling): a precise `decide ... --by captain` anchor
// misses `--by=captain`, quoted `captain`, reordered flags and a backslash-newline continuation.
const LEADER_SHELL_GATE = /\bflowryn\s+(merge|approve|hook|gate\s+pass)\b|flowryn\b[\s\S]*\bdecide\b[\s\S]*captain/;
const LEADER_SHELL_REASON =
  "flowryn: merge, gate pass, approve and a captain decision need the user (use the flowryn_merge, flowryn_gate_pass and flowryn_decide tools), and hook verbs belong to the harness; this session cannot run them from the shell";

const SHELL_TOOLS = new Set(["bash"]);
const FILE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

const MCP_RULES: { pattern: RegExp; rule: Exclude<ToolkitRule, "leader-shell"> }[] = [
  { pattern: /^mcp__.*github/i, rule: "github" },
  { pattern: /^mcp__.*sqlite/i, rule: "sqlite" },
  { pattern: /^mcp__.*atlassian/i, rule: "jira" },
  { pattern: /^mcp__.*(claude[-_]in[-_]chrome|playwright|puppeteer|chrome[-_]devtools)/i, rule: "browser" },
];

const TOOL_FOR: Record<Exclude<ToolkitRule, "leader-shell">, string> = {
  github: "gh-axi",
  sqlite: "sqlite-axi",
  worktree: "treehouse",
  jira: "jira-axi",
  browser: "chrome-devtools-axi",
  tasks: "tasks-axi",
  "flowryn-tasks": "flowryn",
};

/** The verdict for one tool call: the first rule it breaks, or null. Never throws. */
export function toolkitVerdict(call: ToolCall, paths: ToolkitPaths): ToolkitVerdict | null {
  try {
    return evaluate(call, paths);
  } catch {
    return null;
  }
}

function evaluate(call: ToolCall, paths: ToolkitPaths): ToolkitVerdict | null {
  const tool = call.toolName.toLowerCase();
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof call.toolInput.command === "string" ? call.toolInput.command : "";
    if (call.role === "leader" && call.harness === "pi" && LEADER_SHELL_GATE.test(command)) {
      return { rule: "leader-shell", tool: "flowryn_merge, flowryn_gate_pass or flowryn_decide", reason: LEADER_SHELL_REASON };
    }
    for (const c of shellCommands(command)) {
      const hit = commandVerdict(c, call, paths);
      if (hit) return hit;
    }
    return null;
  }
  if (FILE_TOOLS.has(tool)) {
    const target = [call.toolInput.file_path, call.toolInput.path, call.toolInput.notebook_path].find((p): p is string => typeof p === "string" && p.length > 0);
    if (!target) return null;
    return fileVerdict(target, call, paths, `${call.toolName} on ${target}`);
  }
  if (tool === "skill") {
    const skill = String(call.toolInput.skill ?? "");
    if (/^atlassian:/i.test(skill)) return deny("jira", call, `the ${skill} skill`);
    return null;
  }
  for (const { pattern, rule } of MCP_RULES) {
    if (pattern.test(call.toolName)) return deny(rule, call, `the MCP tool ${call.toolName}`);
  }
  return null;
}

function deny(rule: Exclude<ToolkitRule, "leader-shell">, call: ToolCall, what: string, extra?: string): ToolkitVerdict {
  const tool = TOOL_FOR[rule];
  const reason = `Blocked by Flowryn's toolkit rule (${rule}): ${what} is not allowed; ${guidance(rule, call)}${extra ? ` ${extra}` : ""}`;
  return { rule, tool, reason };
}

function guidance(rule: Exclude<ToolkitRule, "leader-shell">, call: ToolCall): string {
  switch (rule) {
    case "github":
      return "use gh-axi (for example gh-axi pr view 42).";
    case "sqlite":
      return "read with sqlite-axi (tables, schema, sample, query).";
    case "worktree":
      return "use treehouse get --lease --json and treehouse return <path>. A Flowryn worker already has its worktree; for another, ask your leader.";
    case "jira":
      return "use jira-axi.";
    case "browser":
      return "use chrome-devtools-axi (a project's own playwright test is fine).";
    case "tasks":
      return "change a backlog.md or todos.md with tasks-axi.";
    case "flowryn-tasks":
      return call.role === "worker"
        ? "Flowryn owns this backlog; ask your leader ($FLOWRYN_BIN ask) for the change."
        : "Flowryn owns this backlog; use the flowryn verbs (dispatch, plan, todo add, decision add, ...).";
  }
}

// --- shell commands ----------------------------------------------------------------------------

const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "httpie", "xh", "xhs", "curlie"]);
const SQLITE_CLIS = new Set(["sqlite3", "sqlite", "litecli"]);
const CHROMES = new Set(["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "google chrome", "google chrome canary", "chrome", "chrome-headless-shell"]);
const PLAYWRIGHT_ALLOWED = new Set(["", "test", "show-report", "install", "install-deps", "merge-reports", "--version", "-V", "--help", "-h"]);
const SCRIPT_RUNNERS = new Set(["node", "bun", "deno", "python", "python3"]);
const GIT_VALUED_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"]);
const TASKS_AXI_READS = new Set(["", "list", "show", "ready", "--help", "-h", "help", "-v", "-V", "--version"]);

function commandVerdict(c: Command, call: ToolCall, paths: ToolkitPaths): ToolkitVerdict | null {
  const shown = c.argv.slice(0, 3).join(" ");
  const args = c.argv.slice(1);

  if (c.name === "gh" || c.name === "hub") return deny("github", call, `\`${shown}\``);
  if (HTTP_CLIENTS.has(c.name)) {
    const rule = httpRule(args);
    if (rule) return deny(rule, call, `\`${c.name}\` to ${rule === "github" ? "the GitHub API" : "Jira"}`);
  }
  if (SQLITE_CLIS.has(c.name)) {
    const hit = sqliteVerdict(c, call, paths);
    if (hit) return hit;
  }
  if (c.name === "git") {
    const sub = gitSubcommand(args);
    if (sub && sub.name === "worktree" && ["add", "remove", "prune", "move"].includes(sub.rest[0] ?? "")) return deny("worktree", call, `\`git worktree ${sub.rest[0]}\``);
  }
  if (c.name === "jira" || c.name === "jira-cli" || (c.name === "acli" && args[0] === "jira")) return deny("jira", call, `\`${shown}\``);
  const browser = browserHit(c, args);
  if (browser) return deny("browser", call, browser);
  if (c.name === "tasks-axi") {
    const hit = tasksAxiVerdict(c, call, paths);
    if (hit) return hit;
  }
  for (const target of writtenFiles(c)) {
    const hit = fileVerdict(target, call, paths, `writing ${target} from the shell`);
    if (hit) return hit;
  }
  return null;
}

/** The GitHub API, or Jira (an atlassian.net host, or a jira host's /rest/api or /rest/agile), named by any argument. */
function httpRule(args: string[]): "github" | "jira" | null {
  for (const arg of args) {
    for (const candidate of [arg, arg.slice(arg.indexOf("=") + 1)]) {
      const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([A-Za-z0-9.-]+)(?::\d+)?(\/[^?#\s]*)?/i.exec(candidate);
      if (!m) continue;
      const host = m[1]!.toLowerCase();
      const path = m[2] ?? "";
      if (host === "api.github.com" || host === "uploads.github.com") return "github";
      if (host === "atlassian.net" || host.endsWith(".atlassian.net")) return "jira";
      if (host.includes("jira") && host.includes(".") && /\/rest\/(api|agile)\//.test(path)) return "jira";
    }
  }
  return null;
}

const SQLITE_VALUED = new Set(["-cmd", "-separator", "-newline", "-nullvalue", "-init", "-vfs", "-lookaside", "-maxsize", "-mmap", "-pagecache", "-heap", "-A", "--cmd"]);
const SQL_WRITE = /\b(insert|update|delete|replace|upsert|create|drop|alter|vacuum|attach|detach|reindex|analyze)\b|^\s*\.(import|restore|read|load|clone|recover)\b/im;

/**
 * sqlite: a raw sqlite3 that only reads is denied (sqlite-axi reads); one that
 * writes is allowed (the user's answer to the design's q31), except on
 * Flowryn's own flowryn.db, which no agent touches. SQL it cannot see (a
 * redirected file, or the output of a command other than echo/printf piped in,
 * when the command itself carries no SQL) counts as a write.
 */
function sqliteVerdict(c: Command, call: ToolCall, paths: ToolkitPaths): ToolkitVerdict | null {
  const words = c.argv.slice(1);
  let db: string | null = null;
  const sql: string[] = [];
  let readonly = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-readonly" || w === "--readonly") readonly = true;
    if (SQLITE_VALUED.has(w)) {
      if (w === "-cmd" || w === "--cmd") sql.push(words[i + 1] ?? "");
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    if (db === null) db = w;
    else sql.push(w);
  }
  if (db !== null && samePath(resolvePath(db, call.cwd, paths.home), paths.flowrynDb)) {
    return deny("sqlite", call, "a raw sqlite3 on Flowryn's flowryn.db", "Flowryn's database belongs to flowrynd; use the flowryn verbs.");
  }
  if (sql.length === 0 && (c.redirects.some((r) => r.op === "<") || c.pipedOpaque)) return null;
  const text = [...sql, c.stdin].join("\n");
  if (!readonly && SQL_WRITE.test(text)) return null;
  if (!readonly && text.trim() === "" && db === null) return null;
  return deny("sqlite", call, `\`${c.argv[0]}\` to read`, "Raw sqlite3 stays allowed for writes: put the SQL in the command, or pass a file with < file.sql (or pipe it in from cat).");
}

function gitSubcommand(args: string[]): { name: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length) {
    const w = args[i]!;
    if (!w.startsWith("-")) return { name: w, rest: args.slice(i + 1) };
    i += GIT_VALUED_GLOBALS.has(w) ? 2 : 1;
  }
  return null;
}

/** Ad-hoc browsing: browser MCP servers run directly, playwright other than a project's tests, puppeteer scripts, a headless Chrome. */
function browserHit(c: Command, args: string[]): string | null {
  const name = c.name;
  if (name === "chrome-devtools-mcp" || name === "@playwright/mcp" || /(playwright|puppeteer|chrome-devtools).*mcp|mcp.*(playwright|puppeteer)/.test(name)) return `\`${name}\``;
  if (name === "playwright" || name === "@playwright/test" || name === "playwright-core") {
    const sub = args.find((a) => !a.startsWith("-") || PLAYWRIGHT_ALLOWED.has(a)) ?? "";
    if (!PLAYWRIGHT_ALLOWED.has(sub)) return `\`playwright ${sub}\``;
  }
  if (name === "puppeteer" && args[0] !== "browsers") return "`puppeteer`";
  if (SCRIPT_RUNNERS.has(name)) {
    const moduleIndex = args.indexOf("-m");
    if (moduleIndex !== -1 && /^(playwright|puppeteer)$/.test(args[moduleIndex + 1] ?? "")) {
      const sub = args[moduleIndex + 2] ?? "";
      if (!PLAYWRIGHT_ALLOWED.has(sub)) return `\`${name} -m ${args[moduleIndex + 1]} ${sub}\``;
    }
    const flag = args.findIndex((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print" || a === "-c" || a === "eval");
    if (flag !== -1 && /\b(puppeteer|playwright)\b/.test(args[flag + 1] ?? "")) return `a ${name} script driving a browser`;
  }
  if (CHROMES.has(name) && args.some((a) => a.startsWith("--headless") || a.startsWith("--remote-debugging-port"))) return "a headless Chrome";
  return null;
}

/** A tasks-axi mutation on Flowryn's own backlog or to-dos (its --file, TASKS_AXI_FILE, or backlog.md in the cwd). */
function tasksAxiVerdict(c: Command, call: ToolCall, paths: ToolkitPaths): ToolkitVerdict | null {
  const args = c.argv.slice(1);
  let sub: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--file" || a === "--backend") {
      if (a === "--file") file = args[i + 1] ?? null;
      i++;
    } else if (a.startsWith("--file=")) file = a.slice("--file=".length);
    else if (a === "--help" || a === "-h") sub ??= "--help";
    else if (!a.startsWith("-")) sub ??= a;
  }
  if (TASKS_AXI_READS.has(sub ?? "")) return null;
  file ??= c.assignments.TASKS_AXI_FILE ?? paths.tasksAxiFile ?? "backlog.md";
  const resolved = resolvePath(file, call.cwd, paths.home);
  if (samePath(resolved, paths.flowrynBacklog) || samePath(resolved, paths.flowrynTodos)) {
    return deny("flowryn-tasks", call, `\`tasks-axi ${sub ?? ""}\` on Flowryn's own backlog`);
  }
  return null;
}

/** Files a command writes: redirections, tee, sed/perl -i, mv/cp/install/ln targets, rm, truncate, dd of=. */
function writtenFiles(c: Command): string[] {
  const files = c.redirects.filter((r) => r.op !== "<" && r.op !== "dup" && r.target !== "").map((r) => r.target);
  const args = c.argv.slice(1);
  const operands = args.filter((a) => !a.startsWith("-"));
  switch (c.name) {
    case "tee":
    case "rm":
    case "truncate":
    case "mv":
      files.push(...operands);
      break;
    case "cp":
    case "install":
    case "ln":
      if (operands.length > 0) files.push(operands[operands.length - 1]!);
      break;
    case "sed":
    case "gsed":
    case "perl":
      if (args.some((a) => editsInPlace(c.name, a))) files.push(...operands);
      break;
    case "dd":
      for (const a of args) if (a.startsWith("of=")) files.push(a.slice(3));
      break;
  }
  return files;
}

/** Short-flag letters after which the rest of a sed/perl cluster is the flag's value, not more flags. */
const VALUED_SHORT_FLAGS: Record<string, string> = { sed: "efl", gsed: "efl", perl: "eEIMmdDx" };
/** perl flags that take only an optional run of digits (-0 also a hex `xHH`), after which the cluster goes on. */
const DIGIT_SHORT_FLAGS: Record<string, RegExp> = { perl: /^(?:0(?:x[0-9a-f]*|\d*)|[lC]\d*)/i };

/** A sed/perl flag that edits in place: --in-place, or -i in a short-flag cluster before any value-taking letter. */
function editsInPlace(command: string, arg: string): boolean {
  if (arg.startsWith("--in-place")) return true;
  if (!/^-[^-]/.test(arg)) return false;
  const valued = VALUED_SHORT_FLAGS[command] ?? "";
  const digitFlag = DIGIT_SHORT_FLAGS[command];
  let i = 1;
  while (i < arg.length) {
    const letter = arg[i]!;
    if (letter === "i") return true;
    const digits = digitFlag?.exec(arg.slice(i));
    if (digits) {
      i += digits[0].length;
      continue;
    }
    if (valued.includes(letter)) return false;
    i++;
  }
  return false;
}

function fileVerdict(target: string, call: ToolCall, paths: ToolkitPaths, what: string): ToolkitVerdict | null {
  const resolved = resolvePath(target, call.cwd, paths.home);
  if (samePath(resolved, paths.flowrynBacklog) || samePath(resolved, paths.flowrynTodos)) return deny("flowryn-tasks", call, what);
  const name = basename(target);
  if (name === "backlog.md" || name === "todos.md") return deny("tasks", call, what);
  return null;
}

function resolvePath(path: string, cwd: string | null, home: string): string {
  let p = path;
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  else if (p.startsWith("$HOME/") || p.startsWith("${HOME}/")) p = home + p.slice(p.indexOf("/"));
  if (isAbsolute(p)) return resolve(p);
  return cwd ? resolve(cwd, p) : p;
}

function samePath(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && resolve(a) === resolve(b);
}
