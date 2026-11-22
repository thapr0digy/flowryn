# Flowryn spends less GitHub

- Status: done
- Open: not yet run live; the hourly spend lines are the measure to watch in flowrynd.log

The daemon shares the user's GitHub identity with Signal and gh-axi. A code read found about 420 REST requests an hour per open delivered PR and a token lookup that could fail for good. Three changes cut that:

## The token is asked for again

`tokenSource` (src/forge/github.ts) used to run `gh auth token` once and keep a failure forever, so a daemon started while the keychain was locked (the Mac with no desktop session, 2026-11-15 to 11-19) sent every request without a token, at GitHub's unauthenticated limit of 60 an hour. Now:

- A failed lookup is asked again after `GH_TOKEN_RETRY_MS` (5 min), never sooner; lookups under way are shared, so concurrent requests spawn gh once. gh still runs through `runBounded` with its 5 s deadline.
- A token gh gives is kept for the daemon's life, as before. A `[github] token_env` variable still wins over gh.
- The daemon log says once when requests to GitHub's API go out with no token, naming the host and why (`gh auth token exited 1`), and once when a token is back. Neither line holds the token or any part of it.
- `flowryn doctor` has a `github token` line: `from $GH_TOKEN`, `from gh auth token`, or a warning with the reason. It looks the token up as the daemon does, from the shell doctor runs in; the daemon's own word is its log line.

## Spend per caller, hourly

Every forge request is counted under its caller (`asForgeCaller`, src/forge/spend.ts): `watch.prs`, `watch.stacks`, `watch.reviews`, `watch.ci-wait` and `watch.after` for the delivery watcher's parts, `other` for the rest (merges, verbs). Once an hour has passed, the next request writes one line per caller:

```
github spend: watch.prs 60 requests, 58 not modified (304), rate limit remaining 4870, 2026-11-22T05:00:00.000Z to 2026-11-22T06:00:12.000Z
```

The tally is in memory: a restart, or a forge rebuilt for new `[github]` config, starts a new hour. An hour with no requests writes nothing.

## A quiet PR is read less

Per pass of the delivery watcher (`[github] poll_ms`, 60 s by default):

- One `pull` per PR per pass, shared by the PR watcher, the review watcher and the CI-wait check. A failed read is not shared.
- Checks are read again only when the head moved, the last summary had no checks or a pending one, or it was red `QUIET_READ_POLLS` (5) polls ago, which catches a CI re-run on the same head. A settled green summary stands until the head moves: a merge reads its checks afresh (src/policy/merge.ts), so the gate never rests on it.
- Reviews and comments are read every `QUIET_READ_POLLS` polls (5 min at the default) instead of every pass. Review threads (GraphQL) keep their own 5-min floor and are read only with the feedback.

A quiet delivered PR in ready now costs 60 pulls, one check read (2 requests) and 12 feedback reads (3 lists each): 98 requests an hour against the fake forge, down from about 420. The 5-poll cadence is a multiple of `poll_ms` rather than a fixed 5 min so a test home with a short poll keeps its reviews prompt; no config key was added.

Not done: GitHub App identity, gh-axi's own use, and `poll_ms` itself.

Tests: test/unit/github-spend.test.ts (the retry floor and the Authorization header on a later request, shared lookups, the warning once, the hourly lines, one pull per pass, the checks and review cadences, the simulated hour, doctor's line).
