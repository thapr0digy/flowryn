import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributionCheck, attributionChecks, autoFixChecks, globalConfigPath, NM_CLAUDE_SETTINGS_ARGS, readAutoFixCi, type NmProject } from "../../src/doctor/nomistakes.ts";
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
 * doctor warns until its global config passes claude a --settings that hides
 * commit and PR attribution (docs/notes/2026-11-08-never-commit-claude-ks.md).
 */
describe("no-mistakes' PR attribution in doctor", () => {
  const OFF = JSON.stringify({ attribution: { commit: "", pr: "" } });

  test("the advised args are --settings with Flowryn's empty attribution", () => {
    expect([...NM_CLAUDE_SETTINGS_ARGS]).toEqual(["--settings", OFF]);
  });

  test("no config, or one with no claude override, warns with the line to add", () => {
    const absent = attributionCheck("/nm/config.yaml", null);
    expect(absent.status).toBe("warn");
    expect(absent.detail).toContain('writes "Generated with Claude Code" into PR bodies and merge refuses them');
    expect(absent.detail).toContain(`agent_args_override: { claude: ["--settings", '${OFF}'] }`);
    expect(attributionCheck("/nm/config.yaml", GLOBAL_SAMPLE).detail).toStartWith("no-mistakes' claude agent gets no --settings");
  });

  test("the advised line, pasted into the config, passes", () => {
    const advised = attributionCheck("/nm/config.yaml", null).detail.match(/`(agent_args_override: .*?)`/)![1]!;
    expect(attributionCheck("/nm/config.yaml", `${GLOBAL_SAMPLE}${advised}\n`)).toEqual({
      check: "no-mistakes PR attribution",
      status: "ok",
      detail: "/nm/config.yaml passes claude --settings hiding commit and PR attribution",
    });
  });

  test("a block list with other args before --settings passes", () => {
    const block = `agent_args_override:\n  claude:\n    - --model\n    - sonnet\n    - --settings\n    - '${OFF}'\n`;
    expect(attributionCheck("c", block).status).toBe("ok");
  });

  test("attribution left on, a settings file path, bad JSON or bad YAML warns", () => {
    const pr = JSON.stringify({ attribution: { commit: "" } });
    expect(attributionCheck("c", `agent_args_override:\n  claude: ['--settings', '${pr}']\n`).detail).toStartWith('the claude --settings value does not set attribution.commit and attribution.pr to ""');
    expect(attributionCheck("c", "agent_args_override:\n  claude: [--settings, /nm/claude.json]\n").detail).toStartWith("the claude --settings value is not inline JSON");
    expect(attributionCheck("c", "agent_args_override:\n  claude: ['--settings', '{nope']\n").detail).toStartWith("the claude --settings value is not inline JSON");
    expect(attributionCheck("c", "agent_args_override: [unclosed\n").detail).toStartWith("c does not parse as YAML");
  });

  test("one check only when a project delivers through no-mistakes; it never writes the config", () => {
    writeFileSync(globalPath, GLOBAL_SAMPLE);
    expect(attributionChecks([], globalPath)).toEqual([]);
    expect(attributionChecks([project], globalPath)).toHaveLength(1);
    expect(readFileSync(globalPath, "utf8")).toBe(GLOBAL_SAMPLE);
  });
});
