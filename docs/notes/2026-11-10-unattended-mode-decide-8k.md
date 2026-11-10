# Unattended mode decides keyword-misfired no-mistakes questions

- Status: done
- Open: not yet run live (tests use the real daemon and CLI, real git and the stand-in no-mistakes status)
- Config: `[decisions] unattended_findings`

Under unattended mode (docs/notes/2026-11-05-unattended-mode-one-9e.md) a question parks when its recorded class or its wording is destructive, irreversible, security, credential or outward. The classes come from keyword patterns, so most past parks were no-mistakes review or test findings that only contained a word: q196 ("secret scan", the name of a test), q154 ("does not weaken an assertion", the worker's own prose), q146/q151/q203 ("remove", "drop", "discard"). This change adds a plain-code exemption for those, off by default. No model.

## The setting

`[decisions] unattended_findings = "off" | "credential" | "by-answer"` (default `off`; any other value or type is `config_invalid`).

- `credential`: a question whose only protected class is credential may be decided by the finding rule.
- `by-answer`: any of the five classes may be, judged by what the recommended answer does.

The user chose (design review, 2026-11-10) to build both and run at `credential`.

## The daemon's record

`flowryn ask --nomistakes` already reads no-mistakes' status and git daemon-side (`prepare`). When that read succeeds, the ask now stores it on the decision as `decisions.nm_record` (migration 62): `{v: 1, step, findings: [{id, action, severity, category, file, cls, description}]}`, every field sanitized to one line, descriptions capped at 1000 characters, at most 20 findings (more, or over 16 KB: stored as `truncated`, which exempts nothing). An ask with the worker's own `--reserved` stores none. Nothing else writes the column, so finding-like words in a plain `ask` never qualify. A spooled ask is read when the daemon ingests it (the gateway runs `prepare` then), like the rule matching it shares.

## The rule (src/attention/real-actions.ts, src/attention/autonomy-pass.ts)

The question verdict now runs: skip checks; the worker's own `--reserved` parks; a sensitive task parks; then the protected classes (the recorded class plus every class the question and context name, `keywordClasses`). With any class, it parks unless `exemptFinding` says yes, which needs all of:

1. the setting covers every class the question has (credential mode never decides a question that also names "drop");
2. a recommendation among its options (a protected question without one parks, as before);
3. an `nm_record` that reads, at a judged step (`LEADER_STEPS`: review, lint, test, document, docs, format), with at least one ask-user finding;
4. every ask-user finding has a severity that is not `error`, and a file inside the branch's diff (added, diff-line, touched); no finding sits in a secrets-like file (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, a path with "secret" or "credential");
5. the recommended option's kind is not `skip` (label names skip, ignore, waive, defer, bypass, suppress); `approve` (approve, accept, keep, as-is, tolerate, leave) is refused on a credential question whose finding is filed under secrets/credentials or touches credentials (sets, unsets, reads, loads, removes, deletes or changes a credential, secret, token, API key or password), and on a security question whose finding is filed under security; anything else is `fix`;
6. no real-action phrase of any class appears in the option, the worker's why, the question, its context, or any recorded finding's id, category or description:

| Class | Real actions (always park) |
|---|---|
| credential | rotate, revoke, regenerate, reissue, re-key, paste, hard-code, commit, check in, expose, leak, print, log, share, send, store, save a key, token, secret, password or credential (within three words, in one sentence); or such a noun then leaked, exposed, logged, printed, committed, hard-coded, stored, sent, unset |
| destructive | drop, truncate, delete, remove, wipe, purge, erase, destroy a table, database, schema, bucket, rows, volume, backup, all data, user/customer/prod data, records, accounts or tables, production; `rm -rf` |
| irreversible | the keyword pattern (force-push, history rewrite, irreversible, cannot be undone, permanent); `reset --hard`; rebasing a pushed, published or remote branch; deleting a branch or tag |
| security | disable, bypass, turn off, skip, relax, loosen, weaken auth, TLS, SSL, MFA, 2FA, sandbox, verification, signatures, hooks, guards, permissions or security; `--no-verify`; `chmod 777`/`677`; allow-all; public bucket or access |
| outward | the keyword pattern (publish, announce, post to, email the client, tweet, press release, send to the customer); npm or package publish; create a release; push tags; send an email or message |

A false match only parks. The credential phrases stop at a full stop, colon, semicolon or line break, so "…change. The gate-questions secret scan…" is not "change … secret".

## Deciding and undoing

A decision taken by the rule goes through the same path as every unattended decision: `answered_by = worker`, `answered_via = autonomous`, the worker's why kept, the steer sent. Its `autonomy.decided` event adds `rule` (`finding-credential` or `finding-by-answer`) and `classes`, and the morning report line adds "was credential, decided by the finding-credential rule" before the usual `undo: flowryn decide <id> <choice> --by captain`. A park keeps today's reason with the rule's why after it (for example "a credential question: no no-mistakes record").

With the setting `off`, verdicts and their reasons are as before, except that a sensitive task's protected question now gives "a sensitive task's question" (the sensitive check moved ahead of the class checks so no exemption can reach it; it parked before too).

## Past questions, under each value

| Question | What it was | credential | by-answer |
|---|---|---|---|
| q196 credential | a test named "secret scan"; approve | decides | decides |
| q91 credential | the change unsets workers' credentials; approve | parks (touches credentials) | parks |
| q46 credential | security hole in chat approvals; fix | parks if filed under security (unknown) | decides |
| q154 security | flaky test, worker wrote "does not weaken"; serial | parks | decides |
| q146, q151, q203 destructive | remove unused code, drop a setup line, "discard" in prose | parks | decides |
| q143 destructive | real flaw rated error | parks | parks |
| q58, q60, q62 irreversible | no-mistakes rewrote history itself (not an ask --nomistakes) | parks | parks |

Questions asked before this change have no record and keep parking.

## Security

The question, options, recommendation and why are worker-written. None can create the exemption; they can only add parks. no-mistakes' own finding text is a model's reading of the worker's diff, so a worker can influence it; errors, findings outside the diff, approve on secrets or security findings, any real-action phrase, sensitive tasks and worker-reserved asks still park, the answer only steers the worker, and every decision is reported with its undo.

## Tests

- `test/unit/autonomy-findings.test.ts`: each rule alone on q196-, q154- and q91-shaped fixtures; rotate the API key, drop the users table, force-push, npm publish, disable TLS and `rm -rf` park; a plain ask, a reserved ask and a sensitive task park; error, outside the diff, no file or severity, a ci gate, a secrets file, skip, no recommendation, a malformed or truncated record park; credential mode never decides a question that also names another class; `off` keeps today's reasons; the setting's values; the record's sanitizing and cap.
- `test/integration/autonomy-findings.test.ts`: real daemon and CLI under a grant from `autonomy.begin`/`confirm`: the q196-shaped `ask --nomistakes` is decided (`answered_via autonomous`, event with the rule), the same words in a plain ask park, `back` lists it with the rule and the undo, and `decide --by captain` undoes it.
