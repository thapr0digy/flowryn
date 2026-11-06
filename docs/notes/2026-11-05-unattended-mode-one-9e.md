# Unattended mode: one approval when you leave, a morning report when you return

- Status: done
- Open: not yet run live (tests use the real daemon, the fake GitHub over a bare origin and fake workers)

The user (2026-11-05) could not leave Flowryn to run overnight because every review, many merges and most questions waited for them. The design reviewed at gate g307 adds one standing approval, granted once when they leave, and a morning report. It is all plain code: one record, a daemon pass on the attention tick, rule checks, the existing merge and landing machinery and a fixed brief template. No model is called.

## Granting it

`flowryn away --autonomous [--until <time>] [--projects a,b] [--body-file -]` grants unattended mode and starts (or extends) away mode alongside it. There are exactly two ways to grant it:

- **Your terminal.** The CLI runs `autonomy.begin`, shows the terms (the projects, the end time, what parks) and reads a four-letter code back from `/dev/tty`, then runs `autonomy.confirm`. It works like `flowryn approve` (`src/cli/commands/away.ts`). Both verbs are for the human role only.
- **Your chat answer to the Claude leader.** Without a grant, the leader's `away --autonomous` is refused with `approval_required`, and the refusal names the item: `flowryn chat-question autonomy:<projects>@<YYYY-MM-DDTHH:MM>`. That prints one binding AskUserQuestion question. The question states the terms and what parks. Your "Start autonomy" answer becomes a grant (grant action `autonomy`), minted only by the leader's own hooks and checked against Claude's transcript as every grant is. The leader then runs `flowryn grant use <grant>`. The item carries the terms, so a grant for other projects or another end time is a different item and starts nothing.

Terms:

- `--until` is at most 16 h ahead (`AUTONOMY_MAX_MS`). By default it is `[away] default_hours`, capped at 16 h, and it is cut to the minute.
- `--projects` defaults to every project the caller sees that has `verify` steps. Each named project must be in the caller's scope and have `verify` steps, because an autonomous merge goes only through the verify-backed auto-merge or landing queue.
- A worker cannot call `away`. A reader, a Pi leader and a socket call from the human role without the challenge are refused. Plain `away` (no flag) is unchanged and grants nothing.

The grant is one row in `autonomy_grants` (migration 54 `autonomy`): `u<N>`, channel `cli-tty` or `claude-chat`, actor, chat grant id, projects, the user's words (sanitised, at most 500 characters), a terms hash, start, expiry, end and reason. At most one row is live (a partial unique index). A new grant supersedes the live one, so extending needs you again.

The grant ends on:

- `flowryn back`, which also prints the return brief (`back`);
- its expiry, ended by the attention tick (`expired`);
- a new grant (`superseded`).

Automatic away never starts or extends it, and your own message ends only an automatic away, not this grant. When the grant ends, every approval it minted that has not been used ends with it.

## While it is live (`src/attention/autonomy-pass.ts`)

The attention tick (1 s) runs one pass at a time, and only for the grant's projects. It first reads, outside the transaction, each candidate review gate's worktree HEAD and each project's default-branch `.no-mistakes.yaml`. One transaction then checks everything again:

1. **Questions** (`autonomyVerdict`, pure). The pass looks at each open run-scoped question of a covered run started after migration 54, oldest first.
   - It **parks** the question when:
     - its recorded class is protected: `destructive`, `irreversible`, `security`, `credential` or `outward` (`PARKING_CLASSES`: every keyword class but `merge`);
     - its wording names one of those classes, checked with all of them on, whatever `[decisions] reserved_classes` narrows;
     - the worker reserved it itself (`ask --reserved <reason>`);
     - the task is sensitive;
     - its recommendation would skip CI (a CI wait's `accept-without-ci`, or a no-mistakes `approve`/`skip` on a CI finding) and the default branch's `.no-mistakes.yaml` does not say `no_ci: true`.

     Parking marks the decision `autonomy_state = parked` and records an `autonomy.parked` event. A run question that did not already hold its task becomes blocking and holds it (`recordIntent`), so your answer unholds it. It opens one `autonomy_parked` item per run (P1, actionable), which names `flowryn decide <q> <choice> --by captain`; it is resolved once no question or review gate of the run is still parked and open (`settleAutonomyParked`, src/attention/items.ts). Only that task waits; the other tasks go on. As you chose in the review (q144), a parked run keeps the capacity slots it holds, as a run at a review gate does.
   - It **decides** any other question that has a recommendation among its options (a multi question's list, or a text question's text), with `answered_by = worker` and `answered_via = autonomous`. The rationale is "Decided under unattended mode (u<N>) as the worker recommended: <its why>". The why is `ask --why <text>` (new, optional, at most 300 characters, kept in `decisions.note`, the column a review gate's question already uses for its why). The event is `autonomy.decided`. A `merge`-class question is decided too: that class exists only to get your record, which the grant is.
   - It **leaves** a question with no usable recommendation to the leader, as today.

   A review gate's questions follow the same rule, and their answers still ride the verdict steer. Like a rule's answer, an autonomous answer can be undone while its run is live: `decide <q> <choice> --by captain` takes the existing undo path (`overrideRuleAnswer`), and the worker is told to revert what it did on its own recommendation.
2. **Review gates** (`autonomyGateVerdict`). An open review gate whose questions are all answered passes on channel `autonomous` (`recordGatePass`, so every check a pass makes still runs). The approval row names the grant, and the event is `autonomy.gate_passed` with the page, spec path, spec digest and head. A gate passes when:
   - its task's dispatch brief passes the ship brief check, or the task is a plan phase;
   - it has a review page;
   - a flowryn-design stage pinned a build spec;
   - the pinned page and spec (and a draft's page) are unchanged.

   Otherwise the gate is parked with the reason, and it waits for your `flowryn approve <task> --gate <stage>`. A run started before migration 54 is left as it was.
3. **Merges.** The daemon's own merge (`DAEMON_CALLER`) of work that yolo does not cover (not yolo, or sensitive) takes the grant as your record: the choice is `autonomy` (`src/policy/merge.ts`). It mints an approval with channel `autonomous`, bound to the ref and head, which the merge uses. Every other merge rule is unchanged: the exact head, every check green (a waiver is never taken from the grant), local green under the verify policy, and checks not pending.
   - A **landing-queue** project's line takes a ready PR on a minted approval. Its catch-up merge of main re-mints one at the new head, sensitive work included (`src/verify/landing-queue.ts`).
   - A **manual** project's ready ship gets the verify-backed auto-merge, once per head.

   A leader's `flowryn merge` never takes the grant, and neither does a run started before migration 54 (`autonomyForRun`): it still needs your own approval per PR. Each mint appends `autonomy.merge_approved`.

## The morning report (`src/attention/autonomy-report.ts`)

The return brief gains an `Autonomous (…)` section after "Settled by rule" whenever a grant was live in the window. It has four groups, each listing at most 20 lines:

- **Gates passed:** the review page and the spec path.
- **Decided:** the question, the choice, the worker's why, and the undo command (or the user's later change).
- **Merged:** the PR URL and the merge commit.
- **Parked:** why, and the command that moves it on.

`flowryn show autonomy` (the latest grant) and `flowryn show u<N>` print the terms and the same section. Everything goes through the caller's scope lens and is sanitised. Events carry ids, classes and choices, never the user's words.

## Leader skill

The away line says `--autonomous` names the chat question to ask once. The refusal's hint carries the exact item. The skill stays within its 6,000-character budget.

## Choices

- **The grant is its own table**, `autonomy_grants`, not the `approvals` table with a fake task. Each action it allows mints an ordinary per-head approval row (channel `autonomous`), so gate and merge records keep their shape and name the grant.
- **The item is the terms.** `autonomy:<projects>@<stamp>` makes the chat form deterministic from the ref alone, with nothing to store between the question and the answer.
- **A worker's question is parked by holding its task**, as a blocking ask does (the decision becomes blocking so its answer unholds it). A review gate is parked by leaving it open: no hold, because nothing would lift one after you pass the gate.
- **`ask --why` reuses `decisions.note`** instead of adding a `rationale_hint` column (the spec's name). It is the same field, and a review gate's question already fills it.
- **No new item wakes the leader.** A parked task waits for the morning brief, not a wake.
- **No contract revision bump.** `ask --why` is optional and no step the contract suite proves changed.

## Tests

- `test/unit/autonomy.test.ts`:
  - terms and refs;
  - `checkTerms` (16 h, verify steps, unknown project);
  - one live row, with words kept out of events;
  - project A never covering B;
  - expired and ended grants, and their minted approvals ending;
  - supersede;
  - the chat form;
  - every question rule alone (each protected class by class and by wording, a narrowed `reserved_classes`, merge class, worker `--reserved`, sensitive, no recommendation, multi and text, `no_ci` for a CI wait and a no-mistakes CI finding, skipped states);
  - every gate rule (pins, loose brief, no page, runs from before the migration);
  - the merge choice: the daemon only, never a leader, never a waiver, never a run from before the migration, red checks still refused, nothing after the end;
  - the parked item closing with the run's last parked question;
  - the report: lens, sanitising, empty window.
- `test/integration/autonomy.test.ts`, through the real daemon and CLI:
  - with the grant from your terminal, two spec'd ships (one sensitive) go dispatch → automatic design pass → build → ship → landing-queue merge with no input; a third that asks to drop a table parks alone; `flowryn back` prints the Autonomous section with the two gates, the two merges and the parked task;
  - a worker's `away --autonomous` and `back` are refused (exit 77);
  - the leader without a grant, a socket call without the code, the leader's call of the terminal verb, a wrong code and 17 h are all refused;
  - the fake Claude leader starts it through the real hooks with your chat answer, once.
