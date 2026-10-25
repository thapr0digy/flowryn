# A worker's model and effort, per task and per workflow

- Status: done
- Open: not yet run live: a real Claude resumed with a different `--model` and `--effort`, a real Pi given `--thinking max`, and how either reports an unknown model name on its first turn
- Config: `[workflows.<id>.claude] model`, `[workflows.<id>.claude] effort`, `[workflows.<id>.pi] model`, `[workflows.<id>.pi] effort`

Scout finding 12 (`scout-efficiency-and-fz`): every worker on an account ran one fixed model at one fixed effort. Now a task, and a workflow, can choose. The design was reviewed at gate g208. Nothing here uses a model: it is plain lookups and checks.

## Precedence

Each of model and effort is looked up on its own; the first level that is set wins:

1. **The task's own choice**: `flowryn dispatch --model <m> --effort <e>`, or a plan phase's `model:` and `effort:` lines (and `flowryn plan --model/--effort` for every phase without its own line).
2. **The workflow's default for the run's harness**: `[workflows.<id>.<harness>]`.
3. **The account's**: `[accounts.<id>] model` and `effort`.
4. **The harness's**: `[workers.<harness>] model` and `effort` (a declared account already falls back to these).

Nothing set: the harness's own default, and the launch has no `--model` or `--effort` flag at all, exactly as before.

```toml
[workflows.fix.claude]       # fixes run on sonnet at medium effort, whatever the account says
model = "sonnet"
effort = "medium"

[workflows.feature.pi]       # a table without stages on a built-in workflow keeps its stages
effort = "high"
```

A `[workflows.<id>]` table without `stages` on a built-in id (`feature`, `feature-ui`, `fix`, `scout`) keeps the built-in stages and only adds the defaults. A workflow of your own still needs `stages`. `flowryn config` shows the defaults under each workflow, with the source `built-in, with config defaults`.

## When it is looked up

At every launch: a run's first launch, a resume, a fresh stage worker and a relaunch. The task's own choice is stored on the run (`runs.model_pin`, `runs.effort_pin`, migration 34), so a resume keeps it; the other levels are read from config as it is then, so a workflow or account edit applies to the next launch, as an account's model always did. `runs.model` and `runs.effort` hold what the last launch used (dispatch fills them with its own lookup), and `run.dispatched`, `run.launched` and `sched.overflow` carry `model`, `effort`, `model_source` and `effort_source`.

`flowryn show <task>` and the dispatch reply show both with their source: `model: sonnet (workflow fix)`, `effort: high (dispatch)`, `default (harness default)`. Sources are `dispatch`, `workflow <id>`, `account <id>`, `[workers.<harness>]` and `harness default`.

## Checks

- **Model name**: letters, digits and `. _ : / @ [ ] -`, starting with a letter or digit, at most 128 characters (`claude-opus-5-5[1m]`, `openai-codex/gpt-5-codex` and Pi's `sonnet:high` pass). It is typed into the worker's pane, so nothing a shell would split or expand gets in; Herdr quotes each argument as well (docs/m2-notes.md). Whether the name exists is the harness's to say: an unknown one fails the worker's first turn.
- **Effort**: Claude `low medium high xhigh max` (`claude --help`, 2.1.x); Pi `off minimal low medium high xhigh max` (`pi --help`, 0.87.1). A dispatch or plan value outside the list refuses with `bad_args` (exit 3) before any run or phase exists; a workflow value with `config_invalid`. Account and `[workers]` effort stay unchecked, so no config that loaded before starts failing.
- **Pi provider**: a declared Pi account spends one provider, so a task's own model on it must be `<provider>/<id>`, as the account's model already must; otherwise dispatch refuses. A workflow's Pi model for another provider is skipped instead (its effort still applies), and the source says so: `account chatgpt (workflow fix's anthropic/claude-sonnet is not a openai-codex model)`. A refusal would make that workflow unusable on that account. The implicit `pi` account has no fixed provider, so any model applies. A pinned model the account no longer serves at launch (its provider changed in config) fails the launch rather than guessing.

## Overflow, plans and promote

- **Overflow** (`[accounts.<id>] overflow`): a run that moves to a backup account looks its model and effort up again on that account; its own choice goes with it. A Pi target that cannot serve the run's own model is passed over like a held one.
- **Plan phases**: `model:` and `effort:` lines sit beside `account:`, and are checked against the phase's account when the plan is filed (by `flowryn plan`, and for a worker's plan at its design's stage done) and again when the phase starts (a failure is the phase's `phase_blocked` P1). `dispatch --task <phase>` with `--model`/`--effort` overrides the phase's lines, each on its own. `dispatch --blocked-by … --model` stores the choice on the queued phase (`plan_phases.model`, `plan_phases.effort`).
- **Promote**: `flowryn promote --model/--effort`. A live scout's run keeps its own choice unless these replace it; its worker relaunches as a ship, so they and the ship workflow's defaults apply then. A new run for an ended scout takes only what the flags say, not the scout's choice (that was picked for reading, not shipping).

## Choices made in the build

- One pure module, `src/config/model-choice.ts`, owns the lookup and the checks; the launcher (`src/lifecycle/launcher.ts`), dispatch, plans, promote and the scheduler's overflow call it. `workersFor` takes the resolved values, so the adapters are unchanged: same `--model`/`--effort`/`--thinking` flags, so no `CONTRACT_REVISIONS` bump.
- The source of a value is not stored on the run; `flowryn show` reads it from the newest `run.dispatched`, `run.launched` or `sched.overflow` event, which is where each lookup is recorded.
- No per-stage defaults: a stage usually resumes the same session, so the gain is small.

## Tests

- `test/unit/model-choice.test.ts`: each level alone, all levels together, model and effort independent, an account's inherited value named as the harness's, the other harness's defaults ignored, the Pi provider skip and refusal, the effort lists, model names a shell cannot split, workflow tables without stages, bad workflow values, plan phase lines, existing account effort left unchecked.
- `test/unit/account-capacity.test.ts`: overflow keeps the task's own model and looks the effort up on the target; a Pi target of another provider is passed over.
- `test/unit/db.test.ts`: migration 34 on a database at 33.
- `test/integration/model-choice.test.ts`, through the real CLI and daemon with the fake Herdr: dispatch's model and the workflow's effort in the typed launch, the dispatch reply, the launch event and `show`; a resume keeps the task's model and follows a workflow edit read on SIGHUP; bad values refuse before a run or phase exists; a home with none of this launches with no model or effort flag; plan phase lines reach the worker and `--blocked-by --model` is stored on the phase; a live promote with `--model` relaunches on it with the new workflow's effort.
