import type { HarnessId } from "../harness/types.ts";

/**
 * The adapter/contract compatibility revision of each harness
 * (docs/notes/2026-10-12-next-steps-md-ez.md). A contract pass proves the
 * behaviour of the revision that ran it, and the harness gate accepts only a
 * pass at the running daemon's revision.
 *
 * Bump a harness's revision in the same PR as a change to behaviour its
 * contract suite proves: how its adapter launches or resumes a worker, the
 * hook or extension bridge the worker path uses, or one of its steps in
 * src/contracts/suite.ts. A docs, test or unrelated change never touches it,
 * so it never costs a new contract run. Never derive it from the build id.
 */
export const CONTRACT_REVISIONS: Readonly<Record<HarnessId, number>> = { claude: 1, pi: 1 };

/** The revision of a pass recorded before revisions existed: it proves no current revision. */
export const LEGACY_REVISION = 0;

export function contractRevision(harness: HarnessId): number {
  return CONTRACT_REVISIONS[harness];
}

/** "revision 1", or for a legacy pass "revision 0 (before revisions)". */
export function revisionLabel(revision: number): string {
  return revision === LEGACY_REVISION ? `revision ${revision} (before revisions)` : `revision ${revision}`;
}

/** A revision read from stored JSON: a missing or malformed one is legacy. */
export function storedRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : LEGACY_REVISION;
}
