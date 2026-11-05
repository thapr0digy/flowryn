import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sha256Hex } from "../util/hash.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { docProblems } from "./brief.ts";

/**
 * A design stage's engineer build spec (docs/notes/2026-11-05-workers-get-rich-hx.md):
 * Markdown at `$FLOWRYN_REPORT_DIR/design/spec.md`, linked from the design
 * page. `stage done` checks its sections and pins it and the page by digest
 * on the gate, with the spec's text; a worker's `review reply` re-pins after a
 * revision; a pass is refused while either file differs from its pin. Later
 * stages read the gate's copy, never the file.
 */

export const DESIGN_SPEC = join("design", "spec.md");
export const DESIGN_SPEC_MAX_BYTES = 256 * 1024;

export interface DesignSpec {
  path: string;
  text: string;
  digest: string;
}

function specHint(path: string): string {
  return `write the build spec at ${path} ($FLOWRYN_BIN template spec prints its shape) and link it from the design page's folded detail`;
}

/**
 * The spec under the report directory, checked: a regular UTF-8 file inside
 * it (a symlink is refused, not followed), at most 256 KB, with every spec
 * section. Null when it is absent and not required.
 */
export function readDesignSpec(reportDir: string, opts: { required: boolean }): DesignSpec | null {
  const path = join(reportDir, DESIGN_SPEC);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    if (!opts.required) return null;
    throw new FlowrynError("spec_invalid", `no build spec at ${path}`, specHint(path));
  }
  if (st.isSymbolicLink()) throw new FlowrynError("spec_invalid", `${path} is a symlink; write the spec itself there`);
  if (!st.isFile()) throw new FlowrynError("spec_invalid", `${path} is not a regular file`);
  if (st.size > DESIGN_SPEC_MAX_BYTES) throw new FlowrynError("spec_invalid", `${path} is over ${DESIGN_SPEC_MAX_BYTES / 1024} KB; move detail out or tighten it`);
  const real = realpathSync(path);
  const rel = relative(realpathSync(reportDir), real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new FlowrynError("spec_invalid", `${path} resolves outside $FLOWRYN_REPORT_DIR`);
  const bytes = readFileSync(real);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FlowrynError("spec_invalid", `${path} is not valid UTF-8`);
  }
  const problems = docProblems("spec", text);
  if (problems.length > 0) throw new FlowrynError("spec_invalid", `${path}: ${problems.join("; ")}`, specHint(path));
  // The real path, as the review page's is (checkReviewPage), so the link check compares like with like.
  return { path: real, text: sanitizeBlock(text), digest: sha256Hex(bytes) };
}

/** The design page must link the spec by its path relative to the page, so the reviewer can open it. */
export function requireSpecLinked(page: string, spec: DesignSpec): void {
  const rel = relative(dirname(page), spec.path).split("\\").join("/");
  const html = readFileSync(page, "utf8");
  const linked = [rel, `./${rel}`].some((href) => html.includes(`href="${href}"`) || html.includes(`href='${href}'`));
  if (!linked) throw new FlowrynError("spec_invalid", `the design page does not link the build spec: add <a href="${rel}">the build spec</a> to its folded detail`);
}

function digestOf(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

/** Pin the spec and the page on the gate. Call inside a transaction. */
export function pinDesign(db: Db, gateId: string, page: string, spec: DesignSpec): void {
  db.query("UPDATE gates SET spec_path = ?2, spec_text = ?3, spec_digest = ?4, page_digest = ?5 WHERE id = ?1").run(gateId, spec.path, spec.text, spec.digest, digestOf(page));
}

export interface PinnedGate {
  id: string;
  run_id?: string;
  page_path?: string | null;
  /** The worker's page, when page_path is the daemon's copy of it (src/lavish/snapshot.ts). */
  source_page?: string | null;
  spec_path?: string | null;
  spec_digest?: string | null;
  page_digest?: string | null;
}

/**
 * After a worker's reply on an open design review: re-read the page and the
 * spec and pin what they show now, so the user approves what they last saw.
 * A spec that no longer passes refuses the reply. Nothing to do on a gate
 * without a pin. Call inside a transaction.
 */
export function repinDesign(db: Db, gate: PinnedGate, reportDir: string, taskId: string, now: number): boolean {
  if (!gate.spec_digest || !gate.page_path) return false;
  const spec = readDesignSpec(reportDir, { required: true })!;
  requireSpecLinked(gate.source_page ?? gate.page_path, spec);
  const page = digestOf(gate.page_path);
  if (spec.digest === gate.spec_digest && page === gate.page_digest) return false;
  pinDesign(db, gate.id, gate.page_path, spec);
  appendEvent(db, { source: "cli", kind: "gate.repinned", runId: gate.run_id ?? null, taskId, payload: { gate: gate.id, spec_digest: spec.digest, page_digest: page }, ts: now });
  return true;
}

/** Before a design review passes: the page and spec must still be the pinned ones. */
export function requireDesignPinned(run: { task_id: string }, gate: PinnedGate): void {
  if (!gate.spec_digest) return;
  const specNow = digestOf(gate.spec_path);
  const pageNow = digestOf(gate.page_path);
  if (specNow === gate.spec_digest && pageNow === gate.page_digest) return;
  const what = specNow !== gate.spec_digest ? (pageNow !== gate.page_digest ? "the design page and its build spec" : "the build spec") : "the design page";
  throw new FlowrynError(
    "design_changed",
    `${what} of gate ${gate.id} changed since the review last pinned it`,
    `the worker pins its revision by answering on the page ($FLOWRYN_BIN review reply), or send it back: flowryn gate changes ${run.task_id} --body-file -`,
  );
}

/** The spec a task's design review approved: the last passed gate with a pin, on any run of the task. */
export function approvedSpec(db: Db, taskId: string): { gate: string; text: string; digest: string; page: string | null } | null {
  const row = db
    .query(
      `SELECT g.id, g.spec_text, g.spec_digest, g.page_path FROM gates g JOIN runs r ON r.id = g.run_id
       WHERE r.task_id = ?1 AND g.kind = 'review' AND g.state = 'passed' AND g.spec_text IS NOT NULL ORDER BY g.closed_at DESC, g.id DESC LIMIT 1`,
    )
    .get(taskId) as { id: string; spec_text: string; spec_digest: string; page_path: string | null } | null;
  return row ? { gate: row.id, text: row.spec_text, digest: row.spec_digest, page: row.page_path } : null;
}
