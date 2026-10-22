# Verify reliability: step deadlines, one retry, diagnostics, parallel steps

- Status: done
- Open: not run live: no real hang has happened since this landed, so the retry and the `ps` capture are proven only by tests
- Config: `[projects.<id>] verify` (nested lists), `[projects.<id>] verify_step_timeout_min`

Scout finding 5 (report `scout-efficiency-and-fz`). In verifications v1 and v2, `bun run typecheck` (usually 0.9–1.3 s) hung for 31 min, until the whole-run deadline killed it with exit 143. Nothing recorded why, and nothing retried it. This change works on the steps inside one verification. Queueing verifies and running several at once belong to the separate `daemon-run-verify-y3` ship. Everything here is plain code (a timer, a SQL read of past runs, a config parser), with no model.

## Each step's own deadline

`src/verify/deadline.ts`. A step's deadline is, in order of precedence:

1. `[projects.<id>] verify_step_timeout_min` (a positive integer of minutes) when it is set. It then applies to every step.
2. Otherwise, the step's history in the project: **3 × the slowest of its last 5 clean passes, and at least 2 min**. A clean pass is a passed step that ran once and never hung. Steps are matched by their normalized command, so whitespace noise does not split a step's history. Failed steps, running rows and other projects do not count.
3. With no clean pass yet, the step has no deadline of its own, and only the run's (`verify_timeout_min`) applies, as before.

The user chose "on by default" in the design review (q75). The run's remaining time always caps a step's deadline. The deadline is recorded on the step (`deadline_ms`), and `flowryn verify show` lists it.

From flowryn's own history (v3–v10): install and typecheck get 2 min, the doctor contracts step about 6 min, and `bun test` (17–18 min) gets about 55 min, so in practice the 45-min run bounds `bun test`. Leave `verify_step_timeout_min` unset for flowryn, because one number cannot fit both a 1 s step and a 17 min one.

## At a deadline: list, kill, retry once

- **At either deadline** (the step's own or the run's), before the kill, the runner lists the step's process group into its log. It runs `/bin/ps -A -o pid,ppid,pgid,stat,etime,time,rss,command` through `runBounded` (5 s), keeps the rows of the step's group, and writes them after a `--- flowryn verify: killed at … ---` line. Logs are opened with `O_APPEND`, so the step's own late output cannot overwrite that block. If `ps` fails, the log says so and the kill still goes ahead. The kill is SIGTERM to the group, then SIGKILL after 5 s, as before.
- **The step's own deadline** is a hang: the step runs once more with a fresh deadline, logging to `<n>-<slug>.retry.log`. A second hang, or a non-zero exit on the retry, fails the run. When the run has no time left, there is no retry.
- **A non-zero exit is never retried**, because a retry would hide a flaky test.
- **The run's deadline is never retried**.
- `detail` names the hang:
  - `hung once: killed at its 2 min deadline (it usually takes 1.3 s), process group in 2-bun-run-typecheck.log; passed on its retry`
  - `… ; its retry exited 1`
  - `hung twice: killed at … both times; process groups in … and ….retry.log`

  A run that passes after a retry keeps the step's detail on its own `detail`, so the hang stays visible.
- The step records `attempts` and `hangs`. `pr.verify_step` events carry `attempt` and `hangs`, and a retry records a second `running` event.

## Parallel steps

An entry of `verify` that is itself a list is a group, and its steps run at the same time. Groups run in order. Each step keeps its own process group, log (still numbered in order), deadline and retry. When a step in a group fails, its running siblings are killed and recorded as `stopped` (`stopped: <step> failed`), and the next group never starts. A group of one is read as a plain step.

```toml
[projects.flowryn]
verify = [
  "bun install --frozen-lockfile",
  ["bun run typecheck", "npx oxlint", "bun run build"],
  "bun test",
  "./dist/flowryn doctor --contracts --verify-only --harness claude",
]
```

Nothing infers dependencies, so group only steps that are independent. Here `doctor` runs `./dist/flowryn`, so it must come after `bun run build`, and the steps of a group share one worktree, so they must not write the same files. The grouping above saves about 2 s. Running `bun test` beside `doctor` would save about 2 min, but it is untested for interference (both start daemons on Unix sockets, and CPU contention may slow timing-sensitive tests), so it is not recommended yet.

**Sharp edge (Bun's TOML):** a one-line list that ends in `]]` fails to parse (`verify = ["a", ["b", "c"]]`), and the config is refused as invalid TOML. Write the list over several lines as above, or put a space between the brackets (`["b", "c"] ]`). A test pins this behaviour, so a Bun upgrade that fixes it will show up there.

**Policy identity.** A flat list hashes exactly as before, so passes recorded under today's flowryn and fathom configs still count (a test pins flowryn's live `vp1:bae79e93…`). A grouped list hashes its structure, so moving a step into or out of a group is a different policy. A group of one is the plain step. The time limits are not part of the identity.

## Restart recovery with several live steps

Migration 29 adds `job_procs`, with one row per step process a job started (its process group leader), because a parallel group runs several at once and `job_leases` holds one. `recordJobProcess` inserts there. Startup recovery ends every recorded process by identity (a process that is gone or whose pid was reused is left alone), and it still reads `job_leases.proc_*` on leases from before the migration. When several steps will not exit, the detail lists their pids (`its steps (pid a, b) did not exit`).

## The CLI

`flowryn verify` announces each running step, several at once inside a group. When a step is retried, it prints `… <step> (hung; retrying)`. A step that ended prints `✓`, `✗` or `·` (stopped), with its detail whenever it has one, including a pass after a hang. `verify show` adds `group`, `deadline_ms` and `attempts` to each step.

## Tests

`test/unit/verify-steps.test.ts`: the config groups and key, the Bun TOML edge, the policy identity (flat list unchanged against the live vector, grouped list different), history deadlines (none without a clean pass, 3× the slowest of the last 5, the 2 min floor, exclusions, the config override, the deadline recorded by the job), a hang that passes on its retry with the `ps` rows in its log, a double hang, the run deadline without a retry, a failing `ps`, two steps that really overlap, a failure that stops a sibling, ordering of old rows, recovery of two live groups, and the `ps` row filter. `test/unit/verify.test.ts` was updated for `job_procs` and migration 29.
