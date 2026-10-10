# Toolkit rules, ship 2

- Status: done
- Config: `[tools] gh_axi`, `[tools] jira_axi`, `[tools] acli`, `[tools] chrome_devtools_axi`, `[tools] sqlite_axi`, `[tools] quota_axi`, `[tools] treehouse`

Ship 1's rules (docs/m5-notes.md, "Toolkit rules (toolkit enforcement, ship 1)") live in the hook. If the hook binary did not run, nothing stopped the call, and the model was still offered the MCP tools the rules deny: a worker transcript on this Mac listed 44 `mcp__claude-in-chrome__*` names and three Atlassian servers. Ship 2 adds Claude's own static layer, the tools to install, and a live check. It is plain code: lists built from Flowryn's paths, a table of install commands, and a transcript parse.

- **The static layer** (`src/policy/static.ts`, `staticLayers` and `configStaticLayers`). The same lists go into the per-run worker settings (`workerSettings` `deny`, through `RunContext.permissionsDeny`) and the leader settings (appended to `LEADER_PERMISSIONS.deny`). The bridge only writes the list `lead` hands it.
  - `permissions.deny` holds three kinds of rule. The first is bare MCP server names (claude-in-chrome, Playwright twice, Puppeteer, chrome-devtools, the three Atlassian names, GitHub twice, SQLite). The second is `Bash(<prefix> *)` for `gh`, `hub`, `jira`, `jira-cli`, `acli jira` and `git worktree add|remove|move|prune`, plus `Bash(sqlite3 *flowryn.db*)`. The third is `Skill(atlassian:*)`, and `Edit(//<backlog>)` and `Edit(//<todos>)`.
  - `sandbox.filesystem.denyWrite` holds the backlog, the to-dos and their `.lock` files. For a worker they go beside the git hooks and config. The leader's sandbox block gains a filesystem section for them.
- **Checked live on Claude 2.1.295** (`claude -p --settings`, bypassPermissions, a scratch dir):
  - A bare name hides the server's tools: with `--chrome`, claude-in-chrome went from 22 tools to 0, and the Atlassian server from 21 to 0.
  - `Bash(gh *)` also denies a bare `gh`, so no `Bash(gh)` entry is needed (the design's A2 guessed otherwise).
  - A wildcard in the middle (`sqlite3 *flowryn.db*`) denies only that database.
  - `Skill(atlassian:*)` loads without voiding the file.
  - A sandbox `denyWrite` on a file also refuses `mv tmp file` onto it, which matters because tasks-axi writes a temp file and renames it.
- **Found live:** a user PreToolUse hook that rewrites the command runs before Claude matches its permission rules. On this Mac, RTK's `rtk-rewrite.sh` turns `git …` into `rtk git …`, so `Bash(git worktree prune *)` (and even `Bash(git *)`) did not deny `git worktree prune`. With `--setting-sources project`, which leaves out user hooks, the same rule denied it. The toolkit hook still sees the original command, so the worktree rule holds. The static Bash rules remain a backstop only.
- **No blanket `Bash(sqlite3 *)`:** your q31 answer (deny reads only) allows sqlite3 writes.
- **Tools** (`src/config/config.ts`, `src/init/install.ts`): `TOOL_NAMES` gains `gh_axi`, `jira_axi`, `acli`, `chrome_devtools_axi`, `sqlite_axi`, `quota_axi` and `treehouse`, so the launchd PATH picks up their directories. `INSTALL_HINTS` moved to `src/init/install.ts`, so init and doctor say the same thing. Only tasks-axi is pinned, because the rules name the other tools and Flowryn never parses their output.
- **Init's offer (Q5):**
  - Init offers an install for every missing tool that has an installer: the axi tools, acli and treehouse. The harnesses, gh, git, node, Herdr, Docker and no-mistakes keep a printed hint only, because each involves a choice that is yours.
  - It lists the commands, then asks one "Run these install commands now?" with default No.
  - It runs each step with your terminal attached. A failed step skips the rest of that tool's steps (acli's `brew install` after a failed tap); the other tools carry on.
  - It then detects the tools again and records what installed. A tasks-axi installed this way no longer stops init.
  - A tool whose package manager is not on PATH gets its hint instead.
  - chrome-devtools-axi installs with `chrome-devtools-mcp` beside it, so it never falls back to `npx -y chrome-devtools-mcp@latest`.
  - The design's "print only on a non-terminal" branch was dropped, because `flowryn init` already refuses a non-terminal stdin.
- **Doctor (Q6):**
  - A missing tool's line now ends with `Install: <the same hint>`.
  - A missing gh-axi warns (every GitHub job uses it).
  - chrome-devtools-axi warns while a workflow has a stage holding the `browser` pool. The built-in `feature-ui` does, so in practice it warns.
  - acli warns once jira-axi is installed.
  - jira-axi, sqlite-axi, treehouse and quota-axi are info; quota-axi will warn once ship 3's probe uses it.
  - A new `chrome-devtools-mcp` info line suggests the global install when chrome-devtools-axi is present without it (no `chrome-devtools-mcp` on PATH, no `CHROME_DEVTOOLS_AXI_MCP_PATH`).
- **The live check** is the `toolkit` step in `src/contracts/suite.ts`. It runs for Claude only, after `interrupt` and before `exit`, so Pi's scripted steer ids are unchanged. The steps:
  1. A steer tells the worker to run `gh --version` once.
  2. The step waits for its ack, a `toolkit.denied` {rule github, harness claude} on the run, and idle.
  3. It reads the run's transcript. Claude 2.1.295 records the deferred tools it offers as `deferred_tools_delta` attachments, built-in ones included, so a session always has one.
  4. Any `mcp__claude-in-chrome__*` among the offered tools fails the step.
  5. When `claudeInChromeDefaultEnabled` is true in the worker's `.claude.json` (`[workers.claude] config_dir`, `CLAUDE_CONFIG_DIR` or HOME), a transcript with no tool record also fails, because a changed record must not pass silently. When it is not true, the step passes and says that hiding is not shown.
  6. The fake Claude (`test/helpers/fake-contract-claude.ts`) writes that attachment from a fixed tool list, minus the servers its settings deny by bare name. It never retries a toolkit denial. The offline test turns claude-in-chrome on in its store.
- **Live run** (`doctor --contracts --verify-only --harness claude` in a lab session): all 12 steps passed on Claude 2.1.295 with the default model. The toolkit step's line was "gh denied (github rule); none of its 90 deferred tools is claude-in-chrome". With `--model haiku` and `--model sonnet`, the worker ran `deliver --report` by itself after the first steer, the scout landed, and "deliver while idle" timed out. This happens before the new step and does not depend on this change. The contract needs a model that follows its instructions, which is what the default (opus) does.
- **Tests:**
  - `test/unit/static-layers.test.ts` covers the lists (bare names only, prefix matches against gh-axi and the axi tools, q31, absolute-path Edit rules, the config's own paths), the worker and leader settings, the contract step (position, transcript parsing past a torn line, the verdict matrix, A6), the tool table, doctor's tiers and the chrome-devtools-mcp line.
  - `test/unit/setup.test.ts` covers the install offer (default No, hint-only tools, a failed tap, recording, tasks-axi installed from the offer).
  - `test/integration/workers.test.ts` checks that a launched run's `claude-settings.json` carries the layer.
  - `test/integration/leader-cli.test.ts` checks the leader's settings.
  - `test/integration/contracts-offline.test.ts` runs the new step.
- **Version:** 0.14.0 (0.12.0 and 0.13.0 went to #47 and #48). `PROTO` stays 6, because no verb or argument changed. An older binary refuses a config that has the new `[tools]` keys (`config_invalid`). Init runs from the new build, and the daemon restarts onto a merged build by itself, so the window is short. The unknown-key check stays, because it catches typos.
