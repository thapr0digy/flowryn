import { FlowrynError } from "../api/errors.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { createStandaloneDecision, type DecisionRow } from "../lifecycle/decisions.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { runBase, type RunWithPolicy } from "../lifecycle/runs.ts";
import type { GitRunner } from "./landed.ts";
import { findLoosenings, looseningLine, type Loosening } from "./loosening.ts";

/**
 * Countersigned gate loosening (docs/notes/2026-11-22-phase-countersign-gate-7e.md): a fix
 * (a run on the `fix` workflow, or a landing batch's fix-forward) whose diff loosens a gate
 * (src/policy/loosening.ts) merges only once a verifier proved the new number and the leader
 * countersigned it. The proof is the gate's own local green at this head (the batch's verify for
 * a batch member); the countersign is a standalone decision (origin COUNTERSIGN_ORIGIN, one per
 * task and head) the leader answers, reserved for the user on sensitive work. A new head needs a
 * fresh countersign. Until then the merge gate refuses `loosened_gate`, which the daemon's paths
 * hold as `held:loosened_gate` (auto-merge and the landing line) or as a held batch.
 */

export const COUNTERSIGN_ORIGIN = "countersign";
export const COUNTERSIGN = "countersign";
export const REFUSE = "refuse";
/** Loosenings a decision lists; the rest are counted. */
const SHOWN = 12;

/** What the merge gate read of a fix's diff: its loosenings, or why the diff could not be read. */
export interface LooseningFacts {
  base: string;
  found: Loosening[] | null;
  unread: string | null;
}

/** The batch a fix-forward task was opened for, with the head it started on; null for any other task. */
function fixForwardBase(db: Db, taskId: string): string | null {
  const row = db.query("SELECT fix_base FROM landing_batches WHERE fix_task = ?1 AND fix_base IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(taskId) as { fix_base: string } | null;
  return row?.fix_base ?? null;
}

/**
 * Read a fix's diff for loosened gates: a fix-forward's own commits past the batch head it started
 * on; a fix run's commits past its base branch (local, or origin's for a PR). Undefined for a run
 * that is not a fix: the rule does not apply.
 */
export async function readLoosening(db: Db, git: GitRunner, run: RunWithPolicy, project: ProjectRow, head: string, pr: boolean): Promise<LooseningFacts | undefined> {
  const fixBase = fixForwardBase(db, run.task_id);
  if (fixBase === null && run.workflow !== "fix") return undefined;
  if (head === "") return { base: fixBase ?? "-", found: null, unread: "its head could not be read" };
  const branch = runBase(run, project);
  // A PR's base is origin's branch; a checkout that never fetched it has only the local one.
  const remote = pr && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], project.path)).code === 0;
  const base = fixBase ?? (remote ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`);
  const range = fixBase ? [fixBase, head] : [`${base}...${head}`];
  const diff = await git(["diff", "--unified=0", "--no-renames", "--no-color", "--no-ext-diff", ...range, "--"], project.path);
  if (diff.code !== 0) return { base, found: null, unread: `git diff exited ${diff.code}: ${(diff.stderr || diff.stdout).trim().slice(0, 200) || "no output"}` };
  return { base, found: findLoosenings(diff.stdout), unread: null };
}

function decisionKey(taskId: string, head: string): string {
  return `${taskId}-${head.slice(0, 12)}`.toLowerCase().slice(0, 48);
}

/** The countersign decision of `task` at `head`, any state; null when none was asked. */
export function countersignOf(db: Db, taskId: string, head: string): DecisionRow | null {
  return db.query("SELECT * FROM decisions WHERE origin = ?1 AND key = ?2").get(COUNTERSIGN_ORIGIN, decisionKey(taskId, head)) as DecisionRow | null;
}

/** Whether `task` at `head` was countersigned. */
export function countersigned(db: Db, taskId: string, head: string): boolean {
  const d = countersignOf(db, taskId, head);
  return d?.state === "answered" && d.answer === COUNTERSIGN;
}

function decisionContext(l: LooseningFacts, head: string, proof: string | null): string {
  const lines = l.found === null ? [`Its diff could not be read (${l.unread}), so nothing shows it does not loosen a gate.`] : l.found.slice(0, SHOWN).map((f) => `- ${looseningLine(f)}`);
  const more = l.found && l.found.length > SHOWN ? [`- … and ${l.found.length - SHOWN} more`] : [];
  return [
    `The fix's diff (${l.base.slice(0, 40)}..${head.slice(0, 12)}) loosens a gate:`,
    ...lines,
    ...more,
    "",
    proof ? `Proof: verify ${proof} passed at this head with the new numbers.` : "Proof: no local verify (the project has no verify steps); only the merge gate's other checks passed at this head.",
    `${COUNTERSIGN}: it merges as it is. ${REFUSE}: it stays held; send it back (or drop it from its batch) to fix the code instead.`,
  ].join("\n");
}

/**
 * The merge gate's last step for a fix: nothing to do when it loosens no gate or was countersigned
 * at this head; otherwise the countersign decision opens (once, with a `merge.loosened_gate`
 * event naming the loosenings and the proof) and the merge is refused `loosened_gate`. Opens its
 * own transaction: the refusal that follows rolls nothing back.
 */
export function requireCountersign(db: Db, a: { run: RunWithPolicy; head: string; loosening: LooseningFacts | undefined; proof: string | null; now: number }): void {
  const l = a.loosening;
  if (!l || (l.found !== null && l.found.length === 0)) return;
  const task = a.run.task_id;
  const asked = countersignOf(db, task, a.head);
  if (asked?.state === "answered" && asked.answer === COUNTERSIGN) return;
  const what = l.found === null ? `its diff could not be read (${l.unread})` : l.found.slice(0, 3).map(looseningLine).join("; ") + (l.found.length > 3 ? ` (+${l.found.length - 3} more)` : "");
  if (asked?.state === "answered" || asked?.state === "dismissed") {
    throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate and ${asked.id} was ${asked.state === "dismissed" ? "dismissed" : `answered ${asked.answer}`}: ${what}`, `send it back to fix the code: flowryn steer ${task} --body-file -`);
  }
  const id =
    asked?.id ??
    tx(db, () => {
      const made = createStandaloneDecision(db, {
        key: decisionKey(task, a.head),
        question: `Countersign ${task}'s gate loosening at ${a.head.slice(0, 8)}?`,
        options: [COUNTERSIGN, REFUSE],
        recommendation: null,
        context: decisionContext(l, a.head, a.proof),
        origin: COUNTERSIGN_ORIGIN,
        reservedReason: a.run.sensitive ? "sensitive work: a gate loosening needs the user's countersign" : null,
        project: a.run.project_id,
        now: a.now,
      });
      if (made.created) {
        appendEvent(db, {
          source: "daemon",
          kind: "merge.loosened_gate",
          runId: a.run.id,
          taskId: task,
          payload: { task, head: a.head, base: l.base, decision: made.id, proof: a.proof, unread: l.unread, loosenings: (l.found ?? []).slice(0, SHOWN) },
          ts: a.now,
        });
      }
      return made.id;
    });
  throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate: ${what}; it waits for the leader's countersign (${id})`, `flowryn show ${id}; flowryn decide ${id} ${COUNTERSIGN} --rationale "<why the new number is right>" (a batch then lands; otherwise merge again: flowryn merge ${task}), or ${REFUSE}`);
}
