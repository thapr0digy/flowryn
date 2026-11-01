# No "ahead" checkout_unsynced item for local-only projects

- Status: done

A local-only project lands by merging into its local default branch and never pushes, so after any landing its primary checkout is ahead of `origin` (when it has one). Upkeep's sync check opened a P1 `checkout_unsynced` item for that on every landing (found by notes-projects-non-8d, `2026-10-30-notes-projects-non-8d.md`). That was noise.

## Behaviour

- `recordSync` (`src/upkeep/sync.ts`): for a project whose `delivery_mode` is `local-only`, a sync skipped only because the checkout is `ahead` opens no item and logs nothing, and resolves any open `checkout_unsynced` item for the project ("local-only: ahead of origin is expected"), so an item raised before this change closes on the next upkeep pass.
- `syncPrimary` is unchanged: it still reports `ahead` and never moves the checkout.
- Unchanged: a local-only checkout that is dirty, diverged or refused by git still opens the item; direct-PR and no-mistakes projects ahead of origin still open it.

Plain rule, no model. Tests: `test/unit/upkeep-sync.test.ts` (local-only ahead with a leftover item, local-only dirty and diverged, direct-PR and no-mistakes ahead). No integration test covers `checkout_unsynced`, so none was added.
