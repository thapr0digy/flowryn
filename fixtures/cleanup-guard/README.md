# Cleanup-guard fixtures

This directory holds 21 fixtures for Flowryn's cleanup guard (the unlanded-work
guard in `docs/design-v3.html`, section 14). They do not depend on any language.
Each fixture builds a real git state and a fake forge, then says what the guard
must decide. Flowryn's guard must pass all 21 before it is used. Any other
implementation can be checked against them too.

## Where they come from

The cases are ported from the previous orchestrator's `tests/fm-teardown.test.sh`
("the reference" below) at commit
**`a09090d1`** (`a09090d13ef24ce3cf71d171ade119896d6db301`, 2026-09-19). Each
case keeps its reference name, so the two suites can be compared. Its
`manifest.json` names the source test (`ported_from`) and the row in that
file's header matrix (`reference_matrix_row`).

Each fixture uses the same git topology and forge answers as its reference
test. The deliberate differences:

- **The forge is data.** The reference faked the forge with `gh` and `gh-axi` shell
  mocks. Here the answers live in `forge.json`, and `bin/gh` is a small
  gh-compatible reader of that file. The reference's `pr list` mock returned PR 7
  whatever `--head` was asked for. Here PR 7 is returned only for
  `--head fm/task-x1`. All 21 cases ask for that branch, so no answer changes.
- **`refs/pull/7/head` exists on origin** whenever the forge reports PR 7, as
  it would on GitHub. The primary checkout never fetches `refs/pull/*`, so no
  commit becomes reachable from a remote-tracking branch because of it.
  The reference's `commit_tree_from_wt_head` PR heads still exist as unreferenced
  objects in the local object store, exactly as in the reference.
- **Guard inputs replace the reference's `state/task-x1.meta`.** `pr=` becomes
  `inputs.recorded_pr_url` and `pr_head=` becomes `inputs.recorded_pr_head`.
  `--force` becomes a human-channel discard approval
  (`inputs.discard_approval`). Running `fm-pr-check.sh` becomes the
  `record_pr` operation.
- **Builds are deterministic.** Host git config is ignored, the identity is
  fixed, signing is off, and a per-scenario clock sets commit dates. Every
  build produces the same SHAs, wherever it is built.

The reference applies the same landed-work rules to every mode except local-only.
None of its 21 cases uses the direct-PR mode, so no fixture does. A direct-PR
task should get the no-mistakes verdicts.

## Layout

```
run.sh                     runner (validation, and --impl mode)
lib/build-common.sh        shared builders (fx_init, fx_wt_commit_file, ...)
lib/fake-gh.sh             gh-compatible fake forge, copied to <scenario>/bin/gh
reference/reference-oracle.sh   runs ORIGINAL reference logic in the --impl contract
<case>/manifest.json       what the guard is told, the forge, the expected verdict
<case>/build.sh            build.sh <out-dir>: builds the scenario
```

A built scenario (`<case>/build.sh <out-dir>`) contains:

| Path | What it is |
|---|---|
| `origin.git/` | bare upstream with `HEAD -> refs/heads/main` |
| `primary/` | clone of origin (the reference's "project" checkout) |
| `worktree/` | linked worktree of `primary` on the task branch `fm/task-x1`; the tree the guard judges |
| `fork.git/` | only in `local_only_fork_remote`; registered as remote `fork` |
| `scenario.json` | concrete paths, operation, inputs, and the table that maps each symbol to a SHA (`refs`) |
| `forge.json` | the fake forge's concrete answers; the source of truth for the forge |
| `expected.json` | the expectation with its symbols resolved; the runner moves it out of the directory before an implementation runs |
| `bin/gh` | optional fake `gh` serving `forge.json` |

## Manifest schema

```jsonc
{
  "name": "squash_merged_branch_deleted",        // must equal the directory name
  "ported_from": "tests/fm-teardown.test.sh:test_squash_merged_branch_deleted_allows",
  "reference_matrix_row": "g",
  "description": "...",
  "delivery_mode": "no-mistakes",                // local-only | no-mistakes | direct-PR
  "inputs": {                                    // what the guard is told
    "operation": "cleanup",                      // cleanup | record_pr
    "task_branch": "fm/task-x1",
    "kind": "ship",
    "recorded_pr_url": "https://github.com/example/repo/pull/7",   // or null
    "recorded_pr_head": "pr_head",               // symbol or null
    "pr_url_to_record": null,                    // record_pr only
    "discard_approval": null                     // or {"action": "discard", "channel": "human"}
  },
  "forge": {                                     // static description of the fake forge
    "reachable": true,                           // false => every call fails ("error": "unreachable")
    "pull_requests": [
      {"number": 7, "head_ref_name": "fm/task-x1", "state": "MERGED", "head": "pr_head"}
    ]
  },
  "expected": {
    "verdict": "allow",                          // allow | refuse | record | discard
    "reason_class": "merged_pr_contains_head",   // stable slug, see below
    "recorded_pr_head": "pr_head",               // record only: a symbol
    "pr_url": "...",                             // optional: the PR the guard relied on
    "then_cleanup": {"verdict": "refuse", "reason_class": "..."},             // optional, record cases
    "without_discard_approval": {"verdict": "refuse", "reason_class": "..."}  // discard case
  },
  "invariants": [                                // topology facts the runner verifies on every build
    {"check": "on_remote_tracking", "ref": "local_head", "expect": false}
  ]
}
```

**Symbols** are names for commits. `build.sh` gives each symbol a SHA and
writes the mapping to `scenario.json.refs`. Every scenario defines
`local_head` (the worktree HEAD), `primary_main` (the primary's local `main`),
`tracked_origin_main` (the primary's `refs/remotes/origin/main`, which can be
stale) and `origin_main` (the real `main` in `origin.git`). Some cases add
their own symbols: `pr_head`, `fork_branch_head`, `local_parent`,
`pre_rebase_head` and `squash_commit`.

**Invariant checks**:

| Check | Meaning |
|---|---|
| `on_remote_tracking` | `ref` is reachable from some `refs/remotes/*` in the primary |
| `remote_branch` | `branch` exists in the named remote's bare repo |
| `ancestor` | `ref` is an ancestor of `of` |
| `same` | `a` and `b` are the same commit |
| `content_in` | a 3-way `merge-tree` of `ref` with `local_head` produces `ref`'s tree, so `local_head` adds nothing new; a conflict counts as false |
| `patches_in` | every commit in `local_head` that is not on a remote has a patch-id in `merge-base..ref` (the reference's replay check) |
| `dirty` | the worktree has uncommitted changes |

**Reason classes**:

| Verdict | Slug | Meaning |
|---|---|---|
| allow | `on_remote_tracking_branch` | HEAD is on a remote-tracking branch of origin or a fork |
| allow | `merged_to_local_default` | local-only work is on local `main` |
| allow | `merged_pr_contains_head` | the PR reads merged and HEAD is its head or an ancestor of it |
| allow | `merged_pr_contains_patches` | the PR reads merged and every unpushed local patch is in it |
| allow | `content_in_default` | the content is already in a freshly fetched default branch |
| refuse | `unpushed` | local-only work is on no remote and not on local `main` |
| refuse | `unlanded` | the work is on no remote, has no merged PR, and its content is not in the default branch |
| refuse | `not_in_merged_pr_head` | the PR is merged, but the local work is not contained in its head, and the content is not in the default branch |
| refuse | `forge_unreachable_content_absent` | the forge fails, and the content is not provably in the default branch |
| refuse | `dirty` | the worktree has uncommitted changes; this always wins |
| record | `forge_pr_head` | the recorded PR head comes from the forge, never from the local HEAD |
| discard | `discard_approved` | unlanded work is discarded only because a human-channel discard approval exists |

## Implementation contract (`run.sh --impl '<command>'`)

For each case, the runner builds a fresh scenario and runs:

```
<command> <scenario-dir>
```

- The working directory is `<scenario-dir>`.
- `PATH` starts with `<scenario-dir>/bin`, so a `gh`-based forge adapter
  reaches the fake forge. `FLOWRYN_FAKE_FORGE` points to `forge.json` and
  `FLOWRYN_SCENARIO` points to `scenario.json`.
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` are set.
- The implementation reads `scenario.json`: the operation, the inputs, and the
  paths.
- It must not read `expected.json`. The runner has already moved that file
  away.

The implementation exits 0 and prints one JSON object on stdout:

```json
{"verdict": "allow|refuse|record|discard", "recorded_pr_head": "<sha>|null",
 "reason_class": "<slug>", "pr_url": "<url>|null"}
```

- `verdict` is required and must match the manifest.
- `recorded_pr_head` must be the resolved SHA for a `record` verdict. It must
  be null or absent for every other verdict.
- `reason_class` is optional. If present, it must match the manifest.
- `pr_url` is checked only when the manifest expects one
  (`no_pr_recorded_discovers_merged_pr_by_branch`: the guard must report the
  PR it found from the branch name).
- A non-zero exit, or output that is not JSON, fails the case.

The runner also checks what the implementation leaves behind and runs some
cases a second time:

- **Retention.** After a `refuse` or `record`, the worktree must still exist,
  still be on `fm/task-x1`, and still have HEAD at `local_head`.
- **`without_discard_approval`.** Before the discard run, the runner removes
  `inputs.discard_approval` and runs the implementation once. That run must
  refuse and leave the worktree intact.
- **`then_cleanup`.** After a record run, the runner rewrites `scenario.json`
  as a `cleanup` operation. The new `recorded_pr_url` and `recorded_pr_head`
  are the ones just recorded. It then runs the implementation again, and that
  run must return the expected verdict.

## Running

```sh
fixtures/cleanup-guard/run.sh                                  # validate all 21 fixtures
fixtures/cleanup-guard/run.sh --impl 'node dist/guard-cli.js'  # check an implementation
REFERENCE_REPO=<checkout> fixtures/cleanup-guard/run.sh --impl "$PWD/fixtures/cleanup-guard/reference/reference-oracle.sh"
fixtures/cleanup-guard/run.sh --case dirty_worktree --keep     # one case, keep the build
```

The default mode checks, for every case:

- **The suite:** exactly 21 cases, the names from the design, and the verdict
  counts: allow 10, refuse 8, record 2, discard 1.
- **The manifest:** the schema, and a verdict that matches the design list.
- **The build:** it succeeds and produces its output files.
- **The symbols:** every one resolves to a real commit in the built repos.
- **The invariants:** each holds on the built repos.
- **Determinism:** a second build produces the same SHAs.

The runner needs bash, jq, and git 2.38 or newer (for
`merge-tree --write-tree`).

`reference/reference-oracle.sh` runs the reference's (the previous orchestrator's)
own `fm-teardown.sh` and `fm-pr-check.sh` against the built scenarios. It runs from a `git archive`
copy under `$TMPDIR` with every home, state, data and config path redirected,
and with treehouse, tmux, no-mistakes and lsof stubbed. Its host-wide orphan
sweep is replaced by a no-op. At `a09090d1` it agrees with all 21 expected
verdicts. `REFERENCE_REPO` names the reference checkout and is required;
`REFERENCE_REV` picks a commit (default `HEAD`).
