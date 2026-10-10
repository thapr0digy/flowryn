# Chat answers authorise captain actions

- Status: done
- Open: AskUserQuestion over /remote-control (A3) not run live (the lab cannot drive remote control); no live end-to-end run of a real Claude leader using a grant (the c15 spike covers the platform facts with probe hooks)
- Config: `[grants] claude_projects_dir`

The user often answers from their phone over /remote-control, where a Claude permission prompt for `decide --by captain`, `gate pass` or `merge` could not be relied on. Their answers already reach the leader chat through AskUserQuestion. Now such an answer authorises exactly the action it names. It works through the Claude leader's own hooks and plain code; no model reads an answer.

## How it works

1. `flowryn chat-question <item>` prints one AskUserQuestion question, as JSON, for a decision (`q<N>`, `k<N>`), a review gate (`g<N>`), a backlog divergence (`d<N>`) or a merge (`merge:<task>`). The question starts with the item (`q42 · `, `merge T17 · `). Flowryn writes the whole question: its text, header, labels and descriptions, with the recommended option marked `(Recommended)`.
2. The leader passes it unchanged (up to 4 per call). The PreToolUse hook (`hook pre-tool`, `preAsk` in `src/policy/grants.ts`) denies the call when:
   - a question starts like a binding one but differs from the form Flowryn writes now (the deny reason gives that form);
   - the call carries its own `answers` or `annotations`;
   - one item is asked twice;
   - the tool use id was already seen.

   Otherwise it records the call in `chat_questions`: its tool use id, its session and a hash of its questions. A question with no binding prefix passes untouched and grants nothing.
3. You answer. The PostToolUse hook (`postAsk`) pairs the answer with the recorded call by tool use id, session and question hash. It then writes each form again (stale facts, such as a moved head or a closed gate, grant nothing) and maps your answer to a choice:
   - a label names the choice;
   - for a multi-select question, labels joined by commas name several;
   - "Don't merge" grants nothing;
   - free text ("Other") grants only a gate's changes, with your text as the words.

   Each grant is a `captain_grants` row `c<N>`: the item, the choice, your verbatim answer and notes, what it binds (a merge's head), the session, the tool use, the transcript and the times. The leader sees `Grant c7: … Run it now: flowryn grant use c7` beside the tool result.
4. `flowryn grant use c7 [--body-file -]` runs the granted action through its own command: `decide --by captain`, `gate pass`, `gate changes`, `divergence resolve` or `merge`. The grant travels under an internal argument that no CLI call can carry. That command's prepare step (`prepareCaptainGrant`) checks the grant against Claude's transcript (below); its transaction then takes the grant (`takeGrant`) and records the action:
   - a decision: answered by captain, via `claude-chat`;
   - a gate pass or a merge: an approvals row with the new channel `claude-chat` and an actor naming the grant;
   - gate changes and a divergence: the grant is named as who settled it.
5. The same commands, run directly, use a matching live grant and refuse a grant for another choice of the same item (`grant_mismatch`). A plain `flowryn merge <task>` that a live grant covers at its current head is not prompted (`chatGrantedMerge` in `src/leader/hooks.ts`). `decide --by captain` and `gate pass` still prompt from their static ask rules: a hook "allow" does not override an ask rule (c15). That is why grants go through `grant use`, which no ask rule matches.

Audit: every step is an event: `chat.question_asked`, `chat.question_denied`, `chat.answer_ignored`, `grant.recorded`, `grant.declined`, `grant.refused`, `grant.verified`, `grant.used` and `grant.voided`. `flowryn show <item>` lists its grants (a decision, a divergence, a task for its gates and merges, `g<N>` as its task), and `flowryn show c<N>` shows one grant in full.

## Lifetime (the user's choices)

- **q43: end of turn, at most 10 minutes.** A grant is voided at Stop, at the user's next message and at session end (`voidSessionGrants`), and expires `GRANT_TTL_MS` (10 min) after it is made.
- **q44: eligible actions**: reserved decisions, gate pass, gate changes and divergence resolve. Any open decision with 2 to 4 options can be asked, since a captain answer to an unreserved one only records more than the leader may. Gate changes and divergence resolve need no word from the user. Their grant records that the answer was the user's (and a "Pass" answer refuses changes); it does not gate them.
- **q45: merges are included, bound to the head the question showed, never waiving a red check.** A merge with `--allow-red` takes no grant.
- A confirmed prompt for the same item still works and wins: it voids that item's live grants. So does a standing `flowryn approve` record that a merge uses, and a later chat answer to the same item in the same session (`a later answer replaced it`), so only the user's latest answer can run.

## Threat model (confused-agent grade, design section 7)

| Threat | Mitigation | Residual |
|---|---|---|
| A prompt-injected leader claims "the user said yes" | A grant comes only from the hooks' record of a real AskUserQuestion answer; no verb mints one | None within grade |
| The leader pre-fills `answers` so no dialog appears | PreToolUse denies it (c15: no dialog, no PostToolUse); PostToolUse grants only for a tool use PreToolUse recorded clean, with the same questions. The hook fails open when the daemon is down, so the transcript check also refuses a grant whose tool use in Claude's transcript carried `answers` or `annotations` | — |
| The leader words a misleading question | The binding form is Flowryn's, checked exactly before and after the answer | The leader can still argue in chat around the fixed question |
| The leader forges hook calls (its token is the hooks' token; `Bash(flowryn hook *)` is denied only as a backstop) | Before use, the daemon reads Claude's transcript. It must be the one the session started with, sit directly in Claude's project folder for the directory `flowryn lead` opened the session in (`leader_sessions.cwd`, which no hook changes; Claude names the folder by turning every character of the path but A-Z, a-z and 0-9 into `-`) under `[grants] claude_projects_dir`, and hold the AskUserQuestion tool use (same questions) and its result (same answer, timestamped after the question was recorded, in that Claude session), and the tool use must carry no answers of its own. The leader settings deny `Edit(//<projects>/**/*.jsonl)`, and sandboxed Bash cannot write there | An agent that leaves the sandbox and writes the transcript with another interpreter: the same class as design section 7's "another interpreter calls the binary". A leader that repoints its session's transcript (a forged `hook session-start`) at another Claude session's transcript in its own directory, one that asked the canonical question outside a Flowryn leader, with the user's real answer: docs/cutover-notes.md C1 (e) |
| Replay | One use; `chat_questions` is keyed by tool use id, so a re-sent pre- or post-tool call records nothing; an older answer line fails the timestamp check | — |
| A stale grant | Turn-scoped, 10 minutes, bound to its session; the command re-checks the item (decision open, gate open, head unchanged, divergence unresolved) | — |

## Platform facts (spike c15, Claude Code 2.1.296)

`spikes/claude/c15-ask-user-question.sh`, run live in a lab session with probe hooks:

- **A1: confirmed.** PostToolUse carries `tool_input` and `tool_response` `{questions, answers, annotations}`, with answers keyed by question text.
- **A2: confirmed.** A PreToolUse deny on an AskUserQuestion with pre-filled answers shows no dialog and fires no PostToolUse.
- **A4: confirmed.** The tool result line (`toolUseResult.answers`) is in the transcript by the next Bash PreToolUse.
- **A5: refuted.** A hook "allow" on a Bash command matched by the ask rule `Bash(flowryn decide *captain*)` still prompts. Hence `grant use`, the design's named fallback.
- **A3: not run.** Whether the dialog can be answered over /remote-control.

All 82 recorded approval attempts on this machine ran in `auto` mode, so the leader was not in bypass mode. The gap was remote control.

## Choices made here

- **`grant use` rather than relying on a hook allow** (A5).
- **A fully canonical form**, descriptions included, so the leader writes nothing a binding question shows.
- **Transcript corroboration rather than a hook-only secret**: the hook and the leader's Bash share one environment.
- **`[grants] claude_projects_dir`** defaults to `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, as the daemon sees its environment. Set it when the leader's Claude uses another config directory, or grants are refused (fail closed).
- **The approvals table is rebuilt** for the `claude-chat` channel (SQLite cannot alter a CHECK; merges and gates reference it). Migrations gained `rebuildsReferencedTable`, which runs the rebuild with foreign keys off and requires a clean `PRAGMA foreign_key_check` before commit.
- **Pi leader: out of scope.** Pi has no remote chat. Its extension tools (`flowryn_decide`, `flowryn_gate_pass`, `flowryn_merge`) already ask through `ctx.ui.confirm` and carry the approval key. A named grant from a Pi session is refused.
- **No model anywhere.** A prefix, fixed templates, string equality and JSONL parsing.

## The leader's preferences

`~/.flowryn/leader/preferences.md` is the user's file and outside the repo, so the leader applies this after merge. Replace the last sentence of "Decision pages take answers in the page (2026-10-05)" with:

> When the user is on remote control, ask in chat: `flowryn chat-question <id>`, pass the question unchanged to AskUserQuestion, then `flowryn grant use <grant>` at once in the same turn; their answer is their word (grants end with the turn).

## Tests

- `test/unit/chat-grants.test.ts`: binding prefixes and refs; decision forms; exact comparison and hash; answer mapping (labels, `(Recommended)`, multi-select, free text, Don't merge); the assumptions A1, A2, A4 and A5; one use, mismatch, another session; expiry and turn end; replay; the transcript checks (wrong file, outside the projects directory, an answer older than the question); merge head binding; config; the leader static layer.
- `test/integration/chat-grants.test.ts`, through the real leader hooks and CLI with the fake Claude leader (which now plays AskUserQuestion and keeps its transcript under `<home>/claude-projects/`):
  - a decision used once with no prompt;
  - a reworded or pre-filled question is denied, and free text grants nothing;
  - a forged hook call mints a grant that can never be used, and replays mint nothing;
  - mismatch, turn end, and a confirmed prompt that still works and wins;
  - a divergence;
  - a gate's changes with the user's typed words, then a pass (channel `claude-chat`);
  - a merge bound to the PR head with no prompt, and Don't merge.
- `test/unit/db.test.ts`: migration 16 keeps the approvals and the merges that reference them, and turns foreign keys back on.
