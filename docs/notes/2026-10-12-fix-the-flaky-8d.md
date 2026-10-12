# Flaky harness-gate test: in-place rewrite of the stand-in harness

- Status: done

## Design

### The demonstrated boundary

Two tests in `test/integration/harness-gate.test.ts` failed intermittently:
"at startup an untested version in use opens one P1 ..." timed out waiting for
"the P1 for 9.9.10", and "a worker that dies on an untested version ..." for
"the P1 for 9.9.11". Both update the harness with `setHarnessVersion`. On this
Mac the file failed 5 of 6 runs, each time in one or both of them. The kept test home of a failure shows why: the daemon log
after the restart says

```
harness: claude cannot read the claude version from <home>/bin/claude --version
```

so the startup check returned `missing` (no P1, by design: a harness that cannot
run is dispatch's `tool_missing`, not an untested version), not `unverified`.
The file on disk did answer `9.9.10`.

`setHarnessVersion` (`test/helpers/fleet-env.ts`) rewrote the stand-in binary
in place: `writeFileSync` on the path the daemon had already executed, so the
same inode with new contents. macOS's kernel then SIGKILLs an exec of that
vnode (its executable validation cache no longer matches the contents),
intermittently and stickily: a standalone repro (write a `#!/bin/sh` script,
exec it, rewrite it in place, exec it again) gave SIGKILL with empty output in
18 of 200 tries, an immediate re-exec of a killed one was killed again in 18 of
18, and the same sequence replacing the file by rename (a new inode) gave 0 of
200. `harnessVersion` saw a killed process with no output and parsed no
version. Not a race in the test's wait, and not startup ordering: the check ran
and got a binary that could not run.

### The rule

A test that "updates" a harness replaces its binary the way an installer does:
write a new file beside it and rename it over the old path (a new inode),
never rewrite an executed binary in place. `setHarnessVersion` now does that;
`test/integration/harness-gate.test.ts` asserts the helper gives a new inode,
which fails deterministically on the old helper (same inode every time) rather
than at the kernel's ~9% rate.

### Product

No product change. The daemon reports what it saw: a binary the kernel kills
on exec has no readable version, and the startup check logs it as such.
Retrying in `harnessVersion` would not help (the kill is sticky for that file
until it is replaced, and a replacement changes the mtime, which already
invalidates the version cache). Real harness updates (the Claude installer's
versioned binaries, npm) replace files rather than rewrite them in place.

### Files

- `test/helpers/fleet-env.ts`: `setHarnessVersion` writes a temp file and renames it over the binary.
- `test/integration/harness-gate.test.ts`: the new-inode case.

### Out of scope

- `harnessVersion` caches a `null` from a timed-out `--version` until the
  binary's mtime changes. Not demonstrated by this flake; left as is.
- No migration, no persisted field, no protocol change.
