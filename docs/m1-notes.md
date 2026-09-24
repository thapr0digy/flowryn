# M1 notes

M1 builds section 17's "M1 · Core" of [`design-v3.html`](design-v3.html). This file records where the design left room and what M1 chose, so M2 to M5 build on the same ground. Each item names the code that holds it.

## Roles in M1

- **Your own terminal is a role.** The design lists `todo` and `project` as leader verbs, and `init` registers projects. In M1 there is no lease manager yet (M3), so a token-less call from your own terminal is the `human` role and may run the to-do and project verbs as well as the human-only ones. "Your own terminal" means no `FLOWRYN_TOKEN` or `FLOWRYN_RUN` in the environment, and stdin or stdout is a TTY. Like the approve challenge, this is confused-agent-grade: a Claude Code Bash tool has neither. A token-less caller that fails the check is `anonymous` and may only ping (`src/api/auth.ts`, `src/cli/human.ts`).
- **An unknown token is refused (`bad_token`, exit 77), never downgraded to human.** A stale leader token must not act as you.
- **`report` is the first worker verb and the first spooling verb.** It records a `worker.report` event and nothing else. The other worker verbs (`ask`, `deliver`, `fail`) arrive with the runs that use them in M2 (`src/lifecycle/worker.ts`).
- The socket also serves two internal verbs the CLI uses: `daemon.ping` (the handshake, allowed for every role) and `daemon.stop` (human only).

## The intent journal

- Intents apply one at a time, in `seq` order **per file**. A failing head blocks later intents for the same file, because order matters (an add before its done), but not the other file (`src/journal/journal.ts`).
- tasks-axi failures are classified. `LOCKED`, a timeout, a missing binary and unexpected output are transient: they retry at 1 s, 5 s, 30 s, 2 min, then every 10 min, and a P1 "backlog out of sync" item opens after 5 failures. `VALIDATION_ERROR`, `NOT_FOUND` and exit 2 are permanent: the intent is marked `failed`, the item opens at once, and later intents proceed. When the lock is the cause, the item names the lock path, because tasks-axi never breaks a stale lock (M0 finding 8).
- `add` is replay-safe because tasks-axi 0.2.5 answers a repeated add with `already: true` (M0 t01). If a later version refuses a repeat instead, the journal checks `show <id>` before counting a permanent add failure.
- An attempt is counted in the same transaction as its outcome and its event, so an attempt cut short by a crash does not count.
- After each applied intent, the journal stores the file hash (read first) and a fresh `list --fields` parse, in one transaction with the `intent.applied` event. That event also records the task as it read before and after the intent; the watcher uses them.

## The backlog watcher

- It watches the directory, not the file, because tasks-axi replaces the file. A 60 s hash check backs up the watch (`src/journal/watcher.ts`).
- Your edit wins. A changed title, body, priority, dependency, hold or done state is recorded as a `backlog.edited` event and becomes the new snapshot. It is not reverted.
- Before every journal write, the journal compares the file with the snapshot hash. If they differ, it runs the watcher's diff first, under the same file lock. Otherwise the read after the write would absorb an unnoticed edit, such as one made while the daemon was down, without recording it or checking it against live runs. After a crash between a tasks-axi write and its "applied" mark, that write shows up once as an edit (reason `before-write`) before the replay confirms it.
- **Stale editor buffers.** An intent applied within the last hour (`ERASE_WINDOW_MS`) counts as erased when the task now reads exactly as it did before that intent, on every field the intent set, and the intent had changed something. An erased intent is recorded again and applied. Once one intent on a task counts as erased, every later intent on that task in the window goes back too, in order, so the task ends where the journal last left it. A task you deliberately revert by hand within that hour is therefore re-applied. Change it through `flowryn` instead, or wait. An editor that keeps overwriting is left alone after 3 re-applies (`MAX_REAPPLY_DEPTH`).
- Titles are compared with PR URLs stripped, because `done --pr` appends them (M0 finding 7).
- A hand edit that moves or removes the task of a live run opens a divergence (`higher: run`, `lower: backlog`) and a P1 item, and leaves the run untouched. `flowryn divergence resolve` arrives with runs in M2.

## To-dos

- Ids follow the tasks-axi house style, a title slug plus two characters (`renew-passport-k3`), minted by flowrynd so a replay names the same task.
- tasks-axi cannot store an empty body. Clearing the due date of a to-do with no notes writes `due: none`, which reads as no due date (`src/lifecycle/todos.ts`).
- A to-do mutation waits up to 3 s for the journal and reports `intent_state: applied` or `pending`. If tasks-axi refuses the change, the command fails with `rejected_by_tasks_axi` (exit 3).
- Overdue to-dos show in `todo list`. The P1 "overdue to-do" item and the morning briefing come with the attention router in M3.

## Daemon, service and setup

- Startup order: flock the state directory, check the socket (a live answer means refuse; a stale file is removed), open and integrity-check the database, migrate, bind, replay intents, ingest the spool, read both tasks-axi files, then serve. Socket calls wait until startup finishes; spool ingest runs inside it (`src/daemon/daemon.ts`).
- The launchd agent uses `KeepAlive` with `SuccessfulExit = false`. A crash or a kill restarts the daemon, and `flowryn daemon stop`, a clean exit 0, stays stopped. Each Flowryn home gets its own label, so a second install never replaces the first (`src/service/launchd.ts`).
- `init` resolves tool symlinks as section 15 asks, unless resolving adds a version-numbered directory, such as a Homebrew `Cellar` or Claude Code's `versions/`. That path breaks on the tool's next update, so init keeps the stable link instead. A path that is versioned either way (nvm) is resolved and flagged (`src/init/init.ts`).
- The nightly `VACUUM INTO` backup runs in the daemon's 60 s maintenance pass, once per local day, keeping 7. `flowryn doctor --restore [--backup <date>]` swaps one in while the daemon is stopped, and keeps the replaced database aside.
- `flowryn doctor --contracts` reports that the harness contract suites arrive with the worker adapters in M2.
- `events` is enforced append-only by triggers, in addition to the design's schema.
