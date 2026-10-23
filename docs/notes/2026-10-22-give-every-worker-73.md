# Every worker's own temp directory

- Status: done
- Config: `[workers] tmp_root`

On 2026-10-22 (decision q80), a worker ran its no-mistakes pipeline outside the Claude sandbox with `--intent "$(cat $TMPDIR/intent.txt)"`. Outside the sandbox, `$TMPDIR` is the user's shared `/var/folders/…/T/`. Another worker had written its own `intent.txt` there, so PR #98 was reviewed against the wrong task. Inside the sandbox it is no better: Claude sets `TMPDIR` to `/tmp/claude-<uid>`, which every sandboxed Claude on the machine shares. Now each run has a private directory, and its worker's `TMPDIR` names it both in and out of the sandbox. Everything here is plain code (paths, file modes, a sweep). No model is used.

## How Claude picks a sandboxed command's TMPDIR

Read in the Claude Code 2.1.309 binary: a sandboxed Bash command gets `TMPDIR=$CLAUDE_CODE_TMPDIR/claude-<uid>` (default root `/tmp`), whatever `TMPDIR` the session inherited. This holds only while that path is at most 44 bytes (`sir=44`; it warns "Shorten CLAUDE_CODE_TMPDIR to ≤~30 bytes"). Past that, it uses the shared `/tmp/claude-<uid>` and says nothing. An unsandboxed command inherits the session's own `TMPDIR` (seen live). So the one value that is the same in both places is `TMPDIR = CLAUDE_CODE_TMPDIR/claude-<uid>`, with a short `CLAUDE_CODE_TMPDIR`.

## The directory

| | Claude | Pi |
|---|---|---|
| Run dir | `<tmp_root>/<last 12 of the run id>` | the same |
| Pane env | `CLAUDE_CODE_TMPDIR=<dir>`, `TMPDIR=<dir>/claude-<uid>` | `TMPDIR=<dir>` (Pi has no sandbox) |
| Sandbox `allowWrite` | `<dir>` and its realpath (`/private/tmp/…` on macOS) | n/a |

- `[workers] tmp_root` defaults to `/tmp/fw-<uid>`. A state-dir path would be far over the limit. The default gives `/tmp/fw-501/<12>/claude-501`, which is 35 bytes, and a 7-digit uid still fits. A relative value resolves against the Flowryn home.
- **Made** by the launcher on every launch, resume and relaunch (`ensureRunTmp`, `src/lifecycle/run-tmp.ts`). `/tmp` is shared, so an existing path proves nothing. The root, the run dir and Claude's subdir must each be a plain directory (not a symlink) owned by this user with mode 700, or the launch fails. A `.flowryn-run` file in the run dir names its run and Flowryn home. A run whose id tail matches a directory another run or home owns is refused, never shared. A Claude path over 44 bytes is refused with a message naming `[workers] tmp_root`; letting it through would bring back the shared directory without saying so.
- **Removed** when `cleanupRun` ends with `removed`, after the worker has stopped and its processes are reaped (`removeTmp`, `src/lifecycle/landing.ts`). A failure is logged and recorded as `run.tmp_remove_failed`, and never fails the cleanup. At daemon start, `sweepRunTmp` removes the dirs this home owns whose run is gone or cleaned up, and any whose owning home is gone (a deleted contract scratch home). Another live home's dirs, and anything without an owner file, are never touched.
- A resume finds the same directory, with the worker's files still in it. Claude's own temp files (shell snapshots, task output, its scratchpad) now live in the run's directory too, and go with it.
- The worker contract says: "Keep scratch files in $TMPDIR: your run's own, the same path in and out of the sandbox."

## Contract

The suite has a new `temp dir` step, after the toolkit step for Claude and before the exit for both harnesses. A steer has the worker run `echo "$TMPDIR" > "$FLOWRYN_REPORT_DIR/tmpdir.txt"` with its own shell tool, and the step checks that the file names the run's own TMPDIR (the same directory by realpath). The suite now tests this, so `CONTRACT_REVISIONS` is claude 2, pi 2, and older passes are stale. The offline fake Claude (`test/helpers/fake-contract-claude.ts`) runs each Bash call with the TMPDIR Claude's sandbox would give it. Checked by mutation: without `CLAUDE_CODE_TMPDIR` the offline suite fails at this step with `TMPDIR /tmp/claude-501`. The scripted Pi model's script acknowledges the new steer (m7) and runs the command.

Live, 2026-10-23, `doctor --contracts --verify-only` with the user's Claude Bash sandbox enabled: Claude 2.1.309 passed with `TMPDIR /tmp/fw-501/7E57RVCD29QQ/claude-501`, and Pi 0.87.1 (scripted) passed with `TMPDIR /tmp/fw-501/40Q8P27J6FMH`. The first live pass left the Pi run's directory behind, because the scratch daemon stopped before its own cleanup reached it. The runner's teardown (`releaseOwned`, `src/contracts/owned.ts`) now also sweeps the scratch home's run dirs under `tmp_root`, which the manifest records. The root was empty after the second pass.

## Assumptions and their tests

| # | Assumption | Test |
|---|---|---|
| A1 | Sandboxed Bash gets `$CLAUDE_CODE_TMPDIR/claude-<uid>` when ≤ 44 bytes | contract step `temp dir` (passed live on 2.1.309, sandbox on); `test/unit/run-tmp.test.ts` "A1" |
| A2 | Unsandboxed Bash inherits the session's `TMPDIR` | `test/unit/harness.test.ts` (pane env); `test/integration/run-tmp.test.ts` (the worker process sees it) |
| A3 | The sandbox lets the worker write there | `allowWrite` asserted in the integration test; the live step writes the file |
| A4 | Pi's bash tool inherits the process env | `test/unit/run-tmp.test.ts` "A4"; the Pi contract step |

`test/integration/run-tmp.test.ts` runs two Claude runs and a Pi run at once. Each sees a different 700 TMPDIR under the root, and each writes its own `intent.txt` there. Cleaning one up removes only its directory, and a daemon restart keeps the live ones. Test homes get a short `tmp_root` of their own (`mkdtemp("/tmp/fwt-")`, `test/helpers/harness.ts`), so no test touches `/tmp/fw-<uid>`.

## Risks

- macOS may delete `/tmp` files that have not been accessed for 3 days (a guess: `periodic`'s `clean-tmps`). A worker parked that long could lose scratch files. The directory itself is made again on the next launch.
- Bumping the revision means every installed version needs a new contract pass at revision 2 before the harness gate lets a run start, as for any bump.
- A later Claude may change the 44-byte rule or the `claude-<uid>` suffix. The live `temp dir` step then fails, which is what it is for.
- The leader is unchanged: this task covers workers.
