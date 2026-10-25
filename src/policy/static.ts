import { basename } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { stateFiles } from "../config/paths.ts";

/**
 * The toolkit's static layers (toolkit-enforcement scout, section 2 L3 and L4;
 * ship 2): the same rules as src/policy/toolkit.ts, written in Claude's own
 * settings syntax, for the per-run worker settings and the leader settings.
 * They back the hook up when it cannot run, and a bare MCP server name hides
 * that server's tools from the model (verified live on Claude 2.1.295 in
 * bypassPermissions: claude-in-chrome 22 tools to 0, Atlassian 21 to 0).
 * Pure: the lists come from Flowryn's paths alone.
 */

/** MCP servers the browser, jira, github and sqlite rules deny, by their known names; the hook's patterns catch the rest. */
export const DENIED_MCP_SERVERS = [
  "mcp__claude-in-chrome",
  "mcp__playwright",
  "mcp__plugin_playwright_playwright",
  "mcp__puppeteer",
  "mcp__chrome-devtools",
  "mcp__claude_ai_Atlassian_MCP",
  "mcp__plugin_atlassian_atlassian",
  "mcp__atlassian",
  "mcp__github",
  "mcp__plugin_github_github",
  "mcp__sqlite",
] as const;

/**
 * Bash backstops: plain prefixes only (the hook's normalizer does the rest).
 * `Bash(gh *)` also matches a bare `gh`, and never `gh-axi` (verified live).
 * No blanket sqlite3 deny: q31 allows sqlite3 writes.
 */
export const DENIED_BASH_PREFIXES = [
  "gh",
  "hub",
  "jira",
  "jira-cli",
  "acli jira",
  "git worktree add",
  "git worktree remove",
  "git worktree move",
  "git worktree prune",
] as const;

/** A backstop for the jira rule's Skill check; Claude accepts it without voiding the file (verified live). */
export const DENIED_SKILLS = ["Skill(atlassian:*)"] as const;

export interface StaticPaths {
  /** Flowryn's own backlog and to-do files ([tasks]). */
  backlog: string;
  todos: string;
  /** Flowryn's database. */
  db: string;
}

export interface StaticLayers {
  /** Claude `permissions.deny` entries. */
  permissionsDeny: string[];
  /** Claude `sandbox.filesystem.denyWrite` paths (only when the user's Claude sandbox is on). */
  denyWrite: string[];
}

/** Claude's absolute-path form: `//abs/path` is the path `/abs/path`. */
function absoluteRule(tool: string, path: string): string {
  return `${tool}(/${path})`;
}

export function staticLayers(paths: StaticPaths): StaticLayers {
  return {
    permissionsDeny: [
      ...DENIED_MCP_SERVERS,
      ...DENIED_BASH_PREFIXES.map((prefix) => `Bash(${prefix} *)`),
      `Bash(sqlite3 *${basename(paths.db)}*)`,
      ...DENIED_SKILLS,
      // Edit rules cover every file-editing tool (Edit, Write, MultiEdit, NotebookEdit).
      absoluteRule("Edit", paths.backlog),
      absoluteRule("Edit", paths.todos),
    ],
    denyWrite: [paths.backlog, paths.todos, `${paths.backlog}.lock`, `${paths.todos}.lock`],
  };
}

/** The static layers for a config's own backlog, to-dos and database. */
export function configStaticLayers(config: Pick<FlowrynConfig, "tasks" | "state_dir">): StaticLayers {
  return staticLayers({ backlog: config.tasks.backlog, todos: config.tasks.todos, db: stateFiles(config.state_dir).db });
}

/**
 * The leader's static layers: the toolkit's, plus a deny on writing Claude's own transcripts.
 * A chat-answer grant counts only once the daemon finds your answer in the leader's transcript
 * (src/policy/grants.ts), so the leader must not be able to write one. Only `.jsonl` files: the
 * same directory holds Claude's memory notes, which the leader may keep writing. Bash cannot
 * write there either inside Claude's sandbox, whose write allow-list leaves `~/.claude` out.
 * One settings file serves every leader of the home, so it names every Claude account's folder.
 *
 * With more than one scope (docs/notes/2026-10-24-leader-scoping-and-vj.md) a leader also may not
 * read Flowryn's backlog, to-dos or database: they hold every scope's tasks, and a leader reads its
 * own through the flowryn verbs. The hook's scope-paths rule (src/policy/toolkit.ts) backs this up
 * for the shell and covers the other scope's folders.
 */
export function leaderStaticLayers(config: Pick<FlowrynConfig, "tasks" | "state_dir">, claudeProjectsDirs: string | readonly string[], options: { multiScope?: boolean } = {}): StaticLayers {
  const base = configStaticLayers(config);
  const dirs = [...new Set(typeof claudeProjectsDirs === "string" ? [claudeProjectsDirs] : claudeProjectsDirs)];
  const reads = options.multiScope ? [config.tasks.backlog, config.tasks.todos, stateFiles(config.state_dir).db].map((path) => absoluteRule("Read", path)) : [];
  return { permissionsDeny: [...base.permissionsDeny, ...dirs.map((dir) => absoluteRule("Edit", `${dir}/**/*.jsonl`)), ...reads], denyWrite: base.denyWrite };
}
