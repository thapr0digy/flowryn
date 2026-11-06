# Effort per stage, and a different model for review

- Status: done
- Open: not yet run live: a real Claude resumed mid-run under a new `--effort` and `--model` at a stage start, and a real no-mistakes reviewer on another model
- Config: `[workflows.<id>] stages[].effort`, `[workflows.<id>] stages[].review`, `[projects.<id>] review_model`

The 2026-11-06 audit found every worker running one effort for its whole run, and every PR reviewed by the model that built it. Now a workflow stage can set its own effort, a review stage runs on the project's review model, and `show` and `fleet` print both. Nothing here uses a model: it is lookups, a comparison and the existing relaunch.

## Configuration

```toml
[workflows.feature]
stages = [
  { id = "design", skill = "flowryn-design", gate = "review", effort = "high" },
  { id = "build", skill = "flowryn-build-test", effort = "medium" },
  { id = "review", review = true, fresh = true },        # a second model's read (optional stage)
  { id = "ship", pools = ["validation"], gate = "merge" },
]

[projects.flowryn]
review_model = "sonnet"          # what a review = true stage runs on; unset: the builder's model
```

- **`effort`** on a stage: `low`, `medium`, `high` or `xhigh`, the levels both Claude (`--effort`) and Pi (`--thinking`) take. A stage never runs at `max`: it refuses with `config_invalid` (a task that needs it says so with `dispatch --effort max`). Any other value refuses too.
- **`review = true`** marks a stage whose job is to review the work. On Claude its worker runs on the project's `review_model`.
- **`[projects.<id>] review_model`**: a Claude model name (the same check as every model name: letters, digits and `. _ : / @ [ ] -`). Unset, a review stage runs on the builder's model, as before.

### Recommended shape

| Work | Effort | Where to set it |
| --- | --- | --- |
| Design stages | `high` | the stage's `effort` |
| Build of a complete spec (`unattended`), `fix` | `low` or `medium` | the stage's `effort`, or `[workflows.<id>.claude] effort` |
| Scouts | `high` | `[workflows.scout.claude] effort = "high"` (the built-in scout keeps its stage) |
| Anything | never `max` | only `dispatch --effort max` for the one task that needs it |

A built-in workflow's stages only take `effort` when you write its `stages` out in config, as the user's config already does for `feature`, `feature-ui` and `unattended`.

## Precedence

Effort, first set wins: the task's own (`dispatch --effort`, a plan phase's `effort:` line), **the stage's `effort`**, the workflow's `[workflows.<id>.<harness>] effort`, the account's, `[workers.<harness>]`, the harness default. The rest is as in docs/notes/2026-10-24-model-and-effort-sc.md.

Model: at a review stage on Claude, **the project's `review_model`** wins over everything, the task's own model included, because the point is a second model's read. Everywhere else, and at every stage of a Pi run, the model is looked up exactly as before. A Pi worker is never given `review_model` (Pi stays on its free model); with nothing else set its launch has no `--model` at all.

Sources in `show` and the launch events: `stage <id>` and `review_model (stage <id>)`.

## When it applies

Both harnesses take model and effort only as launch flags; neither changes them inside a running session from outside. So a stage's choice applies at a launch:

- The run's first launch, a resume, a fresh stage worker (`fresh = true`) and a relaunch all look the current stage up.
- **A stage start on a live worker** whose choice differs from what the worker launched with (`runs.model`, `runs.effort`) turns into a relaunch: the scheduler stops the worker and resumes its own session under the new flags (`claude --resume <session> --effort low`), with the stage's instructions in the task file. The context survives; no new session starts. It is the relaunch a promoted scout already uses (`run.relaunch`), and the `stage.requested` event says `relaunch: true`. A stage start under `stage begin` or a delivery is refused with `stage_waiting` like a fresh stage worker, so the worker ends its turn before it is stopped. The stop is handled as for a fresh stage worker: an exit that fails or throws leaves the worker and its session as they were, backs off, records `run.fresh_worker_refused` and, after repeated tries, opens a `worker_not_exited` P1; a cancel that lands while the worker exits gets no relaunch.
- The comparison reads the frozen workflow alone (no config in that transaction): a stage's own value against the worker's, and a stage that sets nothing after one that did counts as a change, so the relaunch looks the defaults up again. That can relaunch once for nothing when the default happens to equal the earlier stage's value. A task with its own effort (`dispatch --effort`) is never relaunched for a stage's effort, since it wins anyway.

### Frozen with the run

A stage's `effort` and `review` are part of the workflow a run freezes at dispatch (`run.dispatched`'s `workflow_def`), and so is the project's `review_model`: it is written onto each review stage then (`freezeWorkflow`, `src/config/workflows.ts`), and by `promote` for a scout promoted in place. A config edit applies to the next dispatch, not to runs already going, as with the stages themselves. A workflow frozen before this change has no such keys and behaves as before.

## No-mistakes' review on another model

Flowryn does not run the no-mistakes reviewer; the shared no-mistakes daemon does, from its global config, which a repository's `.no-mistakes.yaml` cannot set. To have the ship stage's review run on another model than the builder, set its reviewer role in `~/.no-mistakes/config.yaml` (no-mistakes v1.106, https://kunchenguid.github.io/no-mistakes/reference/global-config/):

```yaml
review_agents:
  reviewer:            # the review step only; test, document and CI repair keep `agent`
    agent: claude      # an explicit harness is required here (not auto)
    model: sonnet      # optional; unset inherits agent_config.<agent>.model
    effort: high       # optional
```

`reviewer_after_round` overlays later rounds and `fallback` lists agents to try on quota exhaustion; `repository_overrides` in the same file can replace a role for one repository. Flowryn never writes that file: it is the user's machine-wide setting.

## Show and fleet

- `flowryn show <task>`: `model` and `effort` as the worker's last launch used them, with their source, and `stages`, one line per stage of the run's workflow with what a launch for it looks up now: `check: sonnet (review_model (stage check)) · low (stage check)`. A run whose account no longer resolves gets one `unknown: <why>` line.
- `flowryn fleet`: a `model` cell per run, `sonnet · low` (`default` where nothing is set).

## Tests

- `test/unit/stage-effort.test.ts`: the stage keys parse and refuse (`max`, unknown levels, a non-boolean `review`, a bad `review_model`); a stage without them reads as before; the stage's effort sits between the task's own and the workflow's; `review_model` beats the builder's and the task's model on Claude and leaves a Pi model unset; freezing; when a stage start relaunches.
- `test/integration/stage-effort.test.ts`, through the real CLI and daemon with the fake Herdr: the first stage launches at its effort, the review stage relaunches the same session with `--model sonnet --effort low`, the events, `show`'s `stages` and `fleet`'s `model` cell; a Pi worker at a review stage gets `--thinking` and no `--model`.

## Choices made in the build

- One `effort` key on a stage rather than per-harness tables: the four levels mean the same on both harnesses, and a stage rarely needs two.
- `review_model` is per project, as asked, and a stage opts in with `review = true`; Flowryn has no review step of its own, so nothing changes until a workflow adds one.
- The stage's choice is frozen rather than read from config at launch, because the stage-start comparison runs inside transactions that have no config; reading both from one place keeps the trigger and the launch in agreement.
- The adapters are unchanged (same `--model`, `--effort`, `--thinking` flags) and the relaunch path is the promote one, so no `CONTRACT_REVISIONS` bump.
