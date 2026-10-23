# Remove conflict hotspots

- Status: done
- Open: no release has been cut with `bun run release` yet; the migration name ledger has not yet run on the real flowryn.db (its first start backfills 1..29)

Scout findings 2 and 7 (`~/.flowryn/data/scout-efficiency-and-fz/report.md`): 21 conflict rounds across about 82 PRs, each one a new head, a new verify and a new approval. Since 2026-10-12 the live hotspots were `src/db/schema.ts` (8 of 24 commits) and `src/api/errors.ts` (5); `src/version.ts` and `package.json` (2 each) only because nothing stopped a bump; README (1) was already fixed by the notes-per-feature rule, so it is unchanged here.

The design review (2026-10-22) picked a release PR on main for the version and numbered migrations with a name ledger. Everything is plain code: a diff rule, a sort check, a table lookup and a git ancestry test.

## Version: a release is its own PR

Feature PRs never change `VERSION` (`src/version.ts`) or package.json's version. A release bumps both, on a branch from main, and lands as its own PR; nothing else touches those lines, so it never conflicts:

```sh
bun run release minor          # 0.24.0 → 0.25.0 in both files; prints the subjects merged since the last version change
bun run release check [<base>] # exit 1 naming each commit since <base> (default origin/HEAD, else origin/main) that mixes a version change with other files
```

- The caller names the field (`major|minor|patch`, by the SemVer table): merge subjects are not conventional commits, so code cannot pick it. The script never tags.
- `PROTO` is not a release field: the PR that changes the wire format still bumps it, and the check allows that.
- **Enforced in `bun test`** (`test/unit/release.test.ts`, "this checkout"), so the local `flowryn verify` catches it as well as CI (the leader's build note: GitHub Actions minutes were used up). The rule is per commit: a non-merge commit in `base..HEAD` that changes either version may touch only `src/version.ts` and `package.json`; uncommitted tracked changes are judged the same way. Merges are skipped, since they bring main's own commits, and a release commit on main passes by construction, so a stale `origin/main` never fails a feature branch. The case is skipped when the checkout has no `origin/HEAD` or `origin/main` (a shallow clone); CI's checkout now fetches the full history.
- **Downgrades.** Per-PR bumps were also how the build watcher told an older build apart. Two merged builds now usually share a version, so `src/daemon/build-watch.ts` also refuses (`downgrade`, a `build_refused` P1) a build whose commit is a strict ancestor of the running daemon's (`git merge-base --is-ancestor`); a commit git does not know is not an ancestor.

## Migrations: numbers plus a name ledger

Numbers stay: the schema number is what the build watcher's downgrade check, doctor and `flowryn version` compare. Name-ordered files were rejected: Bun 1.3.8 has no `import.meta.glob`, so a compiled binary would still need a hand-kept import list, the same append point.

- Migration 30 (`migration-names`; 28 and 29 went to p1-lane-means-8v and daemon-run-verify-y3, which landed first) adds `schema_migrations(version, name, applied_at)`. `migrate()` writes each migration's row in the transaction that applies it, and backfills the rows for migrations applied before the table existed from this binary's names (trust on first use; `applied_at` is null unless this call applied them).
- Before applying anything, `migrate()` refuses (`SchemaDivergedError`, naming each number, the recorded name and this binary's) a database whose recorded name for a number differs from this binary's: a database that ran another branch's migration N no longer silently skips main's. The daemon does not start; `flowryn doctor`'s schema check fails with the same list and points at `flowryn doctor --restore`.
- A unit test requires `MIGRATIONS` to run 1..N with unique names, so resolving a conflict by keeping both branches' migration N fails `bun test`. Two PRs that each add a migration still conflict as text; resolving it is now mechanical and safe: keep both, renumber yours.
- Limit: trust on first use. A database that had already diverged before this landed is not caught.

## errors.ts

`ERROR_CODES` is one alphabetical list (each code's own comment beside it; the group headers went, since the value names the exit code). `test/unit/basics.test.ts` fails when the keys are not sorted. The mapping is unchanged.

## Tests

- `test/unit/db.test.ts`: numbers 1..N and unique names; a fresh database records every name and time; a database at 29 gets 1..29 backfilled with no time and 30 with its time; a database that ran another branch's migration under the same number is refused, nothing applied; doctor's schema check fails on a mismatch.
- `test/unit/release.test.ts`: `bumpVersion`; `writeRelease` writes both files and refuses when they disagree; a release-only commit passes; a feature commit with a bump fails, naming it and the other files; a package.json-only bump with other files fails; a `PROTO` bump and a dependency change pass; a stale base with main's release merged in passes; an uncommitted bump beside other files is named; this checkout passes.
- `test/unit/build-watch.test.ts`: an older commit at the same version is refused as a downgrade; a newer one still applies.
- `test/unit/basics.test.ts`: error codes sorted.
