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
export const CONTRACT_REVISIONS: RevisionMap = { claude: 2, pi: 1 };

export type RevisionMap = Readonly<Record<HarnessId, number>>;

/**
 * Revision 1 is the adapter behaviour when revisions were introduced, which
 * is what every pass, report, automatic attempt, flag and P1 from before
 * them proved: anything stored without a revision is at this baseline.
 */
export const BASELINE_REVISION = 1;

/** The daemon's revision for a harness; `revisions` replaces the constants in tests (a bump without editing them). */
export function contractRevision(harness: HarnessId, revisions: RevisionMap = CONTRACT_REVISIONS): number {
  return revisions[harness];
}

export function revisionLabel(revision: number): string {
  return `revision ${revision}`;
}

/** A revision read from stored JSON: a missing one (written before revisions) is the baseline. */
export function storedRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= BASELINE_REVISION ? value : BASELINE_REVISION;
}
