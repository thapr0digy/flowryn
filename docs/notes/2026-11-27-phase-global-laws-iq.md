# Global laws: written once, enforced on every project

- Status: done
- Open: not run live through a real Claude or Pi session yet; a dev server bound to 8081 through a script or Makefile that names no port on the command line (`make dev`) is not seen

Phase 2 of plan p152. Phase 1 (docs/notes/2026-11-27-phase-the-laws-ib.md) made each project's AGENTS.md `## Rules and their checks` table its laws, checked by verify. This phase adds laws that hold for every project, enforced where the action happens: the tool-call hook for a shell command, verify otherwise.

## What the hooks already refused

None of these. Workers were told in prose (the stage contract's "Never rewrite pushed history", steers' "never rebase or force-push") and the merge-conflict hint even said "steer the worker to rebase"; that hint now says to merge the base in with a new commit. No hook refused a rebase, a force-push, a tag, a push of `.remember/` or a port.

## The built-in global laws

Each is a rule of the toolkit hook (`src/policy/global-laws.ts`, called from `src/policy/toolkit.ts`), so it is evaluated in the hook process and holds with the daemon down, for Claude (`flowryn hook pre-tool`) and Pi (`flowryn hook tool-check`). A denial records `toolkit.denied` like any toolkit rule, and its reason starts "Blocked by Flowryn's toolkit rule (<rule>)" and says what to do instead.

| rule | refuses | allows |
|---|---|---|
| `rebase` | `git rebase …`, `git pull --rebase`/`-r`/`--rebase=…`, for workers and leaders | `git rebase --abort`, `--quit`, `--show-current-patch`; `git pull --no-rebase` |
| `force-push` | `git push` with `-f` (in any short cluster), `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, or a `+refspec` | a plain push |
| `tags` | `git tag -f`/`--force`, `git tag -d`/`--delete`; creating a tag that is not `vMAJOR.MINOR.PATCH` (an optional `-pre` and `+build`); `git push --delete <tag>` or `:<tag>` on a tag-like ref; `gh-axi release create <tag>` with a bad tag | listing (`-l`, `--list`, `-n`, `--contains`, `--sort`, …), `git tag v1.2.0`, deleting a remote branch |
| `remember-push` | a `git push` whose unpushed commits touch a `.remember/` path | the same push once no unpushed commit carries one |
| `dev-port` | workers only: binding 8081 (`--port 8081`, `--port=8081`, `-p 8081:80`, `--publish=127.0.0.1:8081:80`, `0.0.0.0:8081`, `:8081`, `PORT=8081`, `*_PORT=8081`, an `*ADDR*`/`*LISTEN*`/`*BIND*` variable such as `LISTEN_ADDR=0.0.0.0:8081`, `python3 -m http.server 8081`) | reading the port (`curl`, `lsof`, `chrome-devtools-axi`, `ssh`, …), searching for it (`grep`, `rg`, `git`, …), a client's `BASE_URL=localhost:8081`; the leader |
| `laws-file` | an Edit/Write or shell write of `~/.flowryn/laws.md`, for workers and leaders | reading it |

`remember-push` is the one law that needs a fact: before it judges, the hook process reads each push's commits with `git -C <dir> log --format= --name-only --no-renames --diff-filter=d <revs> --not --remotes --` through `runBounded` (3 s). `<dir>` follows the line's `cd`s and `git -C`; `<revs>` are the refspecs' sources (`HEAD` when none, `--branches` for `--all`/`--mirror`, plus `--tags`); a source starting with `-` is dropped so it can never become a git option. A dry run or a delete is not read. A read that fails leaves the push unchecked, as a hook steps aside. Merge commits list no paths of their own, so merging `origin/main` in never counts its files, and deleted paths are not listed, so a commit that removes `.remember/` from the index pushes.

The static Claude layer (`src/policy/static.ts`) backs the hook up with plain prefixes: `git push --force`, `git push -f`, `git push --force-with-lease`, `git tag -f`, `git tag --force`, `git tag -d`, `git tag --delete`, and an `Edit` deny plus sandbox `denyWrite` on the laws file. There is no `git rebase` prefix: it would also catch `git rebase --abort`, which the hook allows.

## The global laws file

`~/.flowryn/laws.md` (`globalLawsPath`, under `FLOWRYN_HOME`) holds the user's own laws for every project: the same `## Rules and their checks` heading and `Rule | Enforced by | Proven on` table as a project's AGENTS.md. It is optional, and only the user writes it (the `laws-file` rule and the static layer deny every agent).

The built-in laws are not in the file: each is backed by a hook rule compiled into Flowryn, so a file row could hide a rule the hook still enforces, or show one it no longer has. `flowryn laws` and verify list them first, as `built in`.

A global row's Enforced by names only `` `hook: <rule>` `` (a toolkit rule) or `` `verify: <step>` `` (a step every project's verify must have). A file path fails the row: a file belongs in one project's table. Proven on is shown, not checked: a global law's proof lives in Flowryn's tests or another repository.

## Verify and `flowryn laws`

The `flowryn:laws` step checks the global laws first, on every project, then the project's table. A `hook:` enforcer holds when the rule is one of the toolkit's; a `verify:` one when the project has the step. Global results carry `global: true`. A project with no table now passes with `N global laws hold; no laws: AGENTS.md has no ## Rules and their checks table`. A global row that fails, or a laws.md whose table cannot be read, fails every project's verify (detail `… first: global: <rule>: <why>`) until the user fixes it.

`` `hook: <rule>` `` is also accepted in a project's own table.

`flowryn laws <project>` lists the global laws and then the project's, each with `scope` (`global` or `project`), `where` (`built in`, `~/.flowryn/laws.md:<line>` or `AGENTS.md:<line>`), its enforcer, Proven on and last result. A broken laws.md shows as a hint. The leader skill names `laws <project>` among its read verbs, and says a repeat becomes a law through the correct skill.

## Tests

- `test/unit/global-laws.test.ts`: each law's refused and allowed commands through `toolkitVerdict`, `isReleaseTag`, `pushSources` (cd, `-C`, refspecs, `--all`, `--tags`, dry runs and deletes skipped, an option-shaped revision dropped), and the laws-file rule for both roles.
- `test/integration/toolkit.test.ts`, "global laws": one deny per law through a Claude worker's real pre-tool hook, `remember-push` on a real repository with an unpushed `.remember/now.md` commit, each recorded as `toolkit.denied`; a merge, a clean push, `git rebase --abort`, `git tag v1.2.0`, another port and a curl to 8081 are allowed.
- `test/unit/laws.test.ts`: `hook:` enforcers parsed; built-in and laws.md rows read; a global row with a file or with prose fails and its Proven on is not checked; through the real runner, a laws.md row naming `hook: no-main-push` fails a project's verify and passes once it names `hook: force-push`, and `flowryn laws` shows it with the built-in rows.
- `test/unit/static-layers.test.ts`: the new prefixes catch force-pushes and tag moves, never `git rebase --abort`; the laws file is in the Edit deny and `denyWrite`.

Proven on for the AGENTS.md row: `test/unit/global-laws.test.ts` fails at 9b2f521 (the rules and the file do not exist there) and passes at HEAD.
