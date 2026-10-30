# Asks: a lightweight question-and-answer worker

- Status: done
- Open: the contract suite's new ask step has run offline against the fakes, not yet live on either harness (`flowryn doctor --contracts` after the build lands)
- Config: `[ask] max_usd`, `[ask] timeout_ms`, `[ask] max_concurrent`, `[ask] max_answer_bytes`

Recommendation 5 and section 4.2's research row of the 2026-10-30 research report (`~/.flowryn/data/research-improving-flowr-6e/report.md`). A question used to cost a scout: a Herdr pane, a worktree, a branch and a backlog task, and a report file the leader had to open. So questions went to the leader's own conversation instead. An ask is one read-only, capped, print-mode model call with none of those, and its answer lands in the leader's next digest.

## Using it

```sh
flowryn dispatch web --kind ask --body-file - <<'EOF'
How does the reconciler decide a run is dead?
EOF
# → ask a3, queued (or running)
flowryn show a3          # the question, spend, and the answer (first 60 lines; --full for all)
flowryn drop a3 --body-file - <<<'wrong question'   # cancel a queued or running ask
flowryn promote a3       # an answered or failed ask becomes a scout on the same question
```

Flags on `dispatch --kind ask`: `--harness`, `--account`, `--model`, `--effort` as for any dispatch; `--max-usd <dollars>` (above 0, at most 20) replaces `[ask] max_usd` for this ask; `--no-promote` stores a "needs a scout" reply as the answer instead of starting the scout. Task flags (`--task`, `--after`, `--blocked-by`, `--auto`, `--base`, `--workflow`, `--mode`, `--sensitive`) are refused: an ask is not a task. `--max-usd` and `--no-promote` on a ship or scout are refused.

## Behaviour

- **Record.** An ask is a row in `asks` (migration 47) with its own id `a<N>`, not a backlog task: no tasks-axi call, no `task_policy`, no run. Each change appends an event: `ask.queued`, `ask.started`, `ask.answered`, `ask.promoted`, `ask.failed`, `ask.cancelled`, `ask.requeued`. Items use the ask id as their task id, so the scope lens (`taskProject` and `refScope` in `src/leader/scope.ts`) places them in the ask's project.
- **States.** `queued → running → answered | promoted | failed`; `queued | running → cancelled` (drop); `running → queued` once after a daemon stop.
- **Queue.** The scheduler's pass drains it right after the verify queue (`drainAsks` in `src/ask/runner.ts`): oldest first, while fewer than `[ask] max_concurrent` (default 2) run. An ask holds no pool lease, so it never waits on a worker slot and never holds one up. An ask whose account is paused for its usage limit waits; the others go ahead. The harness gate applies as for a worker: a harness without a contract pass at this revision refuses the dispatch.
- **The call** (`src/ask/harness.ts`), through `runBounded` (own process group, `[ask] timeout_ms` deadline, owned ledger), in the project's primary checkout, the question on stdin, from the daemon's environment scrubbed of `FLOWRYN_*`, `CLAUDECODE`, `CLAUDE_CODE_*` and GitHub tokens, pointed at the account's login as a worker pane is:
  - Claude: `claude -p --output-format json --no-session-persistence --restricted --strict-mcp-config --disable-slash-commands --tools Read,Grep,Glob,WebFetch,WebSearch --allowedTools <same> --permission-mode dontAsk --max-budget-usd <cap> --append-system-prompt-file <contract>`. `--restricted` ignores the user's, project's and local settings files (so no hooks) and confines the file tools to the checkout; `--tools` leaves no tool that writes or runs anything. The cap is Claude's own.
  - Pi: `pi -p --mode json --no-session --tools read,grep,find,ls [-e <[workers.pi] extensions>] [--provider/--model/--thinking] --append-system-prompt <contract>`. Pi has no spend cap, so a meter (`PiMeter`) reads the JSON stream as it arrives and sums each assistant message's `usage.cost.total`; past the cap it aborts the call (SIGTERM to the group, grace, SIGKILL). Pi 0.87.1 has no web tools.
  - The contract (`askContract`, six lines): answer the question; you can only read; at most `[ask] max_answer_bytes`, opening with a one-sentence answer and citing paths and URLs; say what you could not check; if answering needs writing or running anything, reply only `NEEDS-SCOUT: <why>`.
- **Outcome**, read by plain code:
  - A reply becomes the answer (cut at `[ask] max_answer_bytes`, default 8 KB, on a character boundary; the whole text is then kept in `<state_dir>/asks/<id>/answer.md` and the stored answer says so). An `answer_ready` item (P1) opens with the line `Answer (<project>): <first sentence>; flowryn show a<N>`. The leader's `show` of the whole answer closes it, as for a report.
  - A reply whose first non-blank line starts with `NEEDS-SCOUT:` starts a scout on the same project, account and model choice (`src/ask/promote.ts`), its body the question plus "(Promoted from ask a<N>, which could not answer it read-only: <why>)". The ask ends `promoted` and names the scout's task. If the scout cannot start (Herdr down, the harness gate), the ask fails with an item that says `flowryn promote a<N> once that is fixed`.
  - Over the cap, past the deadline, a harness that did not start, or an error result: `failed`, with an `ask_failed` item (P1) naming the reason, the spend and what to do.
- **Cost.** Each ask records `cost_usd` (Claude's `total_cost_usd`, Pi's summed cost). The return brief's spend line adds `N asks ($X.XX)`. Claude's cap counts API-equivalent dollars, so on a subscription login it is a guard, not a bill.
- **Restart.** A daemon stop aborts the running calls and leaves their rows `running`; a force-kill leaves the process group, which the next start's owned-ledger recovery ends. Either way the next start queues a running row again if it has had fewer than 2 attempts, else fails it. An ask changes nothing, so a second call is safe.
- **Fleet and show.** `fleet` lists queued and running asks under `asks`, one line each. `show a<N>` (or `show` of its item) prints the question, state, spend, run time, the reason and scout when there is one, and the answer.
- **Leader.** The leader skill gains one line: a reading question goes to `dispatch --kind ask` rather than into the conversation. Whether a question is an ask is still the leader's judgement; no rule routes it.

## Choices, and why

- **Deterministic first.** Only the answer, and the judgement that a question cannot be answered read-only, are model work. The queue, cap, meter, marker parsing, item lines, promotion and recovery are plain code.
- **No backlog task.** A backlog task per question is part of what makes a scout heavy; the ask's row and events are its record. The reconciler's invariant pass checks runs, and an ask is not a run.
- **`dispatch --kind ask`, not a new verb**: `ask` is already the worker's question verb.
- **Reading tools only, no shell** (the user's answer to the design question, 2026-10-30): a shell would need a scout's sandbox settings, most of a scout's weight. A question that needs one is promoted.
- **A fixed marker for promotion** rather than watching for a denied write tool: with `--tools` the write tools do not exist, so there is nothing to deny; the model says it cannot answer, and plain code reads the line.
- **Automatic promotion** (the task says it is promoted); `--no-promote` opts out per ask, and `flowryn promote a<N>` promotes an ended one by hand.
- **The harness gate applies.** The contract suite proves the ask's call (below), so an untested harness version refuses asks as it refuses workers.
- **Defaults** ($1 cap, 10 minutes, 8 KB, two at a time) are guesses sized for "a few KB" answers; all are config. A cap above $20 is refused, so a typo cannot authorise a large spend.
- **The headless runner** is written to be reused by the design's post-v1 triage runner: `runBounded` with a stdout callback and an abort signal, the argv builders, and the two output readers.

## Verified live (2026-10-30, while building)

- Claude 2.1.314 with the flags above, asked to read a file and then write one: answered from the file, and replied that it had no tool to write with (`subtype: success`, `permission_denials: []`). With `--max-budget-usd 0.0005`: exit 1, `subtype: error_max_budget_usd`, `total_cost_usd` 0.00066, `errors: ["Reached maximum budget ($0.0005)"]`, `terminal_reason: budget_exhausted`. Two calls on haiku, $0.002 in all.
- Pi 0.87.1 `-p --mode json --no-session --tools read,grep,find,ls` with the offline scripted provider: the question is read from stdin; the stream is `session`, `agent_start`, `turn_start`, `message_start`/`message_end` per message (`message_update` between, each carrying the partial usage), `turn_end`, `agent_end`, `agent_settled`; each assistant `message_end` carries `usage.cost.total`. In a checkout with `.pi/settings.json`, print mode did not stop at a trust prompt.

## Tests

- `test/unit/ask.test.ts`: config; both argv lists and the login environment; the output readers, from the captured Claude results and Pi stream (the assumption tests); the meter across split chunks; marker parsing, the first sentence, cutting on a character boundary; the store's transitions, items and events; the scope lookup; the brief's spend line; the runner through its call seam (concurrency, a usage pause, drop, Pi over its cap, deadline, spawn failure, a scout that cannot start, startup recovery).
- `test/unit/bounded.test.ts`: the stdout callback sees every chunk past the kept cap; an abort ends the whole group and reports `aborted`.
- `test/integration/asks.test.ts`, through the CLI and a real daemon, the call played by `test/helpers/fake-ask.ts` (the fleet's stand-in `claude` and `pi` exec it for `-p`): a Claude answer and its item, closed by the leader's read; the call's environment; a Pi answer and its summed cost; both caps; promotion and `--no-promote`; promotion by hand; drop; `[ask] max_concurrent`; refusals; a force-killed daemon; a cut answer.
- The contract suite gains a last step, `ask`: dispatch an ask whose answer must be one word, and check it was answered. `CONTRACT_REVISIONS` goes to claude 5, pi 4, so earlier passes are stale. `test/integration/contracts-offline.test.ts` runs it against the fakes on both harnesses.
