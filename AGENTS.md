# Flowryn agent guide

Flowryn runs a fleet of coding agents: a leader (Claude Code or Pi) dispatches workers into git worktrees in Herdr panes, and one daemon, `flowrynd`, keeps state in SQLite. TypeScript on Bun. Claude reads this file through `CLAUDE.md`; Pi reads it directly.

## Commands

```bash
bun install
bun run typecheck                 # tsc --noEmit
npx oxlint                        # lint (not `npm run lint`: a user hook misparses it)
bun run test                      # unit, then integration, in parallel
bun run test:unit                 # or test:integration
bun test test/unit/foo.test.ts    # one file
bun test --changed=origin/main    # only tests your change affects
bun run build                     # dist/flowryn and the dist/flowrynd link
bun run notes                     # index of docs/notes/
fixtures/cleanup-guard/run.sh --impl "bun $PWD/scripts/guard/landed-impl.ts"
fixtures/cleanup-order/run.sh --impl "bun $PWD/scripts/guard/cleanup-impl.ts"
```

- Run tests, spikes and anything that touches Herdr or the daemon socket outside a command sandbox: the suite starts daemons on Unix sockets, uses FSEvents, drives a pty and runs the real tasks-axi 0.2.5. Inside a sandbox, `bun install` needs `BUN_TMPDIR` and `BUN_INSTALL_CACHE_DIR` set to a writable temp directory.
- CI is off for good (docs/v1-status.md "CI is off"). The merge gate is local `flowryn verify`: install, typecheck + oxlint + build, contract checks (`doctor --contracts --verify-only`) when a worker path changed, then unit and integration tests. Its steps are in `src/verify/recommended.ts`.
- Worker paths are `src/**`, `spikes/pi/lib/**`, `scripts/build.sh`, `package.json`, `bun.lock`, `bunfig.toml` and `tsconfig.json`. A change there runs the contract checks; docs, tests and scripts alone do not.
- A cleanup-guard change must pass both fixture sets above before it lands.
- Known load flakes are listed by `flowryn learnings`. If a lone test fails under the full suite, rerun it alone before you debug it.

## Before you change things, read

- `docs/design-v3.html`: the design spec. `src/<component>` follows its section 4.
- `docs/m0-verdicts.md`: what each harness, Pi, Herdr and tasks-axi behaviour really does. Read it before you build on any of them.
- `docs/m1-notes.md` to `docs/m5-notes.md`: choices and live results for each milestone. `docs/v1-status.md`: every v1 item with its PR, or why it was not built. `docs/cutover-notes.md`: security limits and follow-ups.
- `docs/notes/`: one file per feature since v1. Search here first for a feature's config keys, verbs and behaviour.

## Design rule

- Deterministic first: build from plain code (rules, state machines, parsers, schemas, templates, timers). Use a model only where judgement or natural language is truly needed, and say why in the design and the PR.

## State and data

- Write `flowryn.db` and call tasks-axi only through the existing paths. Every tasks-axi mutation goes through `recordIntent` in the same transaction as its runtime change. Every database mutation appends an event in its transaction (`src/db/events.ts`).
- The reconciler raises a divergence for any live run whose task is not In flight in the backlog, and the reverse. A test that seeds a run must also seed its task (`seedRun` does both).
- Runs and stages start only through the scheduler's grant (`src/sched/scheduler.ts`). To make one wait, set `runs.stage_state`/`pending_launch` and kick it. Never launch or steer directly. A capacity slot is a `pool_leases` row, released at stage or run end.
- Decisions live in `decisions` (q<N> run-scoped, k<N> standalone). Only `captainChannel`, a chat-answer grant (`takeGrant`, `src/policy/grants.ts`) and, for a review gate's own questions, `lavishAnswer` (`src/lifecycle/decision-verbs.ts`) may record `answered_by = captain`. Known limits are in docs/cutover-notes.md "C1 · Decisions".
- `import_source = legacy:<id>` marks work from the retired cutover import. Nothing writes it any more; the briefing still counts by it.

## Processes and the daemon

- Every external command the daemon runs goes through `runBounded` (`src/runtime/bounded.ts`) or a helper built on it (`runCommand`, `gitRunner`). It provides a process group, a deadline, a bounded drain and an `owned/` record. A cut-off read returns code 124/125, never empty output. Never hand-roll `Bun.spawn` with a pid timer.
- A permission prompt on a busy run holds liveness at `blocked_dialog`. The rules for when it is released are in `src/lifecycle/prompt-wedge.ts` and `src/reconcile/reconciler.ts`. Herdr status `null`/`"unknown"` holds; `"idle"`/`"done"` needs two settled passes.

## Leader, hooks and policy

- Leader and worker hooks share the `flowryn hook` verbs. The caller's token decides the role (a run token means a worker; a leader session token means a leader or a reader, by the lease).
- Bridges decide nothing. Rules go in `src/leader/` or `src/attention/`, never in `src/bridges/`.
- Every verb a leader, reader or leader hook can call declares `scope` on its spec (`src/leader/scope.ts`; a unit test fails without one). List verbs filter with `lensFor`. See docs/notes/2026-10-24-leader-scoping-and-vj.md.
- Toolkit rules (gh-axi, sqlite-axi, treehouse, jira-axi, chrome-devtools-axi, tasks-axi) live in `src/policy/toolkit.ts`, and the shell normalizer in `src/policy/shell.ts`. They are evaluated in the hook process, not the daemon, so a denial holds with the daemon down. A new rule gets a unit case and one deny through the real hook (`test/integration/toolkit.test.ts`), and `src/policy/static.ts` (the static Claude layer) stays in step with it.
- A worker's `$FLOWRYN_BIN` calls run inside the user's Claude Bash sandbox (hooks do not). Per-run settings allow only the daemon socket, the run's spool, report and temp directories, and the git-common-dir paths a commit writes. `hooks` and `config` are denied, so a worker never writes git config (no `push -u`). A new path a worker must write gets added in `src/harness/git-access.ts`, `src/harness/claude/adapter.ts` and `src/lifecycle/launcher.ts`.

## Tests

- Tests never reach a real Herdr, harness, Docker, GitHub, no-mistakes daemon or this machine's memory. Test homes get stand-ins: a missing Herdr socket, `claude`/`pi`/`herdr`/`docker`/`no-mistakes`/`lavish-axi`/`quota-axi` fakes, `FLOWRYN_OPENER=record:` and `FLOWRYN_NOTIFY=off`. Reuse the helpers in `test/helpers/` (`fleet-env.ts`, `fake-herdr.ts`, `fake-harness.ts` whose `FAKE:` steps are listed at its top, `fake-github.ts`). Don't build new fakes.
- Anything that launches a daemon in a test calls `requireNotificationsOff` (`src/config/leader.ts`) first.
- `test/integration/contracts-offline.test.ts` runs the real contract suite against fake harnesses. A change to behaviour that suite proves bumps that harness's `CONTRACT_REVISIONS` (`src/contracts/revision.ts`). Docs and unrelated changes never bump it.
- A macOS-only test (launchd, plutil, codesign, Seatbelt, FSEvents) uses `test.skipIf(process.platform !== "darwin")` with the reason in a comment. Never use an early `return`.
- `flowryn approve` and the live board need a real terminal. Drive them through `test/helpers/pty.ts`.
- A GitHub token is only ever sent to GitHub's own API host. All forge calls go through `src/forge` at `[github] api_url`.

## Live runs (Herdr, Claude, Pi)

- Drive Herdr only through `spikes/lib/lab.sh` (`fl-lab-*` sessions), never the default session. Scrub `CLAUDECODE`/`CLAUDE_CODE_*` first (`lab_scrub_env`), or launched harnesses become child sessions of yours.
- Live checks are `flowryn doctor --contracts`, `spikes/run-all.sh [group]`, and `scripts/lab/m2-live.sh` to `v1-live.sh`. They own a `flowryn/contract-<runid>-` branch prefix and clean up by exact name.
- Pi contract tests use the offline scripted model (`spikes/pi/lib/scripted-provider.ts`) and a scratch `PI_CODING_AGENT_DIR`, never a paid model or `~/.pi`. See `spikes/pi/NOTES.md`.

## Docs, versions and merge hotspots

- Docs for new work go in a new `docs/notes/<yyyy-mm-dd>-<task id>.md` (format in `docs/notes/README.md`). A feature's config keys and verbs go there, not in README.md, which changes only for setup and usage a new user follows. Later fixes to the same feature edit that feature's file.
- `docs/m*-notes.md`, `docs/v1-status.md` and `docs/cutover-notes.md` are frozen. Fix them in place, but never add a heading (`test/unit/docs-notes.test.ts` fails).
- Feature PRs never change `VERSION` or the package.json version. A release is its own PR from main (`bun run release <major|minor|patch>`), and a commit that mixes a version change with other files fails `bun test`.
- Bump `PROTO` in the PR that changes the wire format.
- A new migration takes the next number in `MIGRATIONS`. The numbers must run 1..N; renumber yours if another lands first.
- Keep `ERROR_CODES` in alphabetical order (a test checks).
- Workers never rewrite history. Make new commits and `git merge origin/main`; never amend, rebase or force-push.

## Maintaining this file

- Keep only what almost every session needs and cannot learn from the code. Point to the authoritative file instead of restating it.
- Keep each bullet to one or two lines. Edit or prune an existing bullet instead of adding a near-duplicate. Stay well under 200 lines.
- A rule that must never be broken belongs in a test or hook, with a one-line pointer here.
