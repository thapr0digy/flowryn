# Feature notes

One file per feature or ship, so two pull requests that add different features touch different docs files and never conflict over them. The milestone notes (`../m1-notes.md` to `../m5-notes.md`), `../cutover-notes.md` and `../v1-status.md` are frozen records of the work before 2026-10-09: fix them in place, never add a section to them.

## A new file

Name it `<yyyy-mm-dd>-<slug>.md`: the date you create it, and the Flowryn task id as the slug when there is one (task ids are unique, so two ships never pick the same name), otherwise a short lowercase kebab-case slug. Start it with the title and a bullet block:

```markdown
# Away mode

- Status: done
- Open: kickstart -k by the job itself not yet run live
- Config: `[away] max_wakes_per_hour`, `[away] default_hours`

What the design left room for and what this change chose, the live results, the tests, …
```

- `Status` (required): `done`, `partial` or `not built`. `partial` and `not built` need an `Open` line saying what is left.
- `Open` (optional): what is not done or not yet run live.
- `Config` (optional): the configuration keys the feature adds, each in backticks. Explain them in the body; README.md does not list configuration keys.

Later phases and later fixes of the same feature edit its file. They run one after another, so they do not collide.

## The index

Nothing commits an index: one would be a file every PR edits. The date-prefixed names already list in order, and

```sh
bun run notes          # date, feature, status, PR and config of every file, newest first
bun run notes --check  # only validate the files
```

prints it from the files themselves. The PR number comes from the squash-merge subject of the commit that added the file, so it is blank until the PR merges. `bun test` (`test/unit/docs-notes.test.ts`) fails on a malformed file here, or on a new heading in a frozen file.
