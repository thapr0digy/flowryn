# Effective configuration: known sections and `flowryn config`

- Status: done

Package 5 of `docs/next_steps.md`: a typo in a section name is an error, and `flowryn config` shows the whole resolved configuration, both the file's and the running daemon's.

## Design

### The boundary

`parseConfig` kept every top-level key it did not know in `extra`, and each section parser reads only its own key out of `extra`. So a misspelled section was never read by anyone:

```toml
[notfiy]
macos = false
```

loaded, the daemon started and accepted the SIGHUP reload, and macOS notifications stayed on. The repro is `test/unit/config.test.ts` "known sections": `parseConfig` on that text returned without an error before this change (the four refusal cases failed; the two that check valid files passed).

`flowryn config` printed only `data_dir`, `state_dir`, `morning_hour`, the task files and `[tools]`. Nothing showed the policy, capacity, workflows, notifications, upkeep or any other section's effective values, and nothing showed what the running daemon had accepted: after an edit that a SIGHUP refused, the daemon kept its last valid config (it only logs the refusal), and the file and the daemon silently disagreed.

### The rule

1. **Registered sections.** `CONFIG_SECTIONS` in `src/config/config.ts` names every top-level table Flowryn reads: `tasks`, `tools` and the later sections (`herdr`, `workers`, `reconcile`, `leader`, `notify`, `away`, `grants`, `review`, `github`, `cleanup`, `policy`, `daemon`, `upkeep`, `validation`, `capacity`, `workflows`, `autonomy`, `sched`, `style`, `decisions`, `projects`), with the top-level keys `data_dir`, `state_dir` and `morning_hour` (`TOP_LEVEL_SETTINGS`). `parseConfig` refuses any other top-level key with `config_invalid`, naming the closest known one when it is within an edit distance of 2 (or a third of the name's length, whichever is larger; an adjacent swap counts as one edit): `[notfiy] is not a known section; did you mean [notify]?`, `morning_hours is not a known setting; did you mean morning_hour?`. With no close name it lists the known sections and settings. Dynamic names stay free: `[projects.<id>]` and `[workflows.<id>]` are sub-tables of the registered `projects` and `workflows`, so only the first path component is checked. Comments and the existing section shapes parse as before.
2. **One resolved snapshot.** `src/config/effective.ts` composes the existing section parsers into `effectiveConfig(config, env)`: one entry per section, each the parser's typed result (no parser is rewritten), plus the problems the parsers raised. Its resolver table is typed `Record<"core" | SectionName, …>` (`core` holds the three top-level settings), so a section added to the registry without a resolver fails `bun run typecheck`. The daemon's startup and SIGHUP checks, `flowryn init` and `flowryn doctor` take their section problems from this snapshot (`configSectionProblems`), so the list of what is validated and what is shown is one list. This adds `[grants]`, `[decisions]` and `[projects.<id>]` to the startup check, which the old list (`workerConfigProblems`, now removed) missed: a malformed one was refused only when first used. The snapshot's own views: `workflows` adds each workflow's `source` (`built-in`, `config`, or `config (replaces the built-in)`), `style` shows `terse`, its `source` and its length rather than the block's text, and `projects` shows each `[projects.<id>]`'s verify config.
3. **Defaults versus overrides.** An override is a value the file sets: `configOverrides(text)` lists the dotted path of every leaf in the file's TOML (`notify.macos`, `workflows.feature.stages`; an array is one leaf). Everything else in the snapshot is a default. This is the file's own wording, so it needs no per-parser bookkeeping, and a value set equal to its default still shows as set (it is pinned there).
4. **The daemon's accepted config.** A new read verb, `daemon.config`, returns the snapshot of the config the daemon is running on (the one `services.config()` returns), redacted, with when it was loaded and the last SIGHUP's outcome (`accepted`, or `rejected` with the error). It needs the running daemon: in the read-only fallback (daemon down) it refuses with `daemon_unavailable`, so the file is never shown as the daemon's. Roles: leader, reader, worker and human, as for the other reads; an anonymous caller (which may only ping) gets the file's view only. It is a new verb with no arguments, not a change to an existing verb or the envelope, so `PROTO` stays 6; an older daemon answers `unknown_verb`, which `flowryn config` reports as `it runs an older build without daemon.config (flowryn daemon restart)`. The CLI pings first, so a daemon that is down reads `not running` and the read-only fallback is never asked. The reply also carries `resolve_env`, the daemon's values of the only environment variables a resolver reads (`HOME` and `CLAUDE_CONFIG_DIR`, from which `[grants] claude_projects_dir` defaults).
5. **`flowryn config`.** It prints the file (path, whether it exists, `valid` or the error), the daemon (`not running`, `matches the file`, or `differs from the file in [notify], [capacity]` with the daemon's values of just those sections, its load time and a rejected reload's error), the overrides, and the effective sections. When the daemon answers, the file is resolved with the daemon's `resolve_env` over the caller's environment, so a difference is always the file against the accepted config, never the caller's environment against the daemon's; with no daemon, the caller's environment is used. `--section <name>` prints one section (`core` or a section name; a typo gets the closest name). When the file is invalid, the daemon's accepted snapshot (if it runs) is the effective view, labelled `effective_from: the running daemon`. `--json` prints the same data. It exits 0 even when the file is invalid (`file: invalid: …`, with `fix config.toml` and `flowryn doctor` as hints): it is the place to see what the daemon still runs on after a refused edit, and `flowryn doctor` remains the check that fails. The old view exited non-zero on an invalid file.
6. **Redaction.** Before anything leaves the snapshot (CLI or daemon reply), `redactConfig` replaces: every value of `[workers.pi] env`; any value whose key looks secret (`token`, `secret`, `password`, `passwd`, `api_key`/`apikey`, `credential`, `private_key`), except `[github] token_env`, which is a list of variable names, not values; and inside `extra_args` lists, the value of a secret-looking flag (`--api-key x`, `--token=x`) and any string that looks like a known token (`ghp_`, `gho_`, `ghs_`, `github_pat_`, `sk-`, `xox?-`). A URL's credentials in any string (its userinfo, and a secret-looking query value such as `?access_token=`) are replaced too, leaving the rest of the URL (`2026-10-13-next-steps-md-wq.md`). Redacted values read `<redacted>`. Paths, models and timings are not secret and show as they are. Overrides list a key's path (`workers.pi.env.KEY`), never its value. A known limit: the daemon's values arrive redacted, so a change to a redacted value alone does not show as a difference between the file and the daemon.

### Files

- `src/config/config.ts`: `CONFIG_SECTIONS`, `SectionName`, the unknown-section refusal with its suggestion.
- `src/config/effective.ts` (new): the resolver table, `effectiveConfig`, `configSectionProblems`, `configOverrides`, `redactConfig`, `differingSections`.
- `src/config/workers.ts`: `workerConfigProblems` removed; the daemon, `flowryn init`, `flowryn doctor` and the tests call `configSectionProblems`.
- `src/daemon/system-verbs.ts`: `daemon.config`. `src/api/verbs.ts`: `ConfigStatus` on `ReadCtx` and an optional `configStatus()` on `DaemonServices`. `src/api/gateway.ts` passes it. `src/daemon/daemon.ts` records the load time and each SIGHUP outcome.
- `src/cli/config-view.ts` (new): `configReport`, the pure view the `config` verb prints, and `checkSection`. `src/cli/commands/setup.ts`: the `config` verb (reads the file, pings and asks the daemon).

### Tests

- `test/unit/config.test.ts` "known sections": the refusals and suggestions, a `config.toml`-shaped file with comments, every registered section and dynamic project and workflow ids, and init's own defaults.
- `test/unit/setup.test.ts` "effective configuration": one snapshot entry per registered section; each entry equals its parser's result; refused sections; the startup check now covering `[grants]`, `[decisions]` and `[projects.<id>]`; overrides; redaction; and the report for no file, a matching daemon, a daemon on an older file, an invalid file with and without a daemon, `--section`, and secrets from either side.
- `test/integration/cli.test.ts` "flowryn config": a running daemon matching the file; an unread edit shown as a difference, applied by SIGHUP, then a `[notfiy]` edit refused on SIGHUP while the daemon keeps its last valid `[upkeep]`; a worker token seeing redacted values; the daemon down; and the daemon refusing to start on an unknown section.

### Migration

None: no persisted field changes. A config that names an unknown section stops loading; that is the point of the change. The daemon then refuses to start (as for any invalid config), and a SIGHUP with such a file is refused and keeps the running config (existing behaviour, now tested). `flowryn init` already says `existing config ignored: …` for an invalid file; it is unchanged.

### Out of scope

- No section parser is rewritten, no key is added or renamed, and README.md does not list keys (feature keys stay in their own notes files).
- `flowryn init` replacing an invalid config with defaults (pre-existing; it asks before writing).
- Tool resolution through PATH: `flowryn config` shows `[tools]` as configured; `flowryn doctor` checks what resolves.
- No live reload of `state_dir` (the daemon keeps its own until a restart; `flowryn config` now shows that as a difference).
