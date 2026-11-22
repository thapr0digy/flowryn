# Remove a project

- Status: done
- Open: the leader runs `flowryn project rm security-triage` once this lands

`flowryn project rm <id> [--reason <text>]` unregisters a project that has no open work. Leader and human may run it; a scoped leader only for a project in its scope (`scope: project`).

## What blocks it

It refuses with `project_busy`, naming each kind of work and up to five ids, while the project has any of:

- a live run (`runs.ended_at` unset);
- a queued or held backlog task whose `repo` is the project, or a backlog add for it still pending in the journal;
- an open plan phase: a phase of a pending or approved plan that has not landed, is not done in the backlog and was not dropped;
- an open decision: a run's by its task's project, a standalone one by its backlog task's repo;
- a live landing batch, a waiting or landing landing-queue entry, an open delivery watch (`watches`), a queued or running verify, or a queued or running ask.

Finish, cancel or drop that work first. A project already removed is `not_found` ("was removed").

## What it does

It sets `projects.removed_at` and `removed_reason` (migration 67) and appends a `project.removed` event with the id, path, reason and caller role. The row stays: runs, plans, decisions and events still name the project, and `getProject` still resolves it for history. The id stays taken (`project add` with it is refused); the path may be registered again under a new id.

It never touches the checkout on disk, its worktrees or its branches; delete those yourself.

## Who skips a removed project

- `listProjects` (and so upkeep's primary-checkout sync, policy follow-through, verify's project choice, `away --autonomous` defaults and account views) and `deliveryModes` leave it out. `project list --all` shows it, with a `removed` column.
- Upkeep's build-after-merge project lookup, `doctor`'s checkout check and the no-mistakes auto-fix check leave it out.
- The scheduler's phase autostart skips it (rm refuses while a phase is open, so this only closes a race).
- New work refuses it through `requireActiveProject`: `dispatch`, `plan`, `decision add --project`, `project set`, and autonomy terms.
- The reconciler, fleet and brief work from runs and tasks, so a project with no open work shows up in none of them.

## Tests

`test/unit/project-rm.test.ts`: each refusal, the removal and its event, list and `--all`, `project set` refused, upkeep's sync and the scheduler's phase autostart skipping it. `test/integration/project-rm.test.ts`: through the real daemon, a project with an open decision is refused; one without is removed, its checkout stays, and upkeep's log names it no more while it still syncs the others.
