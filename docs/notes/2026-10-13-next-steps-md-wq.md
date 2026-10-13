# Why is this waiting: fleet, briefing, retention and export

- Status: partial
- Open: operation identity (package 1, PR #80 not merged) still leaves `explanations.operation` empty; decisions, gates and merges as explanation kinds
- Config: `[upkeep] explanations_keep_days`, `[upkeep] explanations_keep_per_run`

`docs/next_steps.md` package 3, its third slice, on top of the explanations table of the first (`2026-10-12-next-steps-md-wz.md`): the terse "waiting: … · next: …" pointer in `flowryn fleet` and the leader briefing, a bounded retention for closed rows, an opt-in redacted diagnostic export, and a count of unresolved waiting time per kind in `flowryn capacity`. No model: every line is read from the table.

## Design

### Fleet and briefing pointer

One helper, `waitingRuns(db)` (`src/attention/explanations.ts`): every run that is not terminal and has an open explanation, longest waiting first, with its newest open row and how many more it has. Both views read only it; nothing is recomputed from live state.

- **`flowryn fleet`** gets a top-level `waiting` table, one row per waiting run: `task`, `waiting` (the reason, at most 80 characters, plus ` (+N)` when the run has N more open rows) and `next` (the first unblock action, at most 60 characters, with its actor: `flowryn capacity resume --harness claude (captain)`, or `-` when the row names none). The fleet rows themselves are unchanged, so the table stays uniform. No waiting run, no field. Detail stays in `flowryn show <task> --why`.
- **The briefing** gets a section after "Needs you": `Waiting (N):` then one line per run, `- [<task>] waiting: <reason> · next: <action> (<actor>)`, at most 8 lines and `+N more: flowryn fleet`. No waiting run, no section (no "nothing" line: the briefing stays short). The return brief is unchanged.

### Retention

Closed rows are pruned by the upkeep pass (`src/upkeep/upkeep.ts`), first in each pass and also while the pass otherwise waits (it is one SQLite transaction, touching no checkout), by two bounds:

- **Age:** a row closed more than `[upkeep] explanations_keep_days` (default 30) ago is deleted.
- **Count per run:** beyond the newest `[upkeep] explanations_keep_per_run` (default 200) closed rows of a run, older closed rows are deleted, so one run that flaps cannot grow the table between age sweeps.

`0` turns either bound off. Open rows are never deleted, whatever their age. Each pass that deletes appends one `explanations.pruned` event (`{deleted, by_age, by_count, keep_days, keep_per_run}`) in the same transaction (the one-event-per-mutation rule). The `run.explained` events stay (events are append-only), so a pruned row's decision is still in the log; `show --timeline` lists only the rows kept.

Why both: age alone lets a pathological run add thousands of rows within the window; count alone keeps rows of long-finished runs forever.

### Diagnostic export: `flowryn diag export <task|run> --out <file> [--include-text]`

A new local verb, chosen over `show --export`:

- **The file is written by the caller's own process**, not the daemon. `show` is a read the daemon serves; giving it a write path would have the daemon (which runs outside every sandbox) write wherever a caller names. The local verb asks the internal read verb `diag.export` for the data over the socket and writes the file itself, so a leader inside its Claude sandbox can only write where its sandbox allows. The read verb is a plain read, so with the daemon down the read-only fallback serves it and the export still works.
- `show` stays a view; an export has its own flags (`--out`, `--include-text`) and its own refusals.

Roles: `leader` and `human` (not workers or read-only readers). The target resolves like `show` (a task's latest run, or a run id); not found exits 4.

The file is JSON, `format: "flowryn-diag/1"`, written with mode 0600 and refused when it already exists (`O_EXCL`; nothing is overwritten). It holds:

| section | what |
|---|---|
| `exported_at`, `flowryn` | when, and the daemon's version and build (or `read-only fallback`) |
| `text` | `redacted` or `included` |
| `run` | the run row, without `token_hash`; `stage_note` is free text and redacted |
| `stages` | the frozen workflow (`id`, `gate`, `skill`, `pools` per stage), the current stage and its state, and the run's pool leases (granted/released per stage) |
| `gates` | the run's gates; `feedback`, `comment` and `decided` redacted |
| `decisions` | the run's decisions; `question`, `options`, `answer`, `context`, `recommendation`, `rationale`, `note` and `blocks` redacted |
| `explanations` | the run's rows, open and closed, facts and unblock parsed |
| `events` | the run's events, newest 2,000 in order (`events_truncated` says how many were left out), payloads redacted as below |
| `config` | the effective configuration, `redactConfig(effectiveConfig(...))` (the `flowryn config` redaction) |

Redaction, unless `--include-text`:

1. A redacted text field becomes `<redacted: N chars>`, so its presence and size stay diagnosable.
2. Event payloads: values under free-text keys (`body`, `summary`, `text`, `question`, `answer`, `choice`, `options`, `context`, `recommend`, `recommendation`, `rationale`, `note`, `blocks`, `feedback`, `comment`, `line`, `full_line`, `words`, `prompt`, `title`) are redacted, and so is any other string that contains one of the run's decision or gate texts (an item line quoting a question).

Always, with or without the flag: every string anywhere in the export that looks like a token (the `TOKEN_LIKE` pattern `flowryn config` uses: `ghp_…`, `github_pat_…`, `sk-…`, `xox?-…`) becomes `<redacted>`, and the config snapshot is always redacted. Strings are cut at 4,000 characters, so the reply stays under the socket's 4 MB.

Never included: chat or harness transcripts (only `transcript_path`, a path), steer bodies (the `messages` table is not read), the token, anything outside this run. Nothing is uploaded; the verb prints the path, the counts and whether text was included.

### Measure: unresolved waiting time

`flowryn capacity` gets one `unresolved` field from the open rows: per kind, `<kind> <count> (longest <age>, total <age>)`, joined with ` · `, or `-`. One grouped query over the open-row index; cheap. Unnecessary interventions are not measured here (open).

### Files

`src/attention/explanations.ts` (`waitingRuns`, `pruneExplanations`, `unresolvedLine`), `src/lifecycle/leader-verbs.ts` (fleet), `src/attention/briefing.ts`, `src/config/upkeep.ts`, `src/upkeep/upkeep.ts`, `src/sched/verbs.ts` (capacity), `src/lifecycle/diag.ts` (new: the `diag.export` read and the redaction), `src/cli/commands/diag.ts` (new: the local verb), the two registries.

### Tests

- Fleet and briefing: a waiting run gets its line (reason, next action and actor; `(+N)` for more rows); a run with no open row, or only closed rows, gets none, and with nothing waiting the field and the section are absent; a terminal run's stray open row is not listed.
- Retention: by age (an old closed row goes, an old open row stays), by count per run (the newest N closed rows stay), `0` turns each off, one `explanations.pruned` event, none when nothing is deleted; the upkeep pass prunes even when it waits; config validation of the two keys.
- Export: through the real CLI against a daemon and against the read-only fallback; a token-looking config value (`[workers.pi] env`, an `extra_args` token, a token-like string in a decision) and a decision's question and answer text never appear in the file without `--include-text`, and do appear (except tokens and config secrets) with it; an existing file is not overwritten; the file is mode 0600; a worker token is refused; unknown target exits 4.
- Capacity: `unresolved` per kind with an open dialog and capacity row, `-` with none.
