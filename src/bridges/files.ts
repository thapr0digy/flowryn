import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { VERSION } from "../version.ts";
import { leaderSettings } from "./claude/settings.ts";
import { SKILL_NAME, skillMarkdown } from "./skill.ts";
// Embedded by `bun build --compile` (a $bunfs path there); the source path in development.
import leaderExtensionAsset from "./pi/flowryn-leader.ts" with { type: "file" };

/**
 * The leader files (design section 15): the Claude settings file, the flowryn
 * skill (as a Claude plugin and as a Pi skill), the Pi leader extension, the
 * terse style block and a `flowryn` command on PATH, all under
 * `<home>/leader/`. `flowryn lead` rewrites them on every launch, so they
 * always match the binary that runs.
 */

export interface LeaderFiles {
  dir: string;
  claudeSettings: string;
  claudePlugin: string;
  piExtension: string;
  skillDir: string;
  /** The style block file, or null when [style] terse = false. */
  style: string | null;
  /** The file the harness appends to its system prompt: the style block and your preferences. */
  appendPrompt: string | null;
  /** A directory holding a `flowryn` command, put first on the leader's PATH. */
  binDir: string;
  /** The absolute flowryn command the hooks and the extension run. */
  bin: string;
}

export interface LeaderFilesInput {
  home: string;
  /** The daemon socket the leader's Bash tool must reach. */
  socket: string;
  /** How to run this flowryn: the compiled binary, or bun plus the entry script. */
  command: string[];
  /** The style block ([style], design section 11), or null when it is off. */
  style: string | null;
}

let extensionSource: string | null = null;

export async function leaderExtensionSource(): Promise<string> {
  if (extensionSource === null) extensionSource = await Bun.file(leaderExtensionAsset as unknown as string).text();
  return extensionSource;
}

function writeIfChanged(path: string, content: string, mode = 0o600): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileAtomic(path, content, mode);
}

export function leaderDir(home: string): string {
  return join(home, "leader");
}

export async function writeLeaderFiles(input: LeaderFilesInput): Promise<LeaderFiles> {
  const dir = leaderDir(input.home);
  ensureDir(dir, 0o700);
  const binDir = join(dir, "bin");
  ensureDir(binDir, 0o700);
  const bin = join(binDir, "flowryn");
  writeIfChanged(bin, `#!/bin/sh\nexec ${input.command.map((c) => JSON.stringify(c)).join(" ")} "$@"\n`, 0o700);

  const claudeSettings = join(dir, "claude-settings.json");
  writeIfChanged(claudeSettings, JSON.stringify(leaderSettings({ bin, socket: input.socket }), null, 2) + "\n");

  const skill = skillMarkdown();
  const skillDir = join(dir, "skills", SKILL_NAME);
  ensureDir(skillDir, 0o700);
  writeIfChanged(join(skillDir, "SKILL.md"), skill);

  const claudePlugin = join(dir, "claude-plugin");
  ensureDir(join(claudePlugin, ".claude-plugin"), 0o700);
  ensureDir(join(claudePlugin, "skills", SKILL_NAME), 0o700);
  writeIfChanged(
    join(claudePlugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "flowryn-leader", version: VERSION, description: "The Flowryn leader skill, loaded only by flowryn lead" }, null, 2) + "\n",
  );
  writeIfChanged(join(claudePlugin, "skills", SKILL_NAME, "SKILL.md"), skill);

  const piExtension = join(dir, "flowryn-leader.ts");
  writeIfChanged(piExtension, await leaderExtensionSource());

  const stylePath = join(dir, "style.md");
  let style: string | null = null;
  if (input.style) {
    writeIfChanged(stylePath, input.style + "\n");
    style = stylePath;
  } else if (existsSync(stylePath)) rmSync(stylePath, { force: true });

  // The user's preferences (cutover C3) are theirs: written by flowryn import or the leader, never by lead.
  const preferencesPath = join(dir, "preferences.md");
  const preferences = existsSync(preferencesPath) ? readFileSync(preferencesPath, "utf8").trimEnd() : null;
  const appendPath = join(dir, "system-prompt.md");
  const parts = [input.style, preferences].filter((p): p is string => typeof p === "string" && p.length > 0);
  let appendPrompt: string | null = null;
  if (parts.length > 0) {
    writeIfChanged(appendPath, parts.join("\n\n") + "\n");
    appendPrompt = appendPath;
  } else if (existsSync(appendPath)) rmSync(appendPath, { force: true });

  return { dir, claudeSettings, claudePlugin, piExtension, skillDir, style, appendPrompt, binDir, bin };
}
