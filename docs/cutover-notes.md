# Cutover notes

The work that lets Flowryn replace Firstmate: decisions (C1), prompt wedges (C2), the Firstmate import (C3). Spec: the cutover spec in the superpowers vault. Each section records the choices made where the spec left room, and live results.

## C1 · Decisions

- A run-scoped question is `q<N>` (`flowryn ask`); a standalone decision is `k<N>` with its own backlog task (`--kind decision`), held for the user. Content lives in `decisions`; the task, hold and blocked-by edges in the backlog. A decision task has no `task_policy` row, so it counts as landed once Done (`hasLanded`).
- Reserved classes (`[decisions] reserved_classes`): merge, destructive, irreversible, security, credential, outward. Matching is keyword-based in `src/attention/decisions-policy.ts` and errs toward reserved; a source's own `Reserved:` reason wins.
- A captain answer is accepted from Claude's prompt (an `ask` rule plus the PreToolUse attempt bound to `decision:<id>`), the Pi `flowryn_decide` confirm (the lease's approval key) or your own shell (`human`). Nothing else.
- Dependent work starts by itself only as the scheduler already allows: a plan phase or a `--blocked-by … --auto` ship in an `autonomy = plan` project.
- Scout reports: an `## Open decisions` section, one `### <key>: <question>` entry each; a malformed entry becomes a decision with its raw text.
- A Claude leader's gate (`src/leader/hooks.ts`) matches any shell line containing `flowryn … decide … captain`, whatever its spelling (quoted, reordered flags, `--by=captain`, a backslash-newline continuation); the prompt it raises shows the literal command. A line with more than one captain answer gates and prompts but records no attempt for any of them, so none of the `decide` calls it runs can ever match one — it refuses by construction. Every one of a Claude leader session's unmatched approval attempts — merge, discard, gate and decide alike — is voided fail-closed on every tool call, at Stop and at the next prompt (`voidPendingAttempts` in `src/policy/approvals.ts`), so a declined or abandoned prompt can never be reused later in its five-minute window.
- Known, deliberately parked limits, outside the design's confused-agent threat model (design section 7), left open as follow-ups:
  (a) an attempt binds to (action, task), not the exact command text, so a background process the leader started earlier could still race a pending prompt and consume it;
  (b) a leader shell can itself fake a "human" caller — run with no token and a pty (for example `script`) — and answer as captain, since the human path has no approve-style code challenge of its own;
  (c) the Pi shell gate can be dodged by mid-word quoting (for example `fl''owryn hook approval-key`), so the approval key's secrecy, not the shell gate, is the real protection on Pi.
