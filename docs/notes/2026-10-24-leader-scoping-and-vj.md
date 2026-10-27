# A leader per scope

- Status: partial
- Open: `flowryn home adopt` has not yet run on the real `~/.flowryn-work` (your step, once its open runs finish); two leaders on two real logins have not run live; the folder guard reads a shell command's words, so a path built at run time slips past it (the same limit as the other toolkit rules)
- Config: no new keys: a leader's scope comes from `[accounts.<id>] scope` (docs/notes/2026-10-22-multiple-ai-provider-u9.md)

Work and personal projects could already share one Flowryn home (phase 1 of the multiple-accounts plan), but a home had one leader, and it read every task. Now each scope has its own leader, and `flowryn home adopt` moves a second home's queued work (the old `~/.flowryn-work`) into the main one. A leader started on the work login sees and acts on work tasks only; one on the personal login sees personal tasks only. The design was reviewed at gate g202; the user chose "leader per scope" at gate g159.

## Which scope a leader leads

`flowryn lead [--pi] [--account <id>]` picks the account the leader runs on, in your terminal:

1. `--account <id>`, which must be an account of the harness.
2. Else the account whose login folder is the one your terminal points at: `CLAUDE_CONFIG_DIR` (unset: `~/.claude`) for Claude, `PI_CODING_AGENT_DIR` (unset: `~/.pi/agent`) for Pi, compared by real path. None or several refuse and list the accounts.
3. A harness with no declared account has one implicit account, so a home without `[accounts]` needs nothing and behaves as before. The implicit account leaves your terminal's login alone: `[workers.claude] config_dir` is the workers' login, not the leader's.

The harness then starts on that login the way a worker does (`src/leader/login.ts` `applyLogin`): `CLAUDE_CONFIG_DIR` set to the account's folder, or unset for a declared account without one, and the credential variables Claude ranks above a stored login (`CLAUDE_CREDENTIAL_ENV`) dropped; a Pi account gets `PI_CODING_AGENT_DIR` and `--provider`/`--model`. `lead.open` records the account and its scope on the session (`leader_sessions.account`, `.scope`); the daemon takes the scope from config's account, never from the caller.

The session's first hook confirms the login (`confirmLogin`): `flowryn hook session-start` reports the login folder in its own environment, and Claude's `transcript_path` must sit under `<account folder>/projects`. A mismatch leaves the session in no scope (`scope = ''`): it claims nothing, sees nothing, and its banner says to start the leader again. The event is `leader.scope_unconfirmed`. Logging in again from inside a running Claude session keeps the same folder, so Flowryn cannot see that; start a new leader instead.

## One lease per scope

`leader_lease` has one row per scope (migration 35; `id` stays the rowid, its `id = 1` check is gone, `scope` is unique). A session's token is the leader of its scope while that scope's lease names it, and a read-only reader of its scope otherwise. Two leaders of two scopes both lead at once; a second session of the same scope is read-only, as before. Each holder has its own epoch, approval key (Pi), waiter, rewake state (`meta` key `leader_rewake:<session>`, removed when the session closes) and wake budget.

Rows from before scopes got the implicit scope `default`. At start and after every config reload the daemon moves them to `[scopes] default` when that is another scope and no scope is called `default` (`adoptLegacyScope`, event `leader.scope_adopted`), so the leader that led before the upgrade keeps leading.

`flowryn leader status` lists each scope's lease (`leases`) when there are several. `flowryn leader repin` takes `--session <id>` when several sessions lead.

## What a scoped leader sees

A task's scope is its project's (`projectScope`). A task with no project that a scoped leader created (a to-do, a standalone decision) stays in that leader's scope (`task_scopes`); yours from your own terminal, and any from before, are in the default scope. A thing whose project's scope rules are broken belongs to no scope: no scoped leader sees it.

- Every verb a leader, reader or leader hook can call declares a scope rule (`VerbSpec.scope`, `src/leader/scope.ts`): `ref` (its task, run, item, decision, gate, plan, divergence, grant, verification, leader session or to-do argument must be in the caller's scope), `project`, `list` (its read filters by the caller's scope), `self` (it checks itself: `decision add`, `todo add`, `project add`, `leader claim`, the hooks) or `none` (no task content: `daemon status`, `away`, contract records). The gateway and the read-only fallback check it (`enforceScope`); a refusal is `scope_refused` (exit 77) and the event `leader.scope_refused` (verb and reference only). A verb with no rule refuses a scoped caller, and `test/unit/leader-scope.test.ts` fails on one.
- Pushes, digests, turn-end relays, the briefing, the return brief and `fleet` carry only the leader's scope (`ScopeLens`). The briefing adds one count line per other scope: "Other scope work: 2 items wait for its leader (not shown here)." Counts only, never content.
- Items about no task go to every leader. Most of their lines still name tasks (a GitHub outage lists the merges that wait, a capacity wait its oldest run, a dropped restart its validations, a failed build its project): the design guessed they did not, and the build found it wrong. A scoped leader gets a fixed line for those instead (`neutralLine`: "forge unavailable: its details may name other scopes' tasks, so only the user's own terminal shows them"); only `contract_recorded`, `nomistakes_down` and `herdr_unreachable` are shown whole (`PLAIN_GLOBAL_KINDS`).
- A gated command (merge, discard, gate pass, captain decide) naming another scope's task is denied in the Claude leader's PreToolUse hook before its prompt could name that task.
- `stats` counts only the leader's scope's projects; `accounts` lists every account (config, no tasks) and the leader's scope's projects, with a count of the rest.

Your own terminal is unrestricted: `flowryn board`, `brief`, `fleet`, `show` and `approve` see every scope. A home with one scope is unrestricted for its leaders too, so nothing changes there.

Mac and Herdr notifications reach you, not a model, so they still cover every scope; with more than one scope each names the scope of its first item (`[work] api failed`).

## The folder guard

Besides the verbs, a leader of a home with more than one scope may not read another scope's files:

- The leader settings (one file for every leader of the home) deny `Read` on Flowryn's backlog, to-dos and database, and deny writing the transcripts of every Claude account a leader may run on.
- The toolkit rule `scope-paths` (`src/policy/toolkit.ts`), evaluated in the leader's hook process, refuses Read, Grep, Glob, LS, Find, Edit and Write paths, and any shell word, redirect or `tasks-axi` file, under a denied path: Flowryn's shared stores (`src/policy/scope-paths.ts` `sharedStores`) and the leader's scope's list of other scopes' folders. Grep, Glob, LS and Find with no path work on the session's cwd, and a wildcard pattern (a Glob's pattern, or a shell word with an unquoted `*`, `?`, `[` or `{a,b}`; quoted text and parameters (`$?`, `$*`, `${…}`) are never expanded as globs, so they are not) is also checked, with its `{a,b}` alternatives expanded, at each alternative's folder before the first wildcard, resolved against its path or the shell's cwd (the base itself when it names none), as a recursive root: an absolute, `../` or brace pattern searches outside its base, and `cat *` from a parent of another scope's folder is refused. A recursive search (Grep, Glob, Find, `rg`, `grep -r`, `find`, `fd`, `tree`, `ag`, `ack`, `ls -R`) is also refused when its root holds a denied path; a shell search that names no folder-like word (`.`, a slash, `~`) searches the cwd, so `rg foo src` from a parent of another scope's folder is refused (write `./src`). Shell words, bare names included (`cat backlog.md`), resolve against the folder the line's `cd`/`pushd` reached.
- The daemon keeps one list per scope in `<state_dir>/leader/scope-deny/<scope>.json`: other scopes' project checkouts, their `data_dir/worktrees/<project>/`, their task folders `data_dir/<task>/` (review pages, reports), their runs' worktrees, `state_dir/runs/<run>/` and spool folders (`src/leader/scope-guard.ts`). It rewrites them within a second of a project, task or run appearing; the hook reads its file on every call, so a refusal holds with the daemon down. `flowryn lead` puts the scope in the leader's environment (`FLOWRYN_LEADER_SCOPE`); a leader without one is denied every list.

Workers are not guarded this way: a worker already runs only on an account of its project's scope.

## Chat-answer grants

A grant is checked against the transcript under the leader session's own account's projects folder (`sessionProjectsDir`): `<config_dir or ~/.claude>/projects` for a declared Claude account. The implicit account keeps `[grants] claude_projects_dir`, or the default from the daemon's environment, as before. This fixes the work home's queued bug (`flowryn-chat-answer-ij`) once its work runs from the main home on `claude-work`.

## Moving a second home in: `flowryn home adopt`

`flowryn home adopt <old home> [--scope <id>]` (phase 2) moves an idle Flowryn home's projects, queued tasks, open to-dos and plans into this home, under one scope, and leaves the old home as a read-only archive. It is human only (your own terminal; an agent's call is refused) and the main daemon runs it. Nothing in it needs a model: every step is a lookup or a rule.

```sh
FLOWRYN_HOME=~/.flowryn-work flowryn daemon stop   # once its runs have finished
flowryn home adopt ~/.flowryn-work                 # the scope comes from its [workers.claude] config_dir
```

It refuses (`adopt_refused`, exit 2), and moves nothing, while:

- the old daemon answers on `<old home>/run/flowrynd.sock`, or a process holds its `flowrynd.lock`;
- any old run has not ended (cleaned, failed or cancelled), any old decision is open, or any old gate (review or merge) is open;
- its database is at another schema than this build's;
- any old backlog write is still pending in its journal (its backlog file is not yet what its database says), or any old task or to-do is In flight;
- the scope cannot be told: `--scope` names no scope here, or, without it, no single declared Claude account in this home's config has the old home's `[workers.claude] config_dir` (compared by real path);
- an old project resolves to another scope under this home's config (the refusal names the `[scopes.<id>] paths` rule or `[projects.<id>] scope` to add; Flowryn never edits your config), or its workflow, or a moved task's, is not in this home's `[workflows]`;
- an old project's id is registered here at another path, or its path under another id (the same id at the same path is skipped);
- a queued task's or to-do's id is already used here (backlog, to-dos, policy rows, plan phases, decisions, drops or pending adds).

What moves, in one transaction with one `home.adopted` event (old home, scope, projects added and skipped, every old to new task, to-do and plan id, every dropped edge):

- projects, inserted with their settings;
- the old backlog's Queued tasks, added through `recordIntent` with their kind, repo, body, priority, PR and report links, and a `hold` intent for a held task; to-dos not done, added to this home's to-dos with their kind, body and priority, and a `hold` intent for a held to-do;
- their `task_policy` rows, copied;
- approved plans with a moved phase, under the next free plan ids here; only the moved phases are copied (a landed phase stays in the archive), with their phase numbers, harness, account, model and effort, and with no gate (the old gate id names an old home's gate); a phase's "Phase n of m" label takes m from the plan's highest phase number, so it still counts the landed phases;
- a task with no project of its own (a to-do, a hand-added task) gets the adopted scope in `task_scopes`, so it does not fall into this home's default scope.

A blocked-by edge, in the backlog or a plan phase, whose blocker did not move is dropped and listed with why: `landed` (Done in the old home) or `not queued`. A to-do's blocked-by edges are not carried: each is listed with why `to-do`. Kept edges point at moved tasks, and the adds run blockers first, since tasks-axi's `--blocked-by` needs its blocker to exist.

After the commit, `<old home>/adopted.json` records where the work went (this home, the time, the scope and the moved ids). The old daemon then refuses to start: it prints `home_adopted: …` and exits 0, so launchd's KeepAlive (on an unsuccessful exit only) leaves it stopped; `flowryn daemon start` there answers the same line without starting anything. The old files are otherwise untouched and stay readable. A rerun that finds this home's `home.adopted` event for that old home (by real path) only rewrites the marker.

## Choices made in the build

- The account is bound at `lead.open` from your terminal (the human channel) and confirmed by the first hook, rather than taken from the hooks alone: the hooks run inside the leader's process tree.
- A failed confirmation leaves the session in no scope rather than refusing its hooks, so the harness runs and its banner says what is wrong.
- Away mode stays one posture for you. Automatic away needs you inactive in every holder's session. The pending return brief and the "decided since the last briefing" marker (`last_briefing_at`) stay shared, so a second leader may miss a return brief the first one took; a per-scope split was not worth a second migration. The morning section's marker is per scope (`morning_shown:<scope>` in `meta`), so each scope's leader gets its own Morning line once a day; your terminal and a one-scope home keep `morning_shown`.
- Adopt: the old home's checks run in the verb's prepare step (its database read-only, its backlog through tasks-axi `list`), and this home's checks again inside the transaction, so a clash that appears in between still refuses. The old lock is probed, not held across the transaction, so a daemon started in the old home in that second could run beside the adoption; the marker stops every later start.
- Adopt: only the moved phases of a plan are copied, rather than the whole plan, because a landed phase's task here would have a policy row and no run, which `hasLanded` reads as not landed.
- Adopt: rows are copied column for column, so an old database at another schema than this build's refuses: a newer one asks for the newer build, an older one for starting its daemon once with this build (it migrates) and stopping it.
- The contract suite proves what the harness does with Flowryn's bridge, which this change does not alter (the leader launch adds environment, not hook behaviour), so `CONTRACT_REVISIONS` is unchanged.

## Tests

- `test/unit/leader-scope.test.ts`: every leader-reachable verb has a scope rule, and a verb without one refuses a scoped caller; task, run, item, decision, plan and merge references resolve to their project's scope; tasks a scoped leader creates stay in its scope; the gateway check refuses and records out-of-scope references and passes your terminal; two leases in two scopes; an unconfirmed session claims nothing; migration 35's legacy lease moves to `[scopes] default`; pushes, digests and the briefing carry one scope and count the other; the broken assumption (task-less items name tasks) and its neutral line; notifications labelled by scope; account choice by login folder and `--account`; the launch environment per account; a home with no `[accounts]` leads as before; login confirmation; the grants' projects folder; a Morning line per scope; the folder guard's tool, shell and `tasks-axi` cases, searches with no path, recursive searches above a denied folder and words after a `cd`; the per-scope lists; the leader settings' read denies.
- `test/integration/leader-scope.test.ts`: through the real daemon, CLI and leader hooks, a work leader on the work login and a personal leader on the personal login run side by side. Every work task carries a marker word: the personal leader's briefing, digest and `fleet`, `brief`, `decision list`, `project list`, `accounts`, `capacity` and `stats` never show it; `show` and `steer` of the work task refuse with `scope_refused`; your terminal sees both; the personal leader's hook refuses `cat` of the work checkout; a leader whose transcript is under the other login leads nothing and sees nothing.
- `test/helpers/harness.ts` `seedLeader` takes a scope, and `makeFleetEnv` a `leaderScope`: a seeded leader in a home with scopes leads `[scopes] default` unless told otherwise, so `test/integration/accounts.test.ts` (whose project is a work one) seeds a work leader.
- `test/integration/home-adopt.test.ts`: through the real daemon and tasks-axi, a fixture work home (two projects, one already registered here, a plan with a landed phase, a held task, a task with no project, a done task, an open and a done to-do) moves into a two-scope main home under the work scope: the backlog adds, holds and kept edge, the dropped landed edge, the plan's next free id and copied phases, the policy rows, the work scope of every moved task, the event and the marker; a rerun only rewrites the marker; the old daemon then exits 0 with `home_adopted`; each refusal (old daemon up, lock held, a run not ended, an open decision, an open review gate, a pending write, an older schema, a task In flight, a project outside the scope's rules, no scope to take, an unknown login, a project id at another path, a task id clash) moves nothing; `--scope`; this home itself and a non-home folder; an agent's call refused.
- `test/unit/home-adopt.test.ts`: the assumptions: tasks-axi's `--blocked-by` needs its blocker to exist (blockers added first); a landed blocker would never land here (edges dropped); the scope by the old login's real path; launchd leaves a clean exit stopped; an unreadable marker still marks a home adopted; an adopted plan phase keeps every column (model and effort included, which the first build dropped: home adopt and per-phase model and effort landed in parallel) and a policy row every column, compared with `SELECT *` so a column a later migration adds fails until the copy carries it.
- Run 2026-10-24: the full `bun test` passed (unit 1895, integration 393), typecheck and oxlint clean.
