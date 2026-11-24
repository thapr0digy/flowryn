/**
 * The migration-number clash check of a landing batch (docs/notes/2026-11-21-landing-batches-one-27.md):
 * two members adding the same numbered migration merge cleanly and fail the verify, so the later
 * one goes back to renumber before the batch is built. Plain code.
 */

/** A file added in a migrations directory whose name starts with a number: `db/migrations/000123_add_x.up.sql`. */
const MIGRATION = /^(.*migration[^/]*\/(?:.*\/)?)(\d+)[_-][^/]*$/i;

export interface NumberClash {
  /** The member that takes the number second, in batch order: it renumbers. */
  task: string;
  path: string;
  /** The member ahead of it with the same number in the same directory. */
  with: string;
  withPath: string;
}

/**
 * Two members that both add a numbered file in the same migrations directory with the same
 * number: a clean merge, and a failing verify. `added` is in batch order; the later one clashes.
 * Narrow on purpose: only a directory whose path says "migration", so date-prefixed notes never clash.
 */
export function numberClashes(added: readonly { task: string; files: readonly string[] }[]): NumberClash[] {
  const taken = new Map<string, { task: string; path: string }>();
  const clashes: NumberClash[] = [];
  for (const member of added) {
    const mine = new Map<string, string>();
    for (const path of member.files) {
      const m = MIGRATION.exec(path);
      if (!m) continue;
      const key = `${m[1]}\u0000${Number(m[2])}`;
      const other = taken.get(key);
      if (other && other.task !== member.task) {
        clashes.push({ task: member.task, path, with: other.task, withPath: other.path });
        break;
      }
      if (!mine.has(key)) mine.set(key, path);
    }
    if (clashes.at(-1)?.task === member.task) continue;
    for (const [key, path] of mine) taken.set(key, { task: member.task, path });
  }
  return clashes;
}
