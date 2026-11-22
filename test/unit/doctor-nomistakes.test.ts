import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributionCheck, attributionChecks, autoFixChecks, globalConfigPath, NM_CLAUDE_SETTINGS_ARGS, readAutoFixCi, userClaudeSettingsPath, type NmProject } from "../../src/doctor/nomistakes.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { GIT_ENV, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * `flowryn doctor` warns when no-mistakes' CI monitor would rebase and
 * force-push a conflicting PR (an effective `auto_fix.ci` above 0) while the
 * conflict nudge is on. Fixtures: a global config in a scratch NM_HOME and a
 * repo whose default branch carries (or not) a `.no-mistakes.yaml`.
 */

let dir: string;
let globalPath: string;
let project: NmProject;
let primary: string;
let other: string;
const git = gitRunner("git", 10_000, GIT_ENV);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-doctor-nm-"));
  mkdirSync(join(dir, "nm-home"));
  globalPath = globalConfigPath({ NM_HOME: join(dir, "nm-home") });
  ({ primary, other } = scratchRepos(dir));
  project = { id: "web", path: primary, default_branch: "main" };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Commit `.no-mistakes.yaml` on origin's main (from the other clone) and fetch it into the project. */
function repoConfig(text: string): void {
  writeFileSync(join(other, ".no-mistakes.yaml"), text);
  sh(other, ["add", "."]);
  sh(other, ["commit", "-q", "-m", "no-mistakes config"]);
  sh(other, ["push", "-q", "origin", "main"]);
  sh(primary, ["fetch", "-q", "origin"]);
}

const GLOBAL_SAMPLE = "auto_fix:\n  rebase: 3\n  lint: 3\n  test: 3\n  review: 0\n  document: 3\n  ci: 3\n";

describe("no-mistakes' auto_fix.ci in doctor", () => {
  test("the global 3 with no repo override warns, naming where it came from and the line to add", async () => {
    writeFileSync(globalPath, GLOBAL_SAMPLE);
    const [check] = await autoFixChecks(true, [project], globalPath, git);
    expect(check).toEqual({
      check: "no-mistakes auto_fix.ci (web)",
      status: "warn",
      detail: `3 (from ${globalPath}) while [upkeep] nudge_conflicts is on: no-mistakes' CI monitor rebases and force-pushes a PR that conflicts, racing the nudge; add \`auto_fix: { ci: 0 }\` to .no-mistakes.yaml on main`,
    });
  });

  test("the repo's ci: 0 on origin's default branch overrides the global 3", async () => {
    writeFileSync(globalPath, GLOBAL_SAMPLE);
    repoConfig("no_ci: true\nauto_fix:\n  ci: 0\nrebase:\n  strategy: merge\n");
    const [check] = await autoFixChecks(true, [project], globalPath, git);
    expect(check).toMatchObject({ status: "ok", detail: "0 (from .no-mistakes.yaml on origin/main): a conflicting PR parks for the conflict nudge" });
  });

  test("a repo value above 0 overrides a global 0, and the line says to change it", async () => {
    writeFileSync(globalPath, "auto_fix:\n  ci: 0\n");
    repoConfig("auto_fix: { ci: 2 }\n");
    const [check] = await autoFixChecks(true, [project], globalPath, git);
    expect(check!.status).toBe("warn");
    expect(check!.detail).toStartWith("2 (from .no-mistakes.yaml on origin/main)");
    expect(check!.detail).toEndWith("set `ci: 0` under auto_fix in .no-mistakes.yaml on main");
  });

  test("neither file sets it: no-mistakes' default of 3 warns", async () => {
    repoConfig("no_ci: true\n");
    const [check] = await autoFixChecks(true, [project], globalPath, git);
    expect(check!.status).toBe("warn");
    expect(check!.detail).toStartWith(`3 (from no-mistakes' default; neither .no-mistakes.yaml on origin/main nor ${globalPath} sets it)`);
  });

  test("a file that does not parse, or a value that is not a whole number, warns that the value is unknown", async () => {
    writeFileSync(globalPath, "auto_fix: [unclosed\n");
    const [broken] = await autoFixChecks(true, [project], globalPath, git);
    expect(broken!.status).toBe("warn");
    expect(broken!.detail).toContain(`${globalPath} does not parse as YAML`);
    expect(readAutoFixCi("f", "auto_fix:\n  ci: lots\n")).toEqual({ where: "f", state: "invalid", detail: 'auto_fix.ci is "lots", not a whole number' });
  });

  test("nothing with the nudge off or no no-mistakes project; it never writes the user's config", async () => {
    writeFileSync(globalPath, GLOBAL_SAMPLE);
    expect(await autoFixChecks(false, [project], globalPath, git)).toEqual([]);
    expect(await autoFixChecks(true, [], globalPath, git)).toEqual([]);
    await autoFixChecks(true, [project], globalPath, git);
    expect(readFileSync(globalPath, "utf8")).toBe(GLOBAL_SAMPLE);
  });

  test("a checkout with no default branch to read says so", async () => {
    const [check] = await autoFixChecks(true, [{ ...project, default_branch: "trunk" }], globalPath, git);
    expect(check!.status).toBe("warn");
    expect(check!.detail).toContain("has no trunk or origin/trunk to read .no-mistakes.yaml from");
  });

  test("the global config is $NM_HOME/config.yaml, else ~/.no-mistakes/config.yaml", () => {
    expect(globalConfigPath({ NM_HOME: "/x/nm" })).toBe("/x/nm/config.yaml");
    expect(globalConfigPath({ HOME: "/home/u" })).toBe("/home/u/.no-mistakes/config.yaml");
  });
});

/**
 * no-mistakes' PR step runs `claude -p` with the operator's settings only, so
 * doctor warns until the user's Claude settings or an inline --settings in
 * no-mistakes' global config hide PR attribution
 * (docs/notes/2026-11-08-never-commit-claude-ks.md).
 */
const OFF = JSON.stringify({ attribution: { commit: "", pr: "" } });
const ON = JSON.stringify({ attribution: { pr: "made by a bot" } });
const NM = "/nm/config.yaml";
const USER = "/home/u/.claude/settings.json";
const check = (nm: string | null, user: string | null) => attributionCheck({ where: NM, text: nm }, { where: USER, text: user });
const override = (json: string) => `agent_args_override:\n  claude: ['--settings', '${json}']\n`;

describe("no-mistakes' PR attribution in doctor", () => {

  test("the advised args are --settings with Flowryn's empty attribution", () => {
    expect([...NM_CLAUDE_SETTINGS_ARGS]).toEqual(["--settings", OFF]);
  });

  test("the user's settings with attribution.pr \"\" pass with no override (this machine's setup)", () => {
    expect(check(GLOBAL_SAMPLE, JSON.stringify({ model: "opus", attribution: { commit: "", pr: "", sessionUrl: false } }))).toEqual({
      check: "no-mistakes PR attribution",
      status: "ok",
      detail: `${USER} hides PR attribution for no-mistakes' claude agent`,
    });
    expect(check(null, OFF).status).toBe("ok");
  });

  test("neither file hiding it warns with both fixes", () => {
    const absent = check(null, null);
    expect(absent.status).toBe("warn");
    expect(absent.detail).toStartWith(`neither ${USER} nor a claude --settings in ${NM} sets attribution.pr`);
    expect(absent.detail).toContain('writes "Generated with Claude Code" into PR bodies and merge refuses them');
    expect(absent.detail).toContain(`set "attribution": {"commit": "", "pr": ""} in ${USER}`);
    expect(absent.detail).toContain(`agent_args_override: { claude: ["--settings", '${OFF}'] }`);
    expect(check(GLOBAL_SAMPLE, ON).detail).toStartWith(`${USER} sets attribution.pr to "made by a bot"`);
    expect(check(GLOBAL_SAMPLE, "{not json").status).toBe("warn");
  });

  test("the advised override line, pasted into the config, passes whatever the user's settings say", () => {
    const advised = check(null, null).detail.match(/`(agent_args_override: .*?)`/)![1]!;
    expect(check(`${GLOBAL_SAMPLE}${advised}\n`, ON)).toEqual({
      check: "no-mistakes PR attribution",
      status: "ok",
      detail: `${NM} passes claude --settings hiding PR attribution`,
    });
    const block = `agent_args_override:\n  claude:\n    - --model\n    - sonnet\n    - --settings\n    - '${OFF}'\n`;
    expect(check(block, null).status).toBe("ok");
  });

  test("an override outranks the user's settings: one that turns PR attribution on warns", () => {
    expect(check(override(ON), OFF).detail).toStartWith(`the claude --settings value in ${NM} sets attribution.pr to "made by a bot"`);
    expect(check(override(JSON.stringify({ model: "sonnet" })), OFF).status).toBe("ok");
  });

  test("a settings file path, bad JSON or bad YAML in the config warns", () => {
    expect(check("agent_args_override:\n  claude: [--settings, /nm/claude.json]\n", OFF).detail).toStartWith(`the claude --settings value in ${NM} is not inline JSON`);
    expect(check(override("{nope"), OFF).detail).toStartWith(`the claude --settings value in ${NM} is not inline JSON`);
    expect(check("agent_args_override: [unclosed\n", OFF).detail).toStartWith(`${NM} does not parse as YAML`);
  });

  test("one check only when a project delivers through no-mistakes; it never writes either file", () => {
    const userPath = join(dir, "settings.json");
    writeFileSync(globalPath, GLOBAL_SAMPLE);
    writeFileSync(userPath, OFF);
    expect(attributionChecks([], globalPath, userPath)).toEqual([]);
    expect(attributionChecks([project], globalPath, userPath)).toMatchObject([{ status: "ok" }]);
    expect(readFileSync(globalPath, "utf8")).toBe(GLOBAL_SAMPLE);
    expect(readFileSync(userPath, "utf8")).toBe(OFF);
  });

  test("the user's Claude settings are $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json", () => {
    expect(userClaudeSettingsPath({ CLAUDE_CONFIG_DIR: "/x/cc", HOME: "/home/u" })).toBe("/x/cc/settings.json");
    expect(userClaudeSettingsPath({ HOME: "/home/u" })).toBe("/home/u/.claude/settings.json");
  });
});
