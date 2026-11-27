import { describe, expect, test } from "bun:test";
import { BUILT_IN_LAWS, isReleaseTag, pushedPathsArgv, pushSources } from "../../src/policy/global-laws.ts";
import { shellCommands } from "../../src/policy/shell.ts";
import { TOOLKIT_RULES, toolkitVerdict, type ToolCall, type ToolkitPaths } from "../../src/policy/toolkit.ts";

/** The global laws (src/policy/global-laws.ts) as toolkit rules: each refused shell action, and what stays allowed. */

const PATHS: ToolkitPaths = {
  home: "/Users/u",
  flowrynBacklog: "/Users/u/.flowryn/data/backlog.md",
  flowrynTodos: "/Users/u/.flowryn/data/todos.md",
  flowrynDb: "/Users/u/.flowryn/state/flowryn.db",
  globalLaws: "/Users/u/.flowryn/laws.md",
};

function ruleOf(command: string, over: Partial<ToolCall> = {}, pushed: string[] | null = null): string | null {
  const call: ToolCall = { harness: "claude", role: "worker", toolName: "Bash", toolInput: { command }, cwd: "/work/repo", ...over };
  return toolkitVerdict(call, PATHS, pushed ? { pushedPaths: pushed } : null)?.rule ?? null;
}

describe("the built-in global laws", () => {
  test("each names a toolkit rule, so verify can confirm its enforcer", () => {
    for (const law of BUILT_IN_LAWS) expect(TOOLKIT_RULES as readonly string[]).toContain(law.hook);
  });
});

describe("rebase: history is never rewritten", () => {
  test.each(["git rebase main", "git rebase -i HEAD~3", "git -C ../x rebase origin/main", "git rebase --continue", "git pull --rebase", "git pull -r origin main", "git pull --rebase=merges", "cd x && git rebase main"])("denied: %s", (command) => {
    expect(ruleOf(command)).toBe("rebase");
    expect(ruleOf(command, { role: "leader" })).toBe("rebase");
  });
  test.each(["git rebase --abort", "git rebase --quit", "git pull", "git pull --no-rebase", "git merge origin/main", "git log --grep rebase"])("allowed: %s", (command) => {
    expect(ruleOf(command)).toBeNull();
  });
  test("the reason says how to take the base in", () => {
    const verdict = toolkitVerdict({ harness: "claude", role: "worker", toolName: "Bash", toolInput: { command: "git rebase main" }, cwd: "/r" }, PATHS);
    expect(verdict?.reason).toContain("toolkit rule (rebase)");
    expect(verdict?.reason).toContain("git merge origin/<base>");
  });
});

describe("force-push", () => {
  test.each(["git push --force", "git push -f origin x", "git push origin x -fu", "git push --force-with-lease", "git push --force-with-lease=main:abc", "git push --force-if-includes", "git push origin +main", "git push origin +HEAD:refs/heads/x", "git push --mirror"])("denied: %s", (command) => {
    expect(ruleOf(command)).toBe("force-push");
  });
  test.each(["git push", "git push origin HEAD", "git push origin x:y", "git push --follow-tags"])("allowed: %s", (command) => {
    expect(ruleOf(command)).toBeNull();
  });
});

describe("tags: never moved or reused, always vMAJOR.MINOR.PATCH", () => {
  test.each([
    "git tag v1.2",
    "git tag 1.2.0",
    "git tag -a v1.2 -m 'release'",
    "git tag -f v1.2.0",
    "git tag -d v1.2.0",
    "git tag --delete v1.2.0",
    "git push --delete origin v1.2.0",
    "git push origin :refs/tags/v1.2.0",
    "git push origin :v1.2.0",
    "gh-axi release create v0.5",
  ])("denied: %s", (command) => {
    expect(ruleOf(command, { role: "leader" })).toBe("tags");
  });
  test.each(["git tag v1.2.0", "git tag -a v1.2.0 -m 'v1.2 release'", "git tag -m 'x' v2.0.0-rc.1", "git tag", "git tag -l", "git tag --list 'v1.*'", "git tag -n5", "git tag --sort=-v:refname", "git tag --contains abc", "git push --delete origin flowryn/old-branch", "gh-axi release create v0.5.1 --notes x", "git push origin v1.2.0"])("allowed: %s", (command) => {
    expect(ruleOf(command, { role: "leader" })).toBeNull();
  });
  test("isReleaseTag", () => {
    for (const tag of ["v0.1.0", "v10.20.30", "v1.5.0-rc.1", "v1.5.0+build.42"]) expect(isReleaseTag(tag)).toBe(true);
    for (const tag of ["v1.2", "1.2.0", "v01.2.0", "V1.2.0", "v1.2.0.4", "release"]) expect(isReleaseTag(tag)).toBe(false);
  });
});

describe("remember-push: a push never carries .remember/", () => {
  test("a push whose commits touch .remember/ is denied; one that does not is allowed", () => {
    expect(ruleOf("git push origin HEAD", {}, ["src/a.ts", ".remember/now.md"])).toBe("remember-push");
    expect(ruleOf("git push", { role: "leader" }, ["sub/.remember/today.md"])).toBe("remember-push");
    expect(ruleOf("git push origin HEAD", {}, ["src/a.ts", "docs/remember.md"])).toBeNull();
    // Without facts (the read failed or the line pushes nothing) nothing is assumed.
    expect(ruleOf("git push origin HEAD")).toBeNull();
    expect(ruleOf("git status", {}, [".remember/now.md"])).toBeNull();
  });

  test("pushSources: each push's folder and the revisions it sends", () => {
    const at = (line: string) => pushSources(shellCommands(line), "/work/repo", "/Users/u");
    expect(at("git push")).toEqual([{ dir: "/work/repo", revs: ["HEAD"] }]);
    expect(at("cd ../other && git push origin feature +main:main HEAD:refs/heads/x")).toEqual([{ dir: "/work/other", revs: ["feature", "main", "HEAD"] }]);
    expect(at("git -C ~/proj push --all")).toEqual([{ dir: "/Users/u/proj", revs: ["--branches"] }]);
    expect(at("git push origin main --tags")).toEqual([{ dir: "/work/repo", revs: ["main", "--tags"] }]);
    expect(at("git push --dry-run origin x; git push -d origin x; git push origin :x")).toEqual([{ dir: "/work/repo", revs: ["HEAD"] }]);
    // A revision that would read as an option never reaches git.
    expect(at("git push origin -- --output=/tmp/x")).toEqual([{ dir: "/work/repo", revs: ["HEAD"] }]);
    expect(pushedPathsArgv({ dir: "/r", revs: ["HEAD"] })).toEqual(["git", "-C", "/r", "log", "--format=", "--name-only", "--no-renames", "HEAD", "--not", "--remotes", "--"]);
  });
});

describe("dev-port: a worker never binds 8081", () => {
  test.each([
    "bun run dev --port 8081",
    "vite --port=8081",
    "PORT=8081 make dev",
    "SIGNAL_PORT=8081 go run ./cmd/signal",
    "LISTEN_ADDR=0.0.0.0:8081 ./bin/server",
    "./bin/server -addr 127.0.0.1:8081",
    "python3 -m http.server --bind 0.0.0.0 8081",
    "docker run -p 8081:80 nginx",
    "docker run --publish=127.0.0.1:8081:80 nginx",
    "go run . :8081",
  ])("denied for a worker: %s", (command) => {
    expect(ruleOf(command)).toBe("dev-port");
  });
  test.each(["curl http://127.0.0.1:8081/health", "curl -s localhost:8081", "chrome-devtools-axi open http://localhost:8081", "lsof -i :8081", "bun run dev --port 8082", "PORT=18081 make dev", "docker run -p 18081:80 nginx", "echo 8081", "grep -l 8081 Makefile", "rg -n ':8081' src", "BASE_URL=localhost:8081 bun test"])("allowed: %s", (command) => {
    expect(ruleOf(command)).toBeNull();
  });
  test("the leader is not a worker: the law is the workers'", () => {
    expect(ruleOf("PORT=8081 make dev", { role: "leader" })).toBeNull();
  });
});

describe("laws-file: the global laws file is the user's", () => {
  test("an edit or a shell write of it is denied, for a worker and a leader", () => {
    const edit = (role: "worker" | "leader") => toolkitVerdict({ harness: "claude", role, toolName: "Edit", toolInput: { file_path: "/Users/u/.flowryn/laws.md" }, cwd: "/r" }, PATHS)?.rule;
    expect(edit("worker")).toBe("laws-file");
    expect(edit("leader")).toBe("laws-file");
    expect(ruleOf("echo '| x | y | z |' >> ~/.flowryn/laws.md", { role: "leader" })).toBe("laws-file");
    expect(ruleOf("cat ~/.flowryn/laws.md")).toBeNull();
  });
});
