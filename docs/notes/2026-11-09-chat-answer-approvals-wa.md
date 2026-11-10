# Chat-answer approvals for discard and allow-red

- Status: done

The user can approve two actions that needed `flowryn approve` at their own terminal (or a Claude permission prompt) from a chat question, away from the keyboard: discarding a task's unlanded work, and merging while waiving the one failing check. They follow `merge:<task>` (docs/notes/2026-10-10-chat-answers-authorise-5g.md): Flowryn writes the question, only the Claude leader's own hooks mint the grant, it is checked against Claude's transcript, used once with `flowryn grant use c<N>`, and ends with the turn or after 10 minutes. `flowryn approve` at the TTY is unchanged. Pi has no chat grant: a Pi leader keeps its confirm (allow-red) and `flowryn approve <task> --discard`.

## `discard:<task>`

1. A plain `flowryn cleanup <task>` that refuses unlanded work (reason `dirty`, `unlanded` or `unpushed`) records what a discard would remove (`run_evidence` source `discard`: worktree HEAD, uncommitted count, sha256 of `git status --porcelain=v1 -z --untracked-files=all`, worktree, branch; event `discard.observed`), and so does `flowryn cleanup <task> --discard` refusing for want of the user's word. A plain cleanup is not a gated command, so a Claude leader gets the record away from the keyboard without a permission prompt. Both refusals' help names the two routes: `flowryn chat-question discard:<task>` and `flowryn approve <task> --discard`.
2. `flowryn chat-question discard:<task>` prints `discard <task> · <title>: worktree <path>, branch <branch> at <head8>, <n> uncommitted change(s) (seen <HH:MM>). Discard this unlanded work? It cannot be undone once the worktree is removed.`, options `Discard` / `Keep it`. Without a record it is `not_ready` and says to run `flowryn cleanup <task>` first.
3. The leader's pre- and post-tool hooks read the worktree live for an AskUserQuestion naming a discard item (`prepareAskFacts`, src/leader/hooks.ts), and record the facts again where they moved. At PreToolUse a question whose text no longer matches the new facts is denied with the current form, and an unreadable worktree denies it. At PostToolUse any discard item whose facts moved since the question was asked, or whose worktree cannot be read, grants nothing (`its facts changed while the user answered; ask again`), even when the question text, which shows only the head, the count and the minute, reads the same. So does one whose snapshot something else recorded again (a plain cleanup refusal, say) after the question was asked.
4. The grant binds `<head> <status digest>`. `grant use` runs `cleanup <task> --discard`, which reads the worktree again: a new commit refuses (`grant c7 was for head …; the head is now …`), and so do changed uncommitted files (`… its uncommitted files have changed since`). The grant is used up just before the cleanup guard runs, so a grant that ended meanwhile removes nothing; a guard refusal after it spends the grant (ask again). The removal records an approval with channel `claude-chat` and an actor naming the grant and leader session.

Known gap: the digest covers which files are uncommitted and their status letters, not their contents, so editing an already-modified file after the tap does not refuse the grant.

## `allow-red:<task>`

The item names no check: a waiver covers exactly one, so the form names the one red check in the PR evidence the daemon recorded; no red check, two or more, unknown checks, a local-only delivery or a scout is `not_ready`. The question is `allow-red <task> · <title>: PR <url> at <head8>, checks <line>. Merge it waiving the one failing check "<check>"? Every other check must be green.`, options `Waive and merge` / `Don't merge`. The answer's choice is the check name, so `flowryn merge <task> --allow-red '<other>'` under a live grant refuses with `grant_mismatch` naming both. `grant use` runs `merge <task> --allow-red '<check>'`; the grant binds the head (a moved head refuses), and the merge gate's live read still requires that check to be the only red one. The approval is recorded with channel `claude-chat` and `allow_red_check`. The plain `merge:<task>` answer still never waives (q45). A confirmed Claude prompt waiving the same check wins over the grant, and another approval that merges ends both merge grants.

## Threats, and what refuses them

- The leader answering its own question: a question carrying answers is denied at PreToolUse and fails the transcript check.
- Forged hook calls: the answer must be in Claude's transcript (`transcriptProblem`).
- A replayed tap: single use, end of turn or 10 minutes, voided by the user's next message and by a repin.
- A tap for one head used on another, or for other uncommitted files: the binding is checked against a live read at use.
- A different check: the choice is the check; `grant_mismatch`.
- A worker or reader: grants are only the Claude leader session's; `grant use` refuses any other caller.

The known limits of the chat channel (docs/cutover-notes.md, C1 · Decisions, (b) and (e)) now reach these two actions too.

## Tests

`test/unit/chat-approvals.test.ts` (item parsing, question text, bindings) and `test/integration/chat-approvals.test.ts` (through the real hooks with the fake Claude leader: a plain cleanup through the leader's Bash hook refuses without a prompt and records the facts; tap → grant use → discard; stale head and changed files refuse; facts moving mid-answer, at the same head, grant nothing; a pre-answered question and a forged answer refuse; allow-red merges, the wrong check and a moved head refuse; the plain merge grant still never waives).
