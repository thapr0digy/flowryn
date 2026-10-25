# A leader per scope

- Status: partial
- Open: `flowryn home adopt` (moving `~/.flowryn-work` into the main home) is phase 2 of plan p19; two leaders on two real logins have not run live; the folder guard reads a shell command's words, so a path built at run time slips past it (the same limit as the other toolkit rules)
- Config: no new keys: a leader's scope comes from `[accounts.<id>] scope` (docs/notes/2026-10-22-multiple-ai-provider-u9.md)

Work and personal projects could already share one Flowryn home (phase 1 of the multiple-accounts plan), but a home had one leader, and it read every task. Now each scope has its own leader. A leader started on the work login sees and acts on work tasks only; one on the personal login sees personal tasks only. The design was reviewed at gate g202; the user chose "leader per scope" at gate g159.

## Which scope a leader leads

`flowryn lead [--pi] [--account <id>]` picks the account the leader runs on, in your terminal:

1. `--account <id>`, which must be an account of the harness.
2. Else the account whose login folder is the one your terminal points at: `CLAUDE_CONFIG_DIR` (unset: `~/.claude`) for Claude, `PI_CODING_AGENT_DIR` (unset: `~/.pi/agent`) for Pi, compared by real path. None or several refuse and list the accounts.
3. A harness with no declared account has one implicit account, so a home without `[accounts]` needs nothing and behaves as before. The implicit account leaves your terminal's login alone: `[workers.claude] config_dir` is the workers' login, not the leader's.

The harness then starts on that login the way a worker does (`src/leader/login.ts` `applyLogin`): `CLAUDE_CONFIG_DIR` set to the account's folder, or unset for a declared account without one, and the credential variables Claude ranks above a stored login (`CLAUDE_CREDENTIAL_ENV`) dropped; a Pi account gets `PI_CODING_AGENT_DIR` and `--provider`/`--model`. `lead.open` records the account and its scope on the session (`leader_sessions.account`, `.scope`); the daemon takes the scope from config's account, never from the caller.

The session's first hook confirms the login (`confirmLogin`): `flowryn hook session-start` reports the login folder in its own environment, and Claude's `transcript_path` must sit under `<account folder>/projects`. A mismatch leaves the session in no scope (`scope = ''`): it claims nothing, sees nothing, and its banner says to start the leader again. The event is `leader.scope_unconfirmed`. Logging in again from inside a running Claude session keeps the same folder, so Flowryn cannot see that; start a new leader instead.

## One lease per scope

`leader_lease` has one row per scope (migration 33; `id` stays the rowid, its `id = 1` check is gone, `scope` is unique). A session's token is the leader of its scope while that scope's lease names it, and a read-only reader of its scope otherwise. Two leaders of two scopes both lead at once; a second session of the same scope is read-only, as before. Each holder has its own epoch, approval key (Pi), waiter, rewake state (`meta` key `leader_rewake:<session>`, removed when the session closes) and wake budget.

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
- The toolkit rule `scope-paths` (`src/policy/toolkit.ts`), evaluated in the leader's hook process, refuses Read, Grep, Glob, LS, Find, Edit and Write paths, and any shell word, redirect or `tasks-axi` file, under a denied path: Flowryn's shared stores (`src/policy/scope-paths.ts` `sharedStores`) and the leader's scope's list of other scopes' folders.
- The daemon keeps one list per scope in `<state_dir>/leader/scope-deny/<scope>.json`: other scopes' project checkouts, their `data_dir/worktrees/<project>/`, their task folders `data_dir/<task>/` (review pages, reports), their runs' worktrees, `state_dir/runs/<run>/` and spool folders (`src/leader/scope-guard.ts`). It rewrites them within a second of a project, task or run appearing; the hook reads its file on every call, so a refusal holds with the daemon down. `flowryn lead` puts the scope in the leader's environment (`FLOWRYN_LEADER_SCOPE`); a leader without one is denied every list.

Workers are not guarded this way: a worker already runs only on an account of its project's scope.

## Chat-answer grants

A grant is checked against the transcript under the leader session's own account's projects folder (`sessionProjectsDir`): `<config_dir or ~/.claude>/projects` for a declared Claude account. The implicit account keeps `[grants] claude_projects_dir`, or the default from the daemon's environment, as before. This fixes the work home's queued bug (`flowryn-chat-answer-ij`) once its work runs from the main home on `claude-work`.

## Choices made in the build

- The account is bound at `lead.open` from your terminal (the human channel) and confirmed by the first hook, rather than taken from the hooks alone: the hooks run inside the leader's process tree.
- A failed confirmation leaves the session in no scope rather than refusing its hooks, so the harness runs and its banner says what is wrong.
- Away mode stays one posture for you. Automatic away needs you inactive in every holder's session. The pending return brief and the "decided since the last briefing" marker (`last_briefing_at`) stay shared, so a second leader may miss a return brief the first one took; a per-scope split was not worth a second migration.
- The contract suite proves what the harness does with Flowryn's bridge, which this change does not alter (the leader launch adds environment, not hook behaviour), so `CONTRACT_REVISIONS` is unchanged.

## Tests

- `test/unit/leader-scope.test.ts`: every leader-reachable verb has a scope rule, and a verb without one refuses a scoped caller; task, run, item, decision, plan and merge references resolve to their project's scope; tasks a scoped leader creates stay in its scope; the gateway check refuses and records out-of-scope references and passes your terminal; two leases in two scopes; an unconfirmed session claims nothing; migration 33's legacy lease moves to `[scopes] default`; pushes, digests and the briefing carry one scope and count the other; the broken assumption (task-less items name tasks) and its neutral line; notifications labelled by scope; account choice by login folder and `--account`; the launch environment per account; a home with no `[accounts]` leads as before; login confirmation; the grants' projects folder; the folder guard's tool, shell and `tasks-axi` cases; the per-scope lists; the leader settings' read denies.
- `test/integration/leader-scope.test.ts`: through the real daemon, CLI and leader hooks, a work leader on the work login and a personal leader on the personal login run side by side. Every work task carries a marker word: the personal leader's briefing, digest and `fleet`, `brief`, `decision list`, `project list`, `accounts`, `capacity` and `stats` never show it; `show` and `steer` of the work task refuse with `scope_refused`; your terminal sees both; the personal leader's hook refuses `cat` of the work checkout; a leader whose transcript is under the other login leads nothing and sees nothing.
