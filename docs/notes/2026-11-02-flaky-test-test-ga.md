# Flaky promote test: database is locked

- Status: done

`test/integration/promote.test.ts` "a scout in a review with questions" seeded a review message through its own connection with `db.transaction(fn)()`, a deferred `BEGIN`. Its first statement reads `review_messages`, so the transaction holds a read snapshot; the following `INSERT` must upgrade it to a write lock. In WAL mode, when the daemon holds the write lock or has committed since that snapshot, SQLite returns `SQLITE_BUSY` at once for the upgrade instead of calling the busy handler, so the 5 s `busy_timeout` that `openDb` sets never applied. Under full-suite load the daemon was often mid-write, and the test failed.

The test now seeds through `tx` (`src/db/db.ts`), the `BEGIN IMMEDIATE` the daemon uses: the write lock is taken first, so a busy daemon is waited out by the busy timeout. No production change: the daemon's own writes already go through `tx`, and no other test opens a deferred transaction on a live daemon's database.
