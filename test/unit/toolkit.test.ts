import { describe, expect, test } from "bun:test";
import { shellCommands } from "../../src/policy/shell.ts";
import { toolkitVerdict, type ToolCall, type ToolkitPaths } from "../../src/policy/toolkit.ts";

const PATHS: ToolkitPaths = {
  home: "/Users/u",
  flowrynBacklog: "/Users/u/.flowryn/data/backlog.md",
  flowrynTodos: "/Users/u/.flowryn/data/todos.md",
  flowrynDb: "/Users/u/.flowryn/state/flowryn.db",
};

function call(toolName: string, toolInput: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall {
  return { harness: "claude", role: "worker", toolName, toolInput, cwd: "/work/repo", ...over };
}

function bash(command: string, over: Partial<ToolCall> = {}) {
  return toolkitVerdict(call("Bash", { command }, over), PATHS);
}

function ruleOf(command: string, over: Partial<ToolCall> = {}): string | null {
  return bash(command, over)?.rule ?? null;
}

function names(line: string): string[] {
  return shellCommands(line).map((c) => c.name);
}

describe("shell normalizer: what the rules see", () => {
  test("a substitution inside an unquoted ${…} parameter is read as a command", () => {
    expect(names("echo ${x:-$(gh pr list)}")).toContain("gh");
    expect(ruleOf("echo ${x:-$(gh pr list)}")).toBe("github");
    expect(ruleOf("x=${y:-`sqlite3 app.db .dump`}")).toBe("sqlite");
    expect(ruleOf("echo ${a:-${b:-$(gh api user)}}")).toBe("github");
  });

  test.each([
    ["plain", "gh pr list", ["gh"]],
    ["chained", "cd x && gh pr list; ls", ["cd", "gh", "ls"]],
    ["piped", "echo x | gh api -", ["echo", "gh"]],
    ["or and background", "false || gh pr list & wait", ["false", "gh", "wait"]],
    ["newline", "ls\ngh pr list", ["ls", "gh"]],
    ["$() substitution", "echo $(gh pr list)", ["echo", "gh"]],
    ["backticks", "echo `gh pr list`", ["echo", "gh"]],
    ["substitution in double quotes", 'echo "$(gh pr list)"', ["echo", "gh"]],
    ["process substitution", "diff <(gh pr diff 1) x", ["diff", "gh"]],
    ["subshell and group", "(gh pr list); { gh pr view; }", ["gh", "gh"]],
    ["backslash-newline continuation", "g\\\nh pr list", ["gh"]],
    ["absolute path", "/opt/homebrew/bin/gh pr list", ["gh"]],
    ["relative path", "./bin/gh pr list", ["gh"]],
    ["assignment prefix", "FOO=1 BAR=2 gh pr list", ["gh"]],
    ["command", "command gh pr list", ["gh"]],
    ["builtin", "builtin gh", ["gh"]],
    ["exec", "exec gh pr list", ["gh"]],
    ["env", "env gh pr list", ["gh"]],
    ["env -i with assignment", "env -i FOO=1 gh pr list", ["gh"]],
    ["env -u", "env -u HOME gh pr list", ["gh"]],
    ["env -S", "env -S 'gh pr list'", ["gh"]],
    ["nice", "nice -n 5 gh pr list", ["gh"]],
    ["nohup", "nohup gh pr list", ["gh"]],
    ["time", "time -p gh pr list", ["gh"]],
    ["timeout", "timeout 5 gh pr list", ["gh"]],
    ["timeout with signal", "timeout -s KILL 5 gh pr list", ["gh"]],
    ["sudo", "sudo -u bob gh pr list", ["gh"]],
    ["stdbuf", "stdbuf -oL gh pr list", ["gh"]],
    ["xargs", "echo 1 | xargs -I {} gh pr view {}", ["echo", "gh"]],
    ["xargs -n", "echo 1 | xargs -n 1 gh pr view", ["echo", "gh"]],
    ["bash -c", "bash -c 'gh pr list'", ["bash", "gh"]],
    ["sh -ec", 'sh -ec "gh pr list"', ["sh", "gh"]],
    ["zsh -lc", "zsh -lc 'cd x && gh pr list'", ["zsh", "cd", "gh"]],
    ["eval", "eval 'gh pr list'", ["eval", "gh"]],
    ["nested wrappers", "sudo env FOO=1 timeout 5 nohup gh pr list", ["gh"]],
    ["npx", "npx -y playwright codegen", ["playwright"]],
    ["npx with version", "npx chrome-devtools-mcp@latest", ["chrome-devtools-mcp"]],
    ["npx scoped", "npx @playwright/mcp@1.2", ["@playwright/mcp"]],
    ["npx -p", "npx -p playwright playwright open", ["playwright"]],
    ["bunx", "bunx playwright open", ["playwright"]],
    ["pnpm dlx", "pnpm dlx playwright open", ["playwright"]],
    ["yarn dlx", "yarn dlx playwright open", ["playwright"]],
    ["npm exec", "npm exec -- playwright open", ["playwright"]],
    ["keywords", "if true; then gh pr list; fi", ["true", "gh"]],
    ["comment", "ls # gh pr list", ["ls"]],
    ["quoted text is not a command", "echo 'gh pr list'", ["echo"]],
  ])("%s", (_name, line, expected) => {
    expect(names(line)).toEqual(expected);
  });

  test("command -v looks a command up without running it", () => {
    expect(ruleOf("command -v gh")).toBeNull();
  });

  test("redirections, heredocs and here-strings", () => {
    const [c] = shellCommands("cat <<EOF > backlog.md 2>&1\nline one\nEOF");
    expect(c!.redirects).toEqual([{ op: ">", target: "backlog.md" }]);
    expect(c!.stdin).toBe("line one");
    expect(shellCommands("sqlite3 x.db <<< 'select 1'")[0]!.stdin).toBe("select 1");
    expect(shellCommands("echo x>backlog.md")[0]!.redirects).toEqual([{ op: ">", target: "backlog.md" }]);
  });

  test("never throws on junk, and depth is capped", () => {
    const junk = ["'", '"', "$(", "`", "<<", "(((", ")))", "\\", "$'", "a\u0000b", "<(", "${", "&&&&", "|||"];
    for (const j of junk) expect(() => shellCommands(j)).not.toThrow();
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: 40 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join("");
      expect(() => toolkitVerdict(call("Bash", { command: s }), PATHS)).not.toThrow();
    }
    let deep = "gh pr list";
    for (let i = 0; i < 10; i++) deep = `bash -c ${JSON.stringify(deep)}`;
    expect(() => shellCommands(deep)).not.toThrow();
  });
});

describe("rule: github", () => {
  test.each(["gh pr list", "/usr/local/bin/gh api user", "hub pr list", "FOO=1 gh pr list", "env gh pr list", "xargs gh pr view", "bash -c 'gh pr list'", "curl https://api.github.com/repos/o/r", "curl -H 'x: y' api.github.com/user", "wget https://uploads.github.com/x", "http GET api.github.com/user", "curl --url=https://api.github.com/user"])("denies %s", (cmd) => {
    const v = bash(cmd);
    expect(v?.rule).toBe("github");
    expect(v?.tool).toBe("gh-axi");
    expect(v?.reason).toContain("gh-axi");
  });

  test.each(["gh-axi pr list", "git push origin HEAD", "git fetch", "git clone https://github.com/o/r", "curl https://raw.githubusercontent.com/o/r/main/x", "echo gh", "ls ~/gh"])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });

  test("a GitHub MCP tool", () => {
    expect(toolkitVerdict(call("mcp__github__create_issue", {}), PATHS)?.rule).toBe("github");
  });
});

describe("rule: sqlite (deny reads only; q31)", () => {
  test.each([
    "sqlite3 app.db 'select * from users'",
    "sqlite3 app.db .tables",
    "sqlite3 app.db .schema",
    "sqlite3 -readonly app.db 'insert into t values (1)'",
    "echo 'select 1' | sqlite3 app.db",
    "printf 'select 1' | sqlite3 app.db",
    "cat <<EOF | sqlite3 app.db\nSELECT 1;\nEOF",
    "cat <<< 'select 1' | sqlite3 app.db",
    "ls | sqlite3 app.db 'select * from t'",
    "true | sqlite3 app.db -cmd 'select 1'",
    "sqlite3 app.db 'select 1' < seed.sql",
    "cat q.sql | sqlite3 -readonly app.db",
    "sqlite3 -readonly app.db < q.sql",
    "sqlite3 app.db <<EOF\nSELECT 1;\nEOF",
    "sqlite3 app.db",
    "litecli app.db",
    "sqlite3 -cmd 'pragma table_info(t)' app.db",
  ])("denies the read %s", (cmd) => {
    const v = bash(cmd);
    expect(v?.rule).toBe("sqlite");
    expect(v?.reason).toContain("sqlite-axi");
  });

  test.each([
    "sqlite3 app.db 'insert into t values (1)'",
    "sqlite3 app.db 'CREATE TABLE t (x)'",
    "sqlite3 app.db < seed.sql",
    "cat migrate.sql | sqlite3 app.db",
    "gunzip -c dump.sql.gz | sqlite3 app.db",
    "true | sqlite3 app.db 'insert into t values (1)'",
    "sqlite3 app.db <<EOF\nUPDATE t SET x = 1;\nEOF",
    "sqlite3 -version",
    "sqlite-axi query app.db 'select 1'",
  ])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });

  test("Flowryn's flowryn.db is denied even for a write", () => {
    const v = bash("sqlite3 ~/.flowryn/state/flowryn.db 'delete from runs'");
    expect(v?.rule).toBe("sqlite");
    expect(v?.reason).toContain("flowryn.db");
    expect(ruleOf("sqlite3 flowryn.db 'update runs set state=1'", { cwd: "/Users/u/.flowryn/state" })).toBe("sqlite");
  });

  test("a SQLite MCP tool", () => {
    expect(toolkitVerdict(call("mcp__sqlite__query", {}), PATHS)?.rule).toBe("sqlite");
  });
});

describe("rule: worktree", () => {
  test.each(["git worktree add ../x -b y", "git worktree remove ../x", "git worktree prune", "git worktree move a b", "git -C repo worktree add x", "git -c core.x=y worktree add x", "git --git-dir .git worktree remove x", "/usr/bin/git worktree add x"])("denies %s", (cmd) => {
    const v = bash(cmd);
    expect(v?.rule).toBe("worktree");
    expect(v?.reason).toContain("treehouse");
  });

  test.each(["git worktree list", "git status", "treehouse get --lease --json", "git log -- worktree"])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });
});

describe("rule: jira", () => {
  test.each(["curl https://acme.atlassian.net/rest/api/3/issue/X-1", "curl -u a:b acme.atlassian.net/wiki", "curl https://jira.acme.com/rest/api/2/search", "curl https://jira.acme.com/rest/agile/1.0/board", "jira issue list", "acli jira workitem view X-1"])("denies %s", (cmd) => {
    const v = bash(cmd);
    expect(v?.rule).toBe("jira");
    expect(v?.reason).toContain("jira-axi");
  });

  test.each(["jira-axi issue view X-1", "curl http://localhost:3000/rest/api/users", "acli --help"])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });

  test("the Atlassian MCP tools and skills", () => {
    for (const name of ["mcp__claude_ai_Atlassian_MCP__getJiraIssue", "mcp__plugin_atlassian_atlassian__search", "mcp__atlassian__x"]) {
      expect(toolkitVerdict(call(name, {}), PATHS)?.rule).toBe("jira");
    }
    expect(toolkitVerdict(call("Skill", { skill: "atlassian:triage-issue" }), PATHS)?.rule).toBe("jira");
    expect(toolkitVerdict(call("Skill", { skill: "gh-axi" }), PATHS)).toBeNull();
  });
});

describe("rule: browser", () => {
  test.each([
    "npx playwright codegen https://x",
    "npx -y playwright open x",
    "npx @playwright/mcp@latest",
    "npx chrome-devtools-mcp@latest",
    "chrome-devtools-mcp",
    "node -e \"require('puppeteer').launch()\"",
    "bun -e 'import { chromium } from \"playwright\"'",
    "python3 -c 'from playwright.sync_api import sync_playwright'",
    "python -m playwright codegen",
    "google-chrome --headless --dump-dom https://x",
    "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222",
    "chromium --headless=new x",
  ])("denies %s", (cmd) => {
    const v = bash(cmd);
    expect(v?.rule).toBe("browser");
    expect(v?.reason).toContain("chrome-devtools-axi");
  });

  test.each(["npx playwright test", "bunx playwright test --project chromium", "npx playwright show-report", "npx playwright install chromium", "npx playwright --version", "bun test", "chrome-devtools-axi open https://x", "node script.js", "npx puppeteer browsers install chrome"])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });

  test("browser MCP tools", () => {
    for (const name of ["mcp__claude-in-chrome__navigate", "mcp__plugin_playwright_playwright__browser_click", "mcp__puppeteer__goto", "mcp__chrome-devtools__click"]) {
      expect(toolkitVerdict(call(name, {}), PATHS)?.rule).toBe("browser");
    }
  });
});

describe("rule: tasks (a project's backlog.md and todos.md)", () => {
  test.each([
    ["Edit", { file_path: "/work/repo/backlog.md" }],
    ["Write", { file_path: "todos.md" }],
    ["MultiEdit", { file_path: "/work/repo/docs/backlog.md" }],
  ])("denies Claude %s", (tool, input) => {
    const v = toolkitVerdict(call(tool, input), PATHS);
    expect(v?.rule).toBe("tasks");
    expect(v?.reason).toContain("tasks-axi");
  });

  test("denies Pi edit and write (input.path)", () => {
    expect(toolkitVerdict(call("edit", { path: "backlog.md" }, { harness: "pi" }), PATHS)?.rule).toBe("tasks");
    expect(toolkitVerdict(call("write", { path: "/x/todos.md" }, { harness: "pi" }), PATHS)?.rule).toBe("tasks");
  });

  test.each(["echo '- [ ] x' >> backlog.md", "printf x > todos.md", "cat x | tee -a backlog.md", "sed -i '' 's/a/b/' backlog.md", "sed -i.bak 's/a/b/' todos.md", "perl -pi -e 's/a/b/' backlog.md", "perl -i.bak -pe 's/a/b/' backlog.md", "sed --in-place 's/a/b/' backlog.md", "sed -ni 's/a/b/p' backlog.md", "perl -lpi -e 's/a/b/' backlog.md", "perl -0pi -e 's/a/b/' backlog.md", "perl -l0pi -e 's/a/b/' backlog.md", "perl -0777pi -e 's/a/b/' backlog.md", "perl -0x0Api -e 's/a/b/' backlog.md", "perl -C7pi -e 's/a/b/' backlog.md", "mv /tmp/x backlog.md", "cp /tmp/x docs/backlog.md", "rm backlog.md", "truncate -s 0 todos.md", "dd if=/dev/null of=backlog.md", "cat <<EOF > backlog.md\nx\nEOF"])("denies the shell write %s", (cmd) => {
    expect(ruleOf(cmd)).toBe("tasks");
  });

  test.each(["cat backlog.md", "grep x todos.md", "tasks-axi add x 'y'", "cp backlog.md /tmp/x", "echo x > notes.md", "sed 's/a/b/' backlog.md", "perl -MList::Util=sum -ne 'print' backlog.md", "perl -Mstrict -ne 'print' todos.md", "perl -e 'print 1' backlog.md", "perl -lne 'print' backlog.md", "perl -Ilib -ne 'print' backlog.md", "perl -Ci -ne print backlog.md", "perl -CSDi -ne print backlog.md", "sed -n -e 's/a/b/p' backlog.md"])("allows %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });

  test("reading with Read is fine", () => {
    expect(toolkitVerdict(call("Read", { file_path: "backlog.md" }), PATHS)).toBeNull();
  });
});

describe("rule: flowryn-tasks (Flowryn's own backlog)", () => {
  test("an edit of the configured backlog names the flowryn verbs, not tasks-axi", () => {
    const worker = toolkitVerdict(call("Edit", { file_path: PATHS.flowrynBacklog }), PATHS);
    expect(worker?.rule).toBe("flowryn-tasks");
    expect(worker?.reason).toContain("ask your leader");
    expect(worker?.reason).not.toContain("tasks-axi");
    const leader = toolkitVerdict(call("Edit", { file_path: PATHS.flowrynTodos }, { role: "leader" }), PATHS);
    expect(leader?.reason).toContain("flowryn verbs");
  });

  test.each([
    "echo x >> ~/.flowryn/data/backlog.md",
    "tasks-axi add x y --file ~/.flowryn/data/backlog.md",
    "tasks-axi done x --file=/Users/u/.flowryn/data/todos.md",
    "TASKS_AXI_FILE=/Users/u/.flowryn/data/backlog.md tasks-axi start x",
    "env TASKS_AXI_FILE=$HOME/.flowryn/data/backlog.md tasks-axi rm x",
  ])("denies %s", (cmd) => {
    expect(ruleOf(cmd)).toBe("flowryn-tasks");
  });

  test("tasks-axi with the default file in Flowryn's data dir", () => {
    expect(ruleOf("tasks-axi add x y", { cwd: "/Users/u/.flowryn/data" })).toBe("flowryn-tasks");
    expect(toolkitVerdict(call("Bash", { command: "tasks-axi start x" }), { ...PATHS, tasksAxiFile: PATHS.flowrynBacklog })?.rule).toBe("flowryn-tasks");
  });

  test.each(["tasks-axi list --file ~/.flowryn/data/backlog.md", "tasks-axi show x --file ~/.flowryn/data/backlog.md", "tasks-axi ready --file ~/.flowryn/data/backlog.md", "tasks-axi --file ~/.flowryn/data/backlog.md", "cat ~/.flowryn/data/backlog.md"])("allows the read %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });
});

describe("rule: leader-shell (the Pi leader's gate, moved from the bridge)", () => {
  const pi = { harness: "pi" as const, role: "leader" as const };
  test.each(["flowryn merge t1", "flowryn approve t1", "flowryn hook stop", "flowryn gate pass t1", "flowryn decide k1 yes --by captain", "flowryn decide k1 yes --by=captain", "flowryn leader repin", "flowryn leader repin /tmp"])("blocks %s for a Pi leader", (cmd) => {
    const v = toolkitVerdict(call("bash", { command: cmd }, pi), PATHS);
    expect(v?.rule).toBe("leader-shell");
    expect(v?.reason).toContain("flowryn_merge");
  });

  test("not for a Claude leader or a worker, and not other verbs", () => {
    expect(ruleOf("flowryn merge t1", { role: "leader" })).toBeNull();
    expect(ruleOf("flowryn merge t1", { harness: "pi" })).toBeNull();
    expect(toolkitVerdict(call("bash", { command: "flowryn decide k1 yes --rationale fine" }, pi), PATHS)).toBeNull();
    expect(toolkitVerdict(call("bash", { command: "flowryn fleet" }, pi), PATHS)).toBeNull();
    expect(toolkitVerdict(call("bash", { command: "flowryn leader status" }, pi), PATHS)).toBeNull();
  });
});

describe("accepted misses (confused-agent threat model)", () => {
  test.each(["G=gh; $G pr list", "alias g=gh; g pr list", "./scripts/release.sh", "python -c 'import subprocess; subprocess.run([\"gh\"])'", "make release", "npm run publish", "echo Z2g= | base64 -d | sh"])("does not see %s", (cmd) => {
    expect(ruleOf(cmd)).toBeNull();
  });
});

test("other tools and empty input pass", () => {
  expect(toolkitVerdict(call("Read", { file_path: "/x" }), PATHS)).toBeNull();
  expect(toolkitVerdict(call("Bash", {}), PATHS)).toBeNull();
  expect(toolkitVerdict(call("Edit", {}), PATHS)).toBeNull();
  expect(toolkitVerdict(call("mcp__lavish__x", {}), PATHS)).toBeNull();
});
