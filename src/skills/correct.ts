/**
 * The correct skill (docs/notes/2026-11-22-phase-corrections-become-7t.md): a correction that
 * repeats becomes a check, not another line of prose. Adapted from the idea of pstack's `correct`
 * (plan p104, proposal 9), not copied. One harness-neutral text, written three ways: into the
 * worker skills (src/skills/stages.ts; the weekly corrections scout's stage names it, and each
 * ship it files points at it), and into the leader's plugin and Pi skill directory
 * (src/bridges/files.ts), so a leader that sees the user correct the same thing twice reaches for it.
 */

export const CORRECT_SKILL_NAME = "correct";

/** The report section whose entries Flowryn files as ships (src/leader/corrections.ts parses it). */
export const CHECKS_HEADING = "Checks to ship";

/** The enforcers, highest first: the order a class's fix is chosen in. */
export const ENFORCERS = ["architecture", "type", "lint", "test", "doc"] as const;

export const CORRECT_DESCRIPTION =
  "Turn a repeated correction into a deterministic check: pick the highest enforcer (architecture, type or lint, test, doc), prove it fails on the past mistake and passes on HEAD, and record it in AGENTS.md. Use when a correction repeats.";

export const CORRECT_BODY = `# Corrections become checks

A correction made twice is a mistake class. Prose rules go stale and nobody enforces them; a check does. Fix the class once, at the highest level that would have caught it.

## 1. Is it a class?
- Gather the corrections: the user's or the leader's words (steers, answers, review-page messages, send-backs, \`flowryn learnings\`; \`flowryn corrections <project>\` lists a week of them with ids).
- Group by the kind of mistake, not the words: "drop the fold", "no section titles" and "do not repeat Context" are one class (clutter the user removes by hand).
- A class needs two corrections or more. A one-off stays a correction.
- Already enforced? Read the project's AGENTS.md rule↔enforcer table and its tests. A class whose check exists but missed the mistake is a bug in that check: fix the check, do not add a second one.

## 2. Pick the enforcer, highest first
1. architecture: make the mistake impossible (one function every caller goes through, a type that cannot hold the bad state, a template with no slot for it).
2. type or lint: the compiler or linter refuses it, and its message names the fix ("use runBounded, not Bun.spawn", not "bad call").
3. test: a test that fails on the mistake, named after the rule.
4. doc: one line in AGENTS.md, only when 1 to 3 cannot express it. Say why.

## 3. Prove it
- Find a commit that made the mistake (\`git log -S\`/\`-G\`, the corrected task's branch).
- The check must fail on that commit and pass on HEAD. Run both and keep the output; a check never seen failing is a draft.
- A check that would fail on HEAD found live cases: fix them in the same change, or say why not.
- Keep it fast and deterministic: no network, no model, no sleeps.

## 4. Record it
Add one row to the project's AGENTS.md rule↔enforcer table (create it, under "## Rules and their checks", if missing):

| Rule | Enforced by | Proven on |
|---|---|---|
| Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4, passes at HEAD |

Verify reads the table (\`flowryn laws <project>\`) and refuses a head whose row it cannot check:
- Enforced by: a test file it runs (\`*.test.ts\`, a Go package \`internal/x\` with its \`TestName\`), a file that must hold a name (\`.oxlintrc.json\` \`no-shadow\`), or \`verify: <step>\`. Separate several with ";".
- Proven on: the commit it fails at. A new row without one is refused.
A doc rule names its file and words: \`AGENTS.md\` \`never rebase\`. Remove the prose rule the check replaces.

## As the weekly corrections scout
You change no code. Report with \`$FLOWRYN_BIN deliver --report\`: \`## Short answer\` (at most 15 lines), then \`## ${CHECKS_HEADING}\`, one entry per class, at most five:

    ### <the check, one line>
    Evidence: <two or more ids from your task's corrections list>
    Enforcer: <${ENFORCERS.join(" | ")}>
    Past mistake: <commit or task where it happened>
    <what the check is, where it goes, its message, how to prove it>

Then \`## Classes not filed\`: one-offs and classes already enforced, with the check that should have caught them. Flowryn files each entry as a ship of the project; an entry citing fewer than two ids from your list is refused.

## As a ship that builds a check
Build the check your brief names, prove it (step 3) and add the AGENTS.md row (step 4) in the same change. The proof goes in your handoff: the commit, the command, the failing and the passing output tail.
`;
