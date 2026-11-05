import type { DocKind } from "./brief.ts";

/**
 * The templates `flowryn template <kind>` prints. Each passes docProblems
 * once its {{slots}} are filled (a unit test checks the headings line up).
 * The intent half is the user's, the spec half the leader's (firstmate's
 * split): acceptance criteria never hide among build instructions.
 */

const SHIP = `<one-line title>

## Intent
{{The user's words, verbatim and quoted, with the date. Then the acceptance criteria: what must be true for the user to call it done.}}

## Context
{{What the worker needs to know, written in: the substance of each report, review, decision or PR the task comes from, with its path or URL as the source. Not "read X": say what X says that matters here.}}

## Requirements
{{Numbered, testable requirements. Behaviour, interfaces, data, edge cases.}}

## Constraints
{{Project rules that bind this change (AGENTS.md lines that apply), the toolchain, what must stay compatible, and what never to do.}}

## Security
{{The threat surface: inputs and who controls them, secrets and where they must never appear (logs, storage, task files), validation, authorization, and the failure paths that must be tested. "None: <reason>" only when there is truly no surface.}}

## Out of scope
{{What this task could reasonably do but must not.}}

## Verification
{{The exact commands, and what output proves done.}}

## Spec
{{Optional: the leader's build instructions (approach, files). Never the user's intent; that is above.}}
`;

const SCOUT = `<one-line title>

## Intent
{{The user's words, verbatim and quoted, with the date, and what they want to learn.}}

## Context
{{What is already known, written in, with its sources.}}

## Questions
{{What the report must answer, numbered; each answered with evidence (paths, commands, output).}}

## Out of scope
{{What not to investigate or change.}}
`;

const HANDOFF = `## Done
{{What this stage did: commits, files, tests added.}}

## Deviations
{{Where the work differs from the approved spec, and why. "None." when it does not.}}

## Risks
{{Open risks and what the next stage must check. "None." when there are none.}}
`;

const SPEC = `# Build spec: <title>

## Approach
{{How the change works, in steps; the deterministic parts and any model call (and why).}}

## Files and interfaces
{{The files to add or change, and every function, verb, flag, config key and event they expose.}}

## Data and schema
{{Tables, columns, migrations, stored formats; "None: <reason>" when nothing is stored.}}

## Error handling
{{Every failure and what the caller sees; nothing fails silently.}}

## Security
{{Threat surface, secrets, input validation, authorization, size limits.}}

## Test plan
{{Unit, integration and assumption tests, each named after what it proves.}}

## Rejected alternatives
{{The other ways, doing nothing included, and why each lost.}}
`;

export const DOC_TEMPLATES: Readonly<Record<DocKind, string>> = { ship: SHIP, scout: SCOUT, handoff: HANDOFF, spec: SPEC };
