# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The design spec is `docs/design-v3.html`. Its M0 badges were resolved by the spikes; `docs/m0-verdicts.md` is the record of what each platform behavior actually does and which design text changed. Read it before building on any harness, Herdr or tasks-axi behavior.
- Anything that drives Herdr (spikes, contract tests) must go through Firstmate's `fm-herdr-lab.sh` via `spikes/lib/lab.sh`, never the default session. Scrub inherited `CLAUDECODE`/`CLAUDE_CODE_*` env before provisioning (`lab_scrub_env`), or launched harnesses run as child sessions of yours.
- Run the spikes with `spikes/run-all.sh [group]` (README "Running the M0 spikes"). Herdr needs socket access, so run them outside a command sandbox.
- The cleanup guard must pass `fixtures/cleanup-guard/run.sh --impl <cmd>` before it is used.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
