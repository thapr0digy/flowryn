import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLeaderFiles } from "../../src/bridges/files.ts";
import { leaderSettings } from "../../src/bridges/claude/settings.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import type { CommitInfo } from "../../src/forge/types.ts";
import { aiAttributionLines, findAiAttribution } from "../../src/policy/ai-attribution.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { branchCommits, checkAiAttribution, type MergeFacts } from "../../src/policy/merge.ts";
import { configStaticLayers } from "../../src/policy/static.ts";

/** docs/notes/2026-11-08-never-commit-claude-ks.md: settings, the matcher and the merge gate step. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-ai-attr-"));
  dirs.push(dir);
  return dir;
}

function commit(sha: string, message: string, authorEmail = "dev@example.com", committerEmail = authorEmail): CommitInfo {
  return { sha, message, authorEmail, committerEmail };
}

describe("the AI attribution matcher", () => {
  test.each([
    ["Claude's own trailer", "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>"],
    ["upper case, no space after the colon", "CO-AUTHORED-BY:claude"],
    ["spaces before the colon, any name at Anthropic's address", "  co-authored-by :  Someone <NoReply@Anthropic.COM>"],
    ["a tab separator", "Co-authored-by:\tClaude Sonnet 5.5 <noreply@anthropic.com>"],
    ["the Claude Code PR line with emoji and link", "🤖 Generated with [Claude Code](https://claude.com/claude-code)"],
    ["the plain Claude Code line", "generated WITH claude code"],
  ])("matches %s", (_name, line) => {
    // A quoted line's control characters (a tab included) read as spaces.
    expect(aiAttributionLines(`fix: a thing\n\nbody\r\n${line}\r\n`)).toEqual([line.trim().replace(/\t/g, " ")]);
  });

  test.each([
    ["the Claude-Session link", "Claude-Session: https://claude.ai/code/session_01abc"],
    ["a human co-author", "Co-authored-by: Ada Lovelace <ada@example.com>"],
    ["a co-author whose name only contains claude", "Co-authored-by: Claudette Colvert <cc@example.com>"],
    ["prose about Claude", "Claude helped find this bug; generated with care"],
    ["co-authored-by mid-sentence", "This was co-authored-by: Claude in spirit only"],
    ["Generated with Claude, not Claude Code", "Generated with Claude's help"],
  ])("does not match %s", (_name, line) => {
    expect(aiAttributionLines(line)).toEqual([]);
  });

  test("a commit authored or committed by Anthropic's address is a hit; the PR body counts after the commits", () => {
    const hits = findAiAttribution(
      [commit("a".repeat(40), "clean"), commit("b".repeat(40), "clean", "NoReply@anthropic.com"), commit("c".repeat(40), "clean", "dev@x", "noreply@anthropic.com")],
      "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    );
    expect(hits.map((h) => [h.sha?.[0] ?? null, h.line])).toEqual([
      ["b", "author noreply@anthropic.com"],
      ["c", "committer noreply@anthropic.com"],
      [null, "🤖 Generated with [Claude Code](https://claude.com/claude-code)"],
    ]);
  });

  test("a quoted line has its control characters dropped and is cut short", () => {
    const [line] = aiAttributionLines(`Co-authored-by: Claude \u001b[31m${"x".repeat(300)}`);
    expect(line).not.toContain("\u001b");
    expect(line!.length).toBeLessThanOrEqual(120);
  });
});

function facts(over: Partial<MergeFacts>): MergeFacts {
  return {
    run: { task_id: "ship-x-ab" },
    project: { default_branch: "main" },
    ref: "https://github.com/acme/web/pull/7",
    pr: { baseRef: "main", body: null },
    ...over,
  } as unknown as MergeFacts;
}

function refusal(f: MergeFacts): FlowrynError {
  try {
    checkAiAttribution(f);
  } catch (error) {
    return error as FlowrynError;
  }
  throw new Error("expected a refusal");
}

describe("the merge gate's AI attribution step", () => {
  test("a commit with the trailer is refused, naming the commit and the fresh-branch fix without a force-push", () => {
    const error = refusal(facts({ commits: [commit("1234567890abcdef", "fix\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>")] }));
    expect(error.code).toBe("ai_attribution");
    expect(error.message).toContain("1 commit (12345678)");
    expect(error.message).toContain("Co-authored-by: Claude Opus 5.5");
    expect(error.help).toContain("never force-pushed");
    expect(error.help).toContain("branch afresh from origin/main");
    expect(error.help).toContain("flowryn steer ship-x-ab");
  });

  test("a local delivery's refusal names a fresh branch from the default branch, not a PR", () => {
    const error = refusal(facts({ pr: null, ref: "local:flowryn/x", commits: [commit("1".repeat(40), "Co-authored-by: Claude")] }));
    expect(error.help).toContain("branch afresh from main");
    expect(error.help).toContain("deliver that branch instead");
    expect(error.help).not.toContain("PR");
  });

  test("a PR body hit alone asks for the description to be edited", () => {
    const error = refusal(facts({ commits: [commit("1".repeat(40), "clean")], pr: { baseRef: "main", body: "Generated with Claude Code" } as never }));
    expect(error.message).toContain("the PR body");
    expect(error.help).toContain("edit the PR description");
  });

  test("commits that could not be listed refuse; clean commits and an already-merged PR (no list) pass", () => {
    expect(refusal(facts({ commits: null })).message).toContain("cannot list the commits");
    expect(() => checkAiAttribution(facts({ commits: [commit("1".repeat(40), "fix: x\n\nClaude-Session: https://claude.ai/code/s")] }))).not.toThrow();
    expect(() => checkAiAttribution(facts({}))).not.toThrow();
  });

  test("more than three hits are summarised", () => {
    const commits = ["a", "b", "c", "d"].map((c) => commit(c.repeat(40), "Co-authored-by: Claude"));
    expect(refusal(facts({ commits })).message).toContain("(+1 more)");
  });
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

describe("a local delivery's commits", () => {
  test("assumption: git lists the branch's commits past the default branch with their messages and emails", async () => {
    const repo = scratch();
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
    git(repo, ["checkout", "-q", "-b", "work"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "one\n\nCo-authored-by: Claude <noreply@anthropic.com>"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "two"], { GIT_AUTHOR_EMAIL: "noreply@anthropic.com" });
    const head = git(repo, ["rev-parse", "HEAD"]);
    const commits = await branchCommits(gitRunner("git"), repo, "main", head);
    expect(commits!.map((c) => [c.message.trim(), c.authorEmail])).toEqual([
      ["one\n\nCo-authored-by: Claude <noreply@anthropic.com>", "t@t"],
      ["two", "noreply@anthropic.com"],
    ]);
    expect(commits![1]!.sha).toBe(head);
    expect(findAiAttribution(commits!, null)).toHaveLength(2);
  });

  test("a default branch git cannot resolve reads null (the gate refuses), never an empty list", async () => {
    const repo = scratch();
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
    expect(await branchCommits(gitRunner("git"), repo, "trunk", git(repo, ["rev-parse", "HEAD"]))).toBeNull();
  });
});

describe("the leader settings", () => {
  test("turn Claude's commit and PR attribution off, in the built settings and the written file", async () => {
    const home = scratch();
    const toolkit = configStaticLayers(defaultConfig(home));
    expect(leaderSettings({ bin: "/bin/flowryn", socket: "/s", toolkit }).attribution).toEqual({ commit: "", pr: "" });
    const files = await writeLeaderFiles({ home, command: ["flowryn"], socket: join(home, "s"), style: null, toolkit });
    expect(JSON.parse(readFileSync(files.claudeSettings, "utf8")).attribution).toEqual({ commit: "", pr: "" });
  });
});
