import { FlowrynError } from "../api/errors.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { resolveDecisionItems } from "../attention/items.ts";
import { recordIntent } from "../journal/journal.ts";
import { createStandaloneDecision, reserveDecision, type DecisionRow } from "../lifecycle/decisions.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { runBase, type RunWithPolicy } from "../lifecycle/runs.ts";
import type { GitRunner } from "./landed.ts";
import { findLoosenings, looseningLine, type Loosening } from "./loosening.ts";

/**
 * Countersigned gate loosening (docs/notes/2026-11-22-phase-countersign-gate-7e.md): a fix
 * (a run on the `fix` workflow) whose diff loosens a gate
 * (src/policy/loosening.ts) merges only once a verifier proved the new number and the leader
 * countersigned it. The proof is the gate's own local green at this head (the batch's verify for
 * a batch member) or, with no verify steps, a PR whose GitHub checks are all green; with neither
 * no decision opens. The countersign is a standalone decision (origin COUNTERSIGN_ORIGIN, one per
 * task and head) the leader answers; on sensitive work only the user's answer counts. A new head
 * needs a fresh countersign. Until then the merge gate refuses `loosened_gate`, which the daemon's paths
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

/**
 * Read a fix run's diff for loosened gates: its commits past its base branch (local, or origin's
 * for a PR). Undefined for a run that is not a fix: the rule does not apply.
 */
export async function readLoosening(git: GitRunner, run: RunWithPolicy, project: ProjectRow, head: string, pr: boolean): Promise<LooseningFacts | undefined> {
  if (run.workflow !== "fix") return undefined;
  if (head === "") return { base: "-", found: null, unread: "its head could not be read" };
  const branch = runBase(run, project);
  // A PR's base is origin's branch; a checkout that never fetched it has only the local one.
  const remote = pr && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], project.path)).code === 0;
  const base = remote ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
  const diff = await git(["diff", "--unified=0", "--no-renames", "--no-color", "--no-ext-diff", `${base}...${head}`, "--"], project.path);
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

type CountersignRun = Pick<RunWithPolicy, "task_id" | "sensitive">;

/** Whether `d` countersigns: answered countersign, and on sensitive work by the user. */
function countersigns(d: DecisionRow | null, run: CountersignRun): boolean {
  return d?.state === "answered" && d.answer === COUNTERSIGN && (!run.sensitive || d.answered_by === "captain");
}

/** Whether `run`'s task at `head` was countersigned. */
export function countersigned(db: Db, run: CountersignRun, head: string): boolean {
  return countersigns(countersignOf(db, run.task_id, head), run);
}

/**
 * Dismiss `task`'s open countersign decisions but `keep`: their head was superseded or the fix
 * left. Each gets a `decision.dismissed` event, its items resolve and its backlog task closes.
 * Call inside a transaction.
 */
export function dismissCountersigns(db: Db, taskId: string, why: string, now: number, keep: string | null = null): string[] {
  const prefix = `${taskId}-`.toLowerCase();
  const open = db.query("SELECT id, task_id, key FROM decisions WHERE origin = ?1 AND state = 'open' AND run_id IS NULL").all(COUNTERSIGN_ORIGIN) as { id: string; task_id: string; key: string }[];
  const stale = open.filter((d) => d.id !== keep && d.key.startsWith(prefix) && /^[0-9a-f]+$/.test(d.key.slice(prefix.length)));
  for (const d of stale) {
    db.query("UPDATE decisions SET state = 'dismissed', answered_at = ?2, answered_via = 'daemon' WHERE id = ?1").run(d.id, now);
    appendEvent(db, { source: "daemon", kind: "decision.dismissed", taskId: d.task_id, payload: { decision: d.id, origin: COUNTERSIGN_ORIGIN, task: taskId, why }, ts: now });
    resolveDecisionItems(db, d.id, `countersign dismissed: ${why}`, now);
    recordIntent(db, { file: "backlog", verb: "unhold", taskId: d.task_id, positional: [d.task_id], now });
    recordIntent(db, { file: "backlog", verb: "done", taskId: d.task_id, positional: [d.task_id], now });
  }
  return stale.map((d) => d.id);
}

function decisionContext(l: LooseningFacts, head: string, proof: string): string {
  const lines = l.found === null ? [`Its diff could not be read (${l.unread}), so nothing shows it does not loosen a gate.`] : l.found.slice(0, SHOWN).map((f) => `- ${looseningLine(f)}`);
  const more = l.found && l.found.length > SHOWN ? [`- … and ${l.found.length - SHOWN} more`] : [];
  return [
    `The fix's diff (${l.base.slice(0, 40)}..${head.slice(0, 12)}) loosens a gate:`,
    ...lines,
    ...more,
    "",
    `Proof: ${proof} passed at this head with the new numbers.`,
    `${COUNTERSIGN}: it merges as it is. ${REFUSE}: it stays held; send it back (or drop it from its batch) to fix the code instead.`,
  ].join("\n");
}

/**
 * The merge gate's last step for a fix: nothing to do when it loosens no gate or was countersigned
 * at this head with a verifier's proof (`proof`: what proved it, null when nothing did). Without
 * a proof the merge is refused `loosened_gate` and no decision opens. Otherwise the countersign
 * decision opens (once, with a `merge.loosened_gate` event naming the loosenings and the proof,
 * dismissing the task's countersigns at older heads) and the merge is refused `loosened_gate`.
 * Opens its own transaction: the refusal that follows rolls nothing back.
 */
export function requireCountersign(db: Db, a: { run: RunWithPolicy; head: string; loosening: LooseningFacts | undefined; proof: string | null; now: number }): void {
  const l = a.loosening;
  if (!l || (l.found !== null && l.found.length === 0)) return;
  const task = a.run.task_id;
  const what = l.found === null ? `its diff could not be read (${l.unread})` : l.found.slice(0, 3).map(looseningLine).join("; ") + (l.found.length > 3 ? ` (+${l.found.length - 3} more)` : "");
  const sendBack = `flowryn steer ${task} --body-file -`;
  const proof = a.proof;
  if (proof === null) {
    throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate and no verifier proved the new number: add verify steps or send it back: ${what}`, `add [projects.${a.run.project_id}] verify steps to config.toml and verify this head (flowryn verify ${task}), or send it back: ${sendBack}`);
  }
  const asked = countersignOf(db, task, a.head);
  if (countersigns(asked, a.run)) return;
  if (asked?.state === "answered" && asked.answer === COUNTERSIGN) {
    throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate and ${asked.id} was countersigned by the ${asked.answered_by ?? "leader"}, but sensitive work needs the user's countersign: ${what}`, `send it back for a new head the user countersigns: ${sendBack}`);
  }
  if (asked?.state === "answered" || asked?.state === "dismissed") {
    throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate and ${asked.id} was ${asked.state === "dismissed" ? "dismissed" : `answered ${asked.answer}`}: ${what}`, `send it back to fix the code: ${sendBack}`);
  }
  const reserved = a.run.sensitive ? "sensitive work: a gate loosening needs the user's countersign" : null;
  const id = tx(db, () => {
    if (asked) {
      if (reserved) reserveDecision(db, asked, reserved, a.now);
      return asked.id;
    }
    const made = createStandaloneDecision(db, {
      key: decisionKey(task, a.head),
      question: `Countersign ${task}'s gate loosening at ${a.head.slice(0, 8)}?`,
      options: [COUNTERSIGN, REFUSE],
      recommendation: null,
      context: decisionContext(l, a.head, proof),
      origin: COUNTERSIGN_ORIGIN,
      reservedReason: reserved,
      project: a.run.project_id,
      now: a.now,
    });
    if (made.created) {
      dismissCountersigns(db, task, `superseded by ${made.id} at ${a.head.slice(0, 8)}`, a.now, made.id);
      appendEvent(db, {
        source: "daemon",
        kind: "merge.loosened_gate",
        runId: a.run.id,
        taskId: task,
        payload: { task, head: a.head, base: l.base, decision: made.id, proof, unread: l.unread, loosenings: (l.found ?? []).slice(0, SHOWN) },
        ts: a.now,
      });
    }
    return made.id;
  });
  throw new FlowrynError("loosened_gate", `merge refused: ${task}'s fix loosens a gate: ${what}; it waits for the leader's countersign (${id})`, `flowryn show ${id}; flowryn decide ${id} ${COUNTERSIGN} --rationale "<why the new number is right>" (a batch then lands; otherwise merge again: flowryn merge ${task}), or ${REFUSE}`);
}
