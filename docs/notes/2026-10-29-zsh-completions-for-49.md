# zsh completions

- Status: done
- Open: bash and fish are not built (refused with a message); CI runs no zsh tests (its ubuntu-latest image has no zsh), the Mac run does

Tab completion for `flowryn` in zsh: every verb and sub-verb, each verb's flags, the values of flags and positionals with a fixed set, and ids from local state. The design was reviewed at gate g246. No model anywhere: the script is printed from the command registry the parser reads.

## Install

```zsh
# in ~/.zshrc, after compinit:
source <(flowryn completion zsh)
```

Or save it as a file zsh autoloads:

```zsh
flowryn completion zsh > ~/.zsh/completions/_flowryn   # a directory on $fpath, before compinit runs
```

A saved file is what that build printed: after upgrading flowryn, print it again, or new verbs and flags are missing. Sourcing at startup is always current. Without compinit loaded first, sourcing prints a one-line hint to stderr and does nothing else.

## What completes

- `flowryn <Tab>`: every top-level word with its summary; `flowryn decision <Tab>`: `add`, `list`, `defer`. A word that is both a verb and a parent (`verify` and `verify show`, `capacity`, `completion`) offers its sub-verbs and its own first argument together.
- The verb is found as `src/cli/argv.ts` finds it: the longest run of up to three leading words, with `--json`, `--help` and `-h` allowed anywhere and the first other flag ending the run.
- Flags: each verb's own, with its help, plus `--json`, `--help` and `-h`. A flag already given is not offered again, except list flags (`--blocked-by`, `--after`, `--blocks`), which repeat.
- Fixed values: `--kind` (ship, scout), every `--harness` (claude, pi), `--mode` (no-mistakes, direct-PR, local-only), `--autonomy` (plan, manual), `--effort` (every level some harness takes), `project set --yolo` (on, off), `todo list --due` (today, overdue), `report <status>` (finding, blocked, failed, progress), `divergence resolve <resolution>` (keep-run, accept-edit), `completion <shell>` (zsh).
- Files: `--*-file` flags, and flags whose placeholder is `path` or `file`; directories for a `path` or `dir` positional.
- Ids: projects, tasks (every `task` or `target` positional, `--blocked-by`, `--task`, `decision add --blocks` and `--origin`), open decisions, to-dos, workflows, stages and accounts. Other ids (items, divergences, steers, verifications, lessons) complete nothing; type them.

## Spec hints

`FlagSpec` and `PositionalSpec` take two optional fields (`CompletionHint` in `src/api/verbs.ts`):

- `values`: the fixed set the value comes from. It points at the list the handler already checks against (`TASK_KINDS`, `HARNESS_IDS`, `DELIVERY_MODES`, `AUTONOMY`, `EFFORT_CHOICES`, `RESOLUTIONS`, `ON_OFF`, `DUE_FILTERS`, `REPORT_STATUSES`). It is a hint only: `validateArgs` does not enforce it, and the handler's own check and message stay as they were.
- `complete`: the id source looked up on Tab (`COMPLETION_SOURCES`).

A new verb or flag completes the moment it is in the registry. A new fixed set or id argument completes once its spec carries the hint.

## The id lookup

`flowryn completion values <source>` prints `id:description` lines for zsh's `_describe`, one per open thing:

| source | from | listed |
|---|---|---|
| project | the projects table | all, with their paths |
| task | the backlog snapshot | not Done, with titles |
| todo | the to-dos snapshot | not done, with titles |
| decision | the decisions table | open, with the question |
| workflow | config (`workflowsConfig`) | built-in and `[workflows]`, with their stages |
| stage | config | every stage of every workflow |
| account | config (`accountsConfig`) | all, with harness and scope |

- It opens `flowryn.db` read-only (`busy_timeout` 250 ms) and never the daemon's socket, so a busy or stuck daemon cannot hold a prompt, and it works with the daemon down. A WAL reader does not wait on a writer's lock (tested).
- Scope: a leader or reader token (`FLOWRYN_TOKEN`) sees only its scope, through `lensFor` as the list verbs do, accounts included. A run token sees nothing (workers never press Tab). No token is your terminal and sees everything: anyone without a token who runs as you can read the database file anyway, and the lens is there for confused agents, which always carry a token.
- Any failure (no config, an invalid config, no database, a token that names nothing, a locked or older database) prints nothing and exits 0, so Tab offers nothing. With no database yet, config's sources still answer your terminal. An unknown source is refused (`bad_args`), since only the script calls it.
- Cost: about 30 ms per lookup with the compiled binary on this Mac (the version command alone is about the same); a lookup's own read is measured under 50 ms in the tests.

## Files

- `src/cli/completion/model.ts`: the registry as a shell-neutral tree (verb words, each verb's arguments and what completes them). Another shell would be a new printer over it.
- `src/cli/completion/zsh.ts`: the zsh printer. One quoting step for each context (zsh single quotes, `_arguments` brackets and colon fields, value lists), so help text with quotes, colons, brackets or backslashes cannot break the script.
- `src/cli/completion/values.ts`: the id lookup.
- `src/cli/commands/completion.ts`: the two local verbs. They print plain text, not a reply. No wire change, so no `PROTO` bump.

## Tests

- `test/unit/completion.test.ts`: every verb's words are offered under their parent, every flag and positional is in its verb's block, every fixed value and id source is where its hint is, every `--harness` offers claude and pi, a verb added to the registry appears at once, awkward text is quoted, and `zsh -n` accepts the real script and an awkward one. Making the printer drop a kind of flag fails it (checked by hand).
- `test/integration/completion.test.ts`: the lookup per source, a scoped leader seeing only its scope, a run token, a bad token, no database and a broken config all printing nothing, a listening socket seeing no connection, the read under a held write lock, the read's cost; then a real zsh through `zpty` (`test/helpers/zsh-complete.zsh`, after Valodim's zsh-capture-completion): sourced and autoloaded from `$fpath`, verbs, sub-verbs, flags, fixed values and ids with titles, and no output when there is no database. zsh tests skip without zsh, and need a pseudo-terminal, so they run outside a command sandbox like the rest of `bun test`.
