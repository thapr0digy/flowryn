# Leader pin drift regression test

- Status: done

A leader session's pinned directory (`leader_sessions.cwd`) anchors every chat-answer grant: `transcriptProblem` (`src/policy/grants.ts`) accepts a grant only when Claude's transcript sits in Claude's project folder for that directory. Only `lead.open` writes it (from `flowryn lead`'s own cwd), and `flowryn leader repin` moves it on your confirmation (`docs/notes/2026-10-11-flowryn-leader-repin-xv.md`).

## The drift this guards against

Scout `find-why-the-ig` traced the 2026-10-10 refused grants to a hook, not the launch. The old `sessionStart` leader hook (`src/leader/hooks.ts`) copied its input's `cwd` into the pin. A Claude hook's `cwd` is the session's current directory, which follows the leader's Bash `cd`s, while Claude keeps the transcript in the folder named for its startup directory. When the context compacted after the leader ran `cd ~/projects/flowryn && …`, SessionStart:compact moved the pin from `~/projects` to `~/projects/flowryn`, and every grant after it failed the folder check. #57 (5db05da) removed that line; nothing tested it until now. So the 2026-10-10 drift came from that hook, not from `flowryn lead` pinning the wrong directory; `repin` is still the recovery for a session that already drifted.

## The test

`test/integration/leader-pin-drift.test.ts`, through the real leader settings' hooks and CLI:

- A fake Claude leader starts in the pinned directory, `cd`s to a subdirectory, then compacts: the pin and `pinned_at` are unchanged, and a chat-answer grant for a reserved decision is used with no prompt. The same holds after SessionStart with `clear`, `resume` and `startup`.
- The leader's own token calling `hook.session-start` directly with `cwd: "/"`, for each source, leaves the pin unchanged, and a grant still validates.

Both cases fail when the old `cwd: input.cwd ?? s.cwd` line is put back in `sessionStart`.

The fake Claude leader (`test/helpers/fake-claude-leader.ts`) gained `cd(dir)`: later hook inputs, transcript entries and `runBash` commands use the new directory, while the transcript stays in the startup directory's folder, as Claude's does. Tests only; no behaviour change.
