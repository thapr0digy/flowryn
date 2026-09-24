# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The design spec is `docs/design-v3.html`. Its M0 badges (Pi included) were resolved by the spikes; `docs/m0-verdicts.md` is the record of what each platform behavior actually does and which design text changed. Read it before building on any harness, Pi, Herdr or tasks-axi behavior.
- Anything that drives Herdr (spikes, contract tests) must go through Firstmate's `fm-herdr-lab.sh` via `spikes/lib/lab.sh`, never the default session. Scrub inherited `CLAUDECODE`/`CLAUDE_CODE_*` env before provisioning (`lab_scrub_env`), or launched harnesses run as child sessions of yours.
- Run the spikes with `spikes/run-all.sh [group]` (README "Running the M0 spikes"). Herdr needs socket access, so run them outside a command sandbox.
- Pi contract tests use the offline scripted model in `spikes/pi/lib/scripted-provider.ts` and a scratch `PI_CODING_AGENT_DIR`, never a paid model or `~/.pi`; `spikes/pi/NOTES.md` has the script syntax and the opt-in real-model pass.
- The cleanup guard must pass `fixtures/cleanup-guard/run.sh --impl <cmd>` before it is used.
- Product code is TypeScript on Bun; dev commands are in README "Development". `bun test` starts real daemons on Unix sockets, relies on FSEvents and runs the real tasks-axi 0.2.5, so run it outside a command sandbox. Inside one, `bun install` also needs `BUN_TMPDIR` and `BUN_INSTALL_CACHE_DIR` pointed at a writable temp directory.
- `docs/m1-notes.md` records the choices M1 made where the design leaves room (roles before the lease manager, journal ordering and failure classes, stale-buffer re-apply). Extend it, or its successor for a later milestone, rather than rediscovering them.
- Every tasks-axi mutation goes through `recordIntent` in the same transaction as its runtime change, and every mutation of `flowryn.db` appends an event in its transaction (`src/db/events.ts`). Never call tasks-axi or write the database from anywhere else.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
