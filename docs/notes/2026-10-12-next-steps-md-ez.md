# Versioned harness contract compatibility

- Status: done
- Open: not run live (a real `doctor --contracts` against Claude and Pi in a lab session); no test forces a revision decision when adapter code changes (bumping stays a reviewer's call)

`docs/next_steps.md` package 4, first slice: a harness contract pass names the adapter and contract behaviour it proved, not only the harness version, so a behaviour change makes older evidence visibly stale while a docs-only or unrelated commit keeps reusing it. Plain code throughout, no model.

## Design

### The boundary

A pass is identified by `(harness, version)` alone. `recordPass` (`src/contracts/verbs.ts`) upserts `harness_contracts` on that key, and the gate (`checkHarness`, `unverifiedVersion` in `src/lifecycle/harness-gate.ts`) asks only `WHERE harness = ? AND version = ?`. The report and the `contract.passed` event carry the build, but nothing reads it back. So:

- A change to what the suite proves (how the Claude adapter launches, resumes or wires hooks; the Pi extension bridge; a contract step) keeps every old pass of the installed harness version valid. The gate lets dispatch through on evidence about behaviour that no longer exists.
- Using the build id to fix that would go the other way: every commit, a docs-only one too, would demand a new contract run (a paid one for Claude).
- The P1 and the automatic check dedupe on the harness version alone (`harness_flagged:<h>` holds the version, `unverifiedItemOpened` matches `$.version`, `settled()` compares the attempt's version), so even with a stale pass recognised, a version whose P1 was dismissed or whose automatic check already failed would never be flagged or checked again.

Repro (test first): a daemon whose database holds a pass for the installed version recorded before this change. Today `checkHarness` says `verified`; after it, it says `unverified` with the stale revision named.

### The rule

- **A compatibility revision per harness.** `CONTRACT_REVISIONS` in `src/contracts/revision.ts`: a hand-bumped integer per harness, starting at `1` for both. It is bumped in the same PR as a change to behaviour that harness's contract suite proves (its adapter and launch, the hook or extension bridge the worker path uses, a step in `src/contracts/suite.ts` for it); a docs, test or unrelated change never touches it. Revision `0` is reserved for passes recorded before revisions existed (*legacy*). The revision is a source constant, never derived from the build id, so two builds of the same revision reuse each other's evidence.
- **Identity of a pass: `(harness, version, revision)`.** `harness_contracts` gets `revision` in its primary key, so a pass at one revision never overwrites another (a human recording from an older CLI cannot replace a current pass with a stale one).
- **The gate requires the daemon's own revision.** `checkHarness` verifies only a pass at `(harness, installed version, CONTRACT_REVISIONS[harness])`. A version that has passes only at other revisions is `unverified` with `stale: [revisions]`, and every place that says why names it: the `contract_unverified` refusal ("passed only at contract revision 0 (before revisions), not revision 1"), the `harness_unverified` P1 line, the `harness.unverified` event (`revision`, `stale`), `flowryn doctor`'s contract check.
- **What the recording carries.** The suite's report records `revision` (the revision of the binary that ran it) and `context`: `platform` (`<os>-<arch> <release>`), `herdr` (`herdr --version` of the configured Herdr binary, null when it cannot be read) and `launch_profile` (the worker launch settings the suite ran with: Claude's model, effort, permission mode, pretrust and extra args; `scripted` for the Pi gate). `recordPass` writes them as columns and into `contract.passed`. Context is recorded and shown, not compared: making the Herdr version or the platform part of the identity would re-run paid suites on every Herdr update, which is a separate decision.
- **Where each recorder's revision comes from.** The verb's arguments do not change (no `PROTO` bump): the revision comes from the run's report.
  - The daemon's automatic check and the leader: the report must already pass `reportProblem` (passing, recording, this harness and version, the daemon's own build); it now must also carry the daemon's revision, else it is refused ("proves contract revision N, not this daemon's M"). Their records are therefore always at the current revision.
  - Your own terminal: authority unchanged (recordGrant is untouched; no report check). The record takes the report's `revision` when the report is readable and names this harness and version, and legacy `0` otherwise (an older CLI wrote no revision; a missing report proves none). A record that is not at the daemon's revision is still written, and the reply says `current: false` with the revision the gate needs, which `doctor --contracts` prints as a warning: recorded, but dispatch still refuses it.
- **Alert dedup and automatic attempts carry the revision.**
  - `harness_flagged:<h>` holds `{"version","revision"}` JSON; a plain version string (written before this) reads as revision 0, so after the upgrade the next check flags `(version, current revision)` afresh.
  - `unverifiedItemOpened` matches `$.version` and `$.revision` (missing reads as 0), so one P1 opens per `(version, revision)`: a P1 dismissed for the legacy pass does not hide the stale one.
  - `noteContractPassed` settles the flag and P1 when a pass for the flagged version is at the daemon's current revision, whatever revision the flag recorded (a legacy plain-version flag included); a pass at any other revision, such as a stale human record, settles nothing.
  - `AutoAttempt.revision` (missing reads as 0): `settled()`, `noteWaiting`, `activeAutoAttempt` and the refusal's "check queued/running" help compare version and revision, so a check that failed at an older revision runs again at the new one, once. Events `contract.auto_*` carry `revision`.
- **Strict vs relaxed recording authority is unchanged**: the same callers record in the same modes; only what a record says it proved changes.

### Migration (20, `contract-revision`)

`harness_contracts` is rebuilt with `revision INTEGER NOT NULL DEFAULT 0` in the primary key and nullable `platform`, `herdr_version`, `launch_profile`. Existing rows keep `passed_at` and `report_path` and get revision `0`, legacy. Giving them revision 1 is not provably right: the table holds no build, the build id in the event maps to a binary, not to a commit, and the adapter has changed under the same harness versions (the Herdr subscription and contract-stop changes of #69 among them). Legacy means a re-run:

- Under `[policy] mode = "relaxed"` on a daemon that can run the check (the normal installed setup), the gate flags the installed version at startup and the automatic check re-runs and records it at the current revision; nothing for you to do.
- Under strict, or on a development daemon, the gate opens the P1 naming the legacy pass and `flowryn doctor --contracts --harness <h>`, as for any untested version.

Automatic attempts in `meta.contract_auto:<h>` are left as they are: with no `revision` they read as revision 0, so a legacy `failed` does not block the re-run. Flags left as plain versions read as revision 0 likewise.

### Files

`src/contracts/revision.ts` (new: the constants, labels), `src/contracts/context.ts` (new: platform, Herdr version, launch profile), `src/db/schema.ts` (migration 20), `src/contracts/verbs.ts` (record identity and context, reply), `src/contracts/grant.ts` (`reportProblem` checks the revision), `src/contracts/report.ts` (the report carries revision and context; `reportFacts` reads them for a record), `src/contracts/runner.ts` (result carries revision and context; the scratch seed records at the current revision), `src/lifecycle/harness-gate.ts` (gate, flag, P1 dedup, refusal), `src/contracts/auto.ts` (attempt revision), `src/doctor/doctor.ts` (contract check), `src/cli/commands/setup.ts` (stale record warning), `test/helpers/harness.ts` (a stand-in `herdr` that answers a version), `test/helpers/fleet-env.ts` (seeds at the current revision, or `contractsAt`), `src/reconcile/reconciler.ts` (its unchecked stand-in carries the revision), `scripts/lab/*-live.ts` (`--seed-contracts` seeds, and the recorded-pass checks look, at the current revision).

### Out of scope

Verification-policy identity and native acceptance (package 4's other slices). A check that forces a revision decision whenever adapter files change (a fingerprint test would conflict across parallel PRs touching those files); the bump stays a reviewed edit. Herdr version or platform as part of the identity.

## Build

- **Version** 0.23.0. `PROTO` stays 6: no verb argument changed (the revision travels in the report), and `contracts.record`'s reply only gains fields (`revision`, `current`, `required_revision`); a CLI that does not read them treats the record as before.
- **Wording.** A stale pass reads "claude 2.1.300 passed only at contract revision 0 (before revisions), not revision 1" in the refusal, the P1 and doctor; the P1 line stays inside the 200-character digest, so the doctor command at its end is never cut.
- **Tests.** `test/unit/contract-record.test.ts` (revision and context on a record; a leader's report at another revision or none is refused; a stale record never overwrites a current one; doctor's check and `doctor --contracts`' warning; Herdr version parsing and launch profiles), `test/unit/auto-contract.test.ts` (a pass from another build at the current revision runs no check; a legacy pass is stale and re-recorded; an attempt failed at an older revision runs once more; a report at another revision is not recorded; strict: one P1 per version and revision, a plain-version flag and a revision-less P1 do not hide it, and only a pass at the current revision settles it, a legacy plain-version flag included), `test/unit/db.test.ts` (migration 20 on a database in use), `test/integration/harness-gate.test.ts` (startup and dispatch name the stale revision; a current pass lets dispatch through), `test/integration/auto-contract.test.ts` (a compiled daemon re-runs a legacy pass and records it at its revision with the context).
