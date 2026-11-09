# Never commit Claude co-author trailers

- Status: done
- Open: Claude honouring the worker settings' empty `attribution` over a user setting is proven by Claude Code 2.1.319's schema, not yet by a live lab run; Pi was not installed on the build machine, so "Pi adds no trailer" is unconfirmed (the merge gate refuses one either way)

The user, 2026-11-08: "stop committing co authors with Claude. It's no longer allowed". Until now Flowryn relied on the user's own `~/.claude/settings.json` (`"attribution": {"commit": "", "pr": ""}`); four commits on main from before that setting carry a `Co-authored-by: Claude …` trailer: 95e5a671, 56f32a77, 1a8d1008 (2026-11-05) and 3a7f8a02 (2026-11-06). They stay: rewriting main is out of scope.

Three deterministic layers, no model.

## Settings

Every Claude settings file Flowryn writes, the per-run worker file (`src/harness/claude/adapter.ts` `workerSettings`) and the leader's `~/.flowryn/leader/claude-settings.json` (`src/bridges/claude/settings.ts` `leaderSettings`), carries `"attribution": {"commit": "", "pr": ""}` (`NO_ATTRIBUTION`). Claude Code 2.1.319's settings schema: `attribution.commit` / `attribution.pr` are "Attribution text for git commits / pull request descriptions … Empty string hides attribution"; `includeCoAuthoredBy` is "Deprecated: Use attribution instead", so it is not written. Both files are passed with `--settings`, which ranks above the user's, project and local settings, so a different user setting no longer turns the trailer back on. `attribution.sessionUrl` is not set: the `Claude-Session:` line is a session link, not a co-author, and behaves as before. The worker settings are part of the launch the contract suite proves, so claude's `CONTRACT_REVISIONS` went 10 → 11.

## Guidance

Every ship's delivery steps in the task file (`src/harness/contract-text.ts` `NO_AI_ATTRIBUTION_LINE`, in the no-mistakes, direct-PR and local-only lines, for Claude and Pi) say: no AI Co-authored-by trailer and no "Generated with Claude Code" line in commits or the PR body, since merge refuses them. It lives there rather than in the always-on contract, which is at its size budget and holds only what every turn needs; scouts never commit. The leader skill is at its budget too and gets no line: the leader's settings stop the trailer, and the refusal names its own fix.

## The merge gate

`checkGate` (src/policy/merge.ts) has a step 2b after the head checks and before checks and approval, so the fix is named before anyone approves. Every merge route (`flowryn merge`, the yolo auto-merge, the landing queue, away merges) reaches it through `merge-path.ts`. `gatherFacts` reads the commits the merge would land: an open PR's from GitHub (`Forge.pullCommits`, `GET /repos/{o}/{r}/pulls/{n}/commits`, which is what a squash reads its co-authors from) plus the PR body, or a local delivery's from `git log <default>..<head>` (`branchCommits`). A PR already merged is not read (history is out of scope).

The matcher (`src/policy/ai-attribution.ts`) works line by line, trimmed and case-insensitive, CRLF and tabs included:

- a line starting `Co-authored-by:` (any spacing round the colon) whose rest names `claude` as a word or `noreply@anthropic.com`;
- `Generated with [Claude Code` / `Generated with Claude Code` (the emoji and link forms included);
- a commit whose author or committer email is `noreply@anthropic.com`: GitHub's squash adds a co-author line for a distinct commit author (added beyond the task text for that reason).

Not matched: `Claude-Session:`, a human co-author, a name that merely contains "claude", prose about Claude, "co-authored-by" mid-sentence.

A hit refuses with `ai_attribution` (exit 2), naming up to three hits (commit sha8 and the line, control characters dropped, cut to 120 characters) and the count of the rest. The fix in the refusal's help: a new commit cannot remove a trailer and Flowryn never force-pushes, so the worker branches afresh from `origin/<base>`, re-creates the work as new commits without the line (`git cherry-pick --no-commit`, then a clean message), delivers a new PR, and this one is declined. A hit only in the PR body asks for the description to be edited. Commits that cannot be listed refuse too, never pass: a forge error is `forge_unavailable` (a GitHub outage also notes its P1 as the other gate reads do), a PR with 250 or more commits (GitHub's list cap) is refused as `forge_unavailable` with a help to split the work or deliver a fresh branch, and notes no GitHub outage, and a git failure on a local delivery is `ai_attribution` "cannot list the commits".

Flowryn sends GitHub only a squash `commit_title`, never a `commit_message`, so the squash body is GitHub's default; with the gate there is no AI line left in the commits for it to copy.

Commit messages, emails and the PR body are worker-written input: they are matched by regex only, never executed or passed to a shell.

## Tests

- `test/unit/ai-attribution.test.ts`: the matcher's case, spacing, tab and CRLF variants and its near misses; the gate step's refusals (commit, PR body, unlistable commits, more than three hits) and passes; `branchCommits` against a real git repo; the leader settings, built and as written by `writeLeaderFiles`.
- `test/unit/harness.test.ts`: the written worker settings file (launch and resume) has empty attribution; every ship mode's delivery lines carry the guidance.
- `test/unit/forge.test.ts`: `pullCommits` and the PR body against the fake GitHub, and the 250-commit refusal.
- `test/integration/delivery.test.ts`: through the real CLI and the fake forge, a PR whose commit carries `Co-Authored-By:  Claude … <NoReply@Anthropic.com>` is refused naming its commit and the fix, and a clean PR merges.
