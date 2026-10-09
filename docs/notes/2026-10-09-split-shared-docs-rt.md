# Per-feature docs files

- Status: done

Almost every pull request appended a section to `docs/m5-notes.md`, added or edited a row in `docs/v1-status.md` and often edited `README.md`'s one-line configuration paragraph. With several ships in flight, each merge made the others conflict there: about 8 extra merge-main rounds on 2026-10-08 and 09 (#37, #39, #41, #47). Now each feature writes its own file here (the layout is in [README.md](README.md)), so two such PRs touch disjoint docs files.

## Choices

- **Freeze, don't move.** The milestone notes, the cutover notes and v1-status keep their content and gain one "Frozen on 2026-10-09" line under the title. Moving their post-v1 sections into this directory would have rewritten about 40 references in code comments and docs, and conflicted with every in-flight PR appending to `m5-notes.md`. Edits in place to different sections of a frozen file still merge cleanly: only appends at the same spot collided.
- **No committed index.** Any committed file that lists every feature is edited by every PR, which brings the conflicts back; a staleness test would only turn the conflict into a red test. `bun run notes` (`scripts/docs/notes.ts`) prints the index from the files, with each PR number read from git.
- **Status in the notes file**, as a `Status` line under the title, rather than one more file per item.
- **A plain bullet block, not YAML front matter**, so GitHub renders it as text and the parser is a few regular expressions.
- **No `merge=union` for the shared files.** GitHub's mergeability check does not reliably honour `.gitattributes` merge drivers (not verified here, so not relied on), and a union merge can interleave lines silently.
- **README**: changed only for the setup and usage a new user follows. A feature's configuration keys, verbs and behaviour go in its notes file, with the keys on its `Config` line.
- **Where the rule lives**: AGENTS.md (read by workers and by the leader that writes the ship briefs); one project-agnostic line in the build skill (`src/skills/stages.ts`: write docs where the project's AGENTS.md or CLAUDE.md says, as a new file when it says so); and one in the leader skill's dispatch bullet (`src/bridges/skill.ts`: point a worker at the project's docs rule, never at a shared notes file). The worker contract is unchanged: it is project-agnostic and says nothing about docs.

## Tests

`test/unit/docs-notes.test.ts`:

- every file in `docs/notes/` has a dated kebab-case name, a title and a valid `Status` line;
- the `#` headings of each frozen file equal a fixed list, so a new section fails with a message naming `docs/notes/`; edits in place that keep the headings pass;
- two branches of a scratch git repository that each add a notes file merge without a conflict, while two that each append a section to the same file do conflict (the problem this layout removes);
- the parser's cases, and that `renderIndex` gives the same bytes for the same input;
- the build skill a worker is given and the leader's skill carry the docs rule.

A pull request in flight that adds a section to a frozen file goes red on the heading test after its next merge of main: move the section into its own file here.
