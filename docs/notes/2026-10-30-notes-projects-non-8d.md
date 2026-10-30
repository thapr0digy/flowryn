# Notes projects: drafts reviewed in Lavish, landed locally

- Status: done
- Open: not yet run live on a real notes repository
- Config: `[workflows.draft]`

The research report's section 4.2 "Non-code" row and its open question 5, which the user accepted on 2026-10-30. A project of kind `notes` is any git repository, with or without a remote, holding prose: a plan, a comparison, a note. Its tasks run the `draft` workflow. The worker writes one file, Flowryn renders that file as the Lavish review page, and once you approve it, that exact file is committed and merged into the local default branch. Nothing is pushed and no pull request is opened. No model is involved beyond the worker writing the prose: the kind, the routing, the rendering and the "is this the approved file" check are plain code.

## Using it

```sh
flowryn project add ~/notes --kind notes        # no remote needed; mode local-only, workflow draft
flowryn project set site --kind notes           # an existing local-only project; moves it to the draft workflow
flowryn dispatch notes --kind ship --body-file - <<<'A one-page plan for the Q4 offsite'
```

- `project add --kind notes` sets `--mode local-only` and `--workflow draft` unless you name them. A notes project refuses any mode but `local-only`, at `add` and at `set`, with or without a remote: a repository you want pull requests for is a code project.
- `project set --kind notes` on a code project also sets the workflow to `draft` unless `--workflow` names another, and needs the mode to be `local-only` already (or `--mode local-only` with it).
- `project list` and the project view show the kind (`code` or `notes`).
- `--workflow` still overrides: a notes project can run `fix` if you want the file without a review page.

## The draft workflow

`draft (review) → final (merge)`, built in, replaceable with `[workflows.draft]` like any built-in. Neither stage holds a validation slot: a draft has nothing to test.

1. **draft** (skill `flowryn-draft`). The worker writes one Markdown (`.md`, `.markdown`) or plain text (`.txt`) file in its worktree, at most 1 MB, and runs `$FLOWRYN_BIN draft render <file>` (the path from the worktree's top level). Flowryn writes `$FLOWRYN_REPORT_DIR/draft/draft.html`: fixed markup (title, "What I need from you", the question widget's mount) around the rendered file. Markdown goes through Bun's built-in renderer with raw HTML blocks and spans turned off, so any HTML in the file shows as text; plain text goes in an escaped `<pre>`. The worker hosts it with `lavish-axi --no-open` and runs `stage done --review <url> --page <that page>` (with `--questions-file` when it has questions; the design skill's shape).
2. **stage done** for a `flowryn-draft` stage needs `--page`, must name that page, and renders the file again from the worktree: the page must equal the render byte for byte, so a page edited by hand or a file changed after rendering is refused (`draft_page_invalid`). The review gate records the file's path and git blob (`gates.draft_path`, `gates.draft_blob`).
3. Changes send it back as for any review gate. Approval passes the gate with its blob.
4. **final**. The worker commits the file and runs `deliver --local`. A run that passed a draft review delivers only when `HEAD:<path>` is the approved blob; otherwise `draft_changed` says whether the file is missing or different. A change after approval needs a new review.
5. Landing is the existing local-only merge gate: your approval (unless the project is yolo), then `flowryn merge` merges the branch into the local default branch. The user chose this over "the draft approval lands it" at the design review (q127): it reuses the merge rules unchanged.

## Verbs and errors

- `draft render <file>` (worker): render the draft page. Refuses (`draft_invalid`) a missing file, a symlink, a path outside the worktree or inside `.git`, another extension, or a file over 1 MB.
- `project add|set --kind code|notes`.
- New error codes: `draft_changed` (policy), `draft_invalid` and `draft_page_invalid` (validation).
- Event `draft.rendered`; `stage.done` carries `draft` and `blob` for a draft gate.

## Data

Migration 45 (`notes-projects`): `projects.kind` (`code` by default, or `notes`), `gates.draft_path`, `gates.draft_blob`. `home adopt` carries the kind over (a home from before migration 45 reads as `code`).

## A repository with no remote

A remote-less local-only project already registered, launched, delivered and landed before this change; the dispatch base, the delivery check, the landing and the cleanup guard all fall back to the local default branch when there is no origin, and the remote-only paths (CI waits, policy follow, the build watcher, the no-mistakes doctor) are gated to PR modes. `test/integration/notes-projects.test.ts` runs a notes task end to end on a repository with no remote: render, a refused stale page, review, a refused different file, delivery, merge, cleanup.

The cleanup guard's rules are unchanged. With no remote nothing is ever on a remote-tracking branch, so a local-only run is allowed only when its HEAD is an ancestor of local main. Three new cleanup-guard fixtures build a repository with no remote (`fx_drop_origin` in `fixtures/cleanup-guard/lib/build-common.sh`; the runner now accepts a scenario without origin): `no_remote_merged_to_local_default` (allow), `no_remote_truly_unpushed` (refuse) and `no_remote_equal_content_not_merged` (refuse: local-only proves landing by ancestry, never by content). Their `ported_from` is `flowryn:notes-projects-non-8d`, since the reference had no such case.

## Choices

- A stored kind rather than a preset, so routing and the local-only rule key on it.
- Flowryn renders the page, not the worker: what you read is the file that lands.
- One file per task, Markdown or text; several files or other formats are a later change.
- The question widget is always mounted on the draft page; with no questions its script is simply absent.
- The approved blob is checked at delivery, not at merge: the merge gate already binds the approval to the delivered head.
- No contract revision bump: the offline contract suite runs the fix and feature workflows, not the draft one, and the shared stage text did not change.
