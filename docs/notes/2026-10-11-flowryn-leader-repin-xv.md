# Leader repin

- Status: done
- Open: not run live against a real drifted Claude leader; the cause of the 2026-10-10 drift is a separate follow-up scout (q54)

A Claude leader's chat answers count as captain actions (`docs/notes/2026-10-10-chat-answers-authorise-5g.md`) only when its transcript sits in Claude's project folder for the session's pinned directory (`leader_sessions.cwd`, set by `flowryn lead` from its own cwd and checked in `transcriptProblem`). On 2026-10-10 the leader's Claude kept its transcript under `~/projects` while the pin said `~/projects/flowryn`, so every grant was refused. Before this change the only fixes were a new leader, which the user can't start from /remote-control, or editing flowryn.db by hand, which is forbidden and is the forgery path q46 closed. Design: task `flowryn-leader-repin-xv` (gate g99), approved 2026-10-11. Plain code throughout: a transcript scan, a slug comparison and a challenge code. No model.

## The verb

`flowryn leader repin [<dir>]`, run by you in your own terminal:

```
$ flowryn leader repin
Repin leader session L12 (claude in pane w1:p2)
  transcript  ~/.claude/projects/-Users-pr0digy-projects/0986de12….jsonl
  Claude session 0986de12…, its process runs in /Users/pr0digy/projects
  pinned now  /Users/pr0digy/projects/flowryn
  repin to    /Users/pr0digy/projects   (the transcript's own cwd)
  Every chat-answer grant from before now stops working; 1 live grant is voided.

Type QZKM to repin (anything else cancels):
```

1. **The CLI** (`src/cli/commands/leader-repin.ts`) uses the same channel as `flowryn approve`. It refuses (`human_only`) when `FLOWRYN_TOKEN` or `FLOWRYN_RUN` is set, or when stdin and stdout are not both a terminal. It reads the code from `/dev/tty`, so piped input cannot answer it. q52 chose this code over a plain y/N.
2. **`leader.repin.begin`** (daemon, role `human` only, reply never stored; `src/lease/verbs.ts`, `planRepin` in `src/lease/repin.ts`) takes the lease holder. The holder must be an open Claude session with a recorded transcript that sits directly in a folder of `[grants] claude_projects_dir`. It picks the target this way:
   - Claude names the folder by turning every character but A-Z, a-z and 0-9 into `-`, so the name cannot be inverted. Begin reads the transcript's tail instead (the same 16 MB the grant check reads) and takes the distinct `cwd` fields of entries with this Claude session id. It keeps only existing directories whose folder name is the transcript's folder.
   - Exactly one must remain. With none, or with several (`/a-b` and `/a/b` share a folder), it refuses and asks for `<dir>`.
   - A `<dir>` you name must pass the same folder test. One that would not fix anything is refused, naming both folders.

   An already-matching pin is refused (`no_change`). It also reads the live Claude process's cwd from the pid `flowryn lead` recorded (`lsof` on macOS, at the path the daemon resolved since launchd's PATH may not reach `/usr/sbin`, with a 5-second timeout; `/proc` on Linux; after checking the process identity; `unknown` otherwise). That is only shown, never gating (q53). The challenge lives in the in-memory `ChallengeStore` (action `repin`, 2 minutes, one use), bound to the session, the old and new directory and the transcript.
3. **`leader.repin.confirm`** (role `human`) takes the challenge and, in one transaction (`applyRepin`):
   - re-checks that the session still leads with the same pin and transcript;
   - sets `cwd` and `pinned_at`;
   - voids the session's live grants, every one neither consumed nor voided, expired or not, the same count the prompt showed (`the leader was repinned`);
   - appends `leader.repinned` {session, by, channel `cli-tty`, old_cwd, new_cwd, transcript, grants_voided}.

   `approve.confirm` refuses a repin challenge, and repin confirm refuses an approval challenge. Either way the challenge is used up.

## Nothing from before a repin counts

With `pinned_at` set (migration 19):

- `postAsk` mints nothing for a question recorded before it ("it was asked before the leader was repinned; ask again").
- `transcriptProblem` refuses a grant made, or a question asked, before it. It accepts no answer line timestamped before it, whatever the 60 s skew allowance.
- `takeGrant` refuses a grant made before it, in case one was never voided.

So an old AskUserQuestion answer in the new folder (from an earlier session, or from before the leader drifted) cannot be replayed. A forged pre- and post-tool pair for it records a fresh question, and the answer line is still older than both the question and the repin.

## Refusals and audit

- The folder-mismatch and no-directory grant refusals end with "run flowryn leader repin in your terminal". Their help line says the user runs it, not the leader. The leader skill (`src/bridges/skill.ts`) tells the leader to pass that on and never try it.
- `flowryn show L<n>` shows the session: harness, pane, lease, state, cwd, transcript and its last 10 grants. Its `pin` lists where it opened (`leader.session_opened` now carries `cwd`; for an older session the first repin's `old_cwd` stands in), then each repin with who, old → new and the grants voided.

## Threat model (confused-agent grade, design section 7)

| Threat | Mitigation | Residual |
|---|---|---|
| A prompt-injected leader repins itself | CLI refusals above; both daemon verbs take only the token-less `human` caller; Claude's static deny `Bash(flowryn leader repin*)` (`src/bridges/claude/settings.ts`) and the Pi shell gate (`leader\s+repin` in `src/policy/toolkit.ts`) | docs/cutover-notes.md C1 (b), as for `approve`: a leader shell that drops its token and drives a pty can fake the human channel |
| Replaying old answers after a repin | The cutoff above; live grants voided | None within grade |
| The leader steers the target by forging `hook session-start` to another Claude session's transcript | The prompt shows the transcript, its Claude session id and the live Claude process's cwd before you type the code; nothing from before the repin counts | C1 (e) moves to a directory you confirmed rather than widening: it still needs your fresh answer in that other session |
| A stale or swapped prompt | Challenge bound to session, old and new directory and transcript; one use; re-checked at confirm | — |

## Choices made here

- **Only the lease holder**, no `--session`: the task asks for the current leader, and a read-only session uses no grants.
- **`ChallengeStore` reused** with a `repin` action and its own binding, rather than a second store. A daemon restart forgets a pending repin, and you run it again (the restart guard holds a restart while one waits for its code, as for `approve`).
- **Live grants voided at the repin** as well as the cutoff, so `show` reflects it at once.
- **A Pi leader is refused**: grants are Claude-only.
- **The root cause is out of scope** (q54): a separate follow-up scout looks at why the 2026-10-10 transcript landed under `~/projects`.
- **Version**: 0.22.0.

## Tests

- `test/unit/leader-repin.test.ts`:
  - derivation, named after the design's assumptions: transcript entries carry `cwd` and `sessionId`; the folder name cannot be inverted, so two directories sharing it are refused;
  - other sessions' entries, other folders and gone directories are ignored;
  - a named directory: right, wrong and missing;
  - refusals: already pinned, a Pi leader, no lease, no transcript, outside the projects directory;
  - migration 19; the repin's row, voids and event; the binding (changed transcript, moved lease, ended session); the pin history for an older session;
  - grants: refused before the repin naming the fix, a fresh answer working after; a question that spans the repin; a replayed answer line inside the skew allowance; an unvoided old grant at use;
  - the shown live-grant count equals the voided one, an expired grant included;
  - the process cwd read through the real `lsof`/`/proc`, with a gone process reading as unknown; on macOS through the daemon's resolved lsof path, unknown without one.
- `test/integration/leader-repin.test.ts`: end to end through the real leader hooks, CLI and daemon, in a real pty:
  - a drifted fake Claude leader's grant is refused naming the fix, and a wrong code changes nothing;
  - the screen shows the old and new directory, and the code repins;
  - the old grant stays dead, a fresh answer works, and `show L<n>` lists the history;
  - refused under a leader token, without a terminal and from the leader's Bash (static deny); the daemon verb refuses a token caller;
  - approve and repin challenges cannot cross.
- `test/unit/db.test.ts`: migration 19 on a database in use (an existing session reads as never repinned); the chat-grants (17) and gate-browser-open (18) migration tests pin themselves to their own migration.
- `test/unit/toolkit.test.ts` and `test/integration/toolkit.test.ts`: the Pi shell gate blocks `flowryn leader repin` (and not `leader status`).
