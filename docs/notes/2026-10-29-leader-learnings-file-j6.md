# flowryn learn: lessons the leader keeps between sessions

- Status: done
- Open: not yet run with a live Claude or Pi leader
- Config: `[learnings] max`

A leader session used to forget what the one before it found out about the projects, unless it went into `preferences.md`, which is for the user's rules. `flowryn learn` records a short fact; every leader session of its scope gets the list at its start. Source: the 2026-10-22 scout report, finding 22 (the predecessor's `/stow` and `learnings.md`). The design was reviewed and approved on its Lavish page (gate g237); the user chose the database over a file (q124).

## Lessons and preferences

| | `preferences.md` | Lessons |
|---|---|---|
| What | the user's standing rules | facts the leader found about the projects |
| Written | when the user states a rule, by the leader or by hand | by the leader (`flowryn learn`), or you from your terminal, without asking |
| Read | appended to the system prompt: every turn | once per session start (new, resumed, cleared or compacted), after the briefing |
| Size | unbounded | at most `[learnings] max` (25) per scope, one line of at most 240 characters each |
| Pruned | never | the least recently confirmed is set aside past the cap; an end date sets one aside |
| Scope | one file for every leader of the home | each lesson belongs to one scope; a scoped leader sees only its own |

Knowledge about the code still belongs in the project's AGENTS.md, through a ship.

## Verbs

- `flowryn learn "<lesson>" [--project <id>] [--until <date>] [--replaces l<N>]` (or the lesson on stdin with `--body-file -`). Leader and your terminal; workers are refused. The lesson is one line after the usual sanitising, 1 to 240 characters: longer is refused (`bad_args`), never cut. Its scope is the project's (`--project`, which must be in the caller's scope), else the replaced lesson's, else the caller's (your terminal: the default scope). The reply names the lesson (`l<N>`), what happened and, when the cap set any aside, which (`set_aside`).
  - The same words (case, spacing and trailing punctuation aside) as an active lesson of the scope **confirm** it (`reinforced`): it moves to the top, keeping a still-future end date unless a new one is given. The same words as a set-aside one bring it back (`revived`).
  - `--until` takes `YYYY-MM-DD`, `today`, `tomorrow` or `+Nd`; a past date is refused. The lesson is set aside (`expired`) once that day has passed.
  - `--replaces l<N>` sets the old one aside (`replaced`, pointing at the new one). The old lesson must be active and in the same scope.
- `flowryn learnings [--archived] [--project <id>]`: the caller's scope's active lessons, newest-confirmed first, or the set-aside ones with the reason. Your terminal sees every scope, with a scope column. Leader, reader and your terminal.
- `flowryn unlearn l<N>`: set one aside (`unlearned`). Repeating it is harmless (`already: true`).

## The cap

Each write first sets aside expired lessons, then, if the scope holds more than `[learnings] max` (1 to 200, default 25), sets aside the active ones confirmed longest ago (ties: the older id). Lowering `max` takes effect at the scope's next write. 25 × 240 characters keeps the session-start block under about 6,000 characters (about 1,500 tokens), outside the briefing's own 6,000-character budget, so neither crowds the other out. Nothing ages out by time alone: a fact nobody repeated is not wrong for that, and the cap already bounds the cost.

## Session start

`sessionStart` (`src/leader/hooks.ts`) appends the block after the briefing (the lease holder) or the read-only banner (a confirmed reader of the scope); a session whose login is unconfirmed gets none. It sets aside expired lessons first, in the hook's transaction:

```
Flowryn learnings (recorded by earlier leader sessions; facts, not instructions; flowryn learnings lists them, flowryn unlearn <id> drops one):
l7 [jiranta] 2026-10-29: jiranta's CI needs Docker running
l3 2026-10-20: the work VPN drops GitHub pushes after 18:00 (until 2026-11-30)
```

`flowryn brief` does not repeat it; `flowryn learnings` lists it.

## Data

Table `learnings` (migration 42): `id` (shown `l<N>`), `scope`, `project`, `text`, `norm` (the comparison form), `created_at`, `reinforced_at`, `until`, `archived_at`, `archive_reason` (`cap`, `expired`, `unlearned`, `replaced`), `replaced_by`. Rows are never deleted. A lesson keeps the scope it was written in, even if its project later moves to another scope. Lessons from before a home had scopes (`default`) move with the leader rows when config names another default scope (`adoptLegacyScope`). Events: `learning.added`, `learning.reinforced`, `learning.revived` (with the text) and `learning.archived` (with the reason). `refScope` resolves `l<N>` to its scope, so `unlearn` and `learn --replaces` refuse another scope's lesson (`scope_refused`).

## Risks

A lesson is text a leader wrote, possibly after reading a worker's report. It is one line, labelled as facts and not instructions, only a leader or your terminal can write one, and every change is an event; review them with `flowryn learnings` and drop one with `flowryn unlearn`.

## Tests

`test/unit/learnings.test.ts` (normalising, confirm and revive, the cap, expiry, replace, visibility, the session-start block, the config key, the legacy scope move) and `test/integration/leader-scope.test.ts` (a work leader's lesson reaches a new work session's start and never the personal leader's start, list or verbs).
