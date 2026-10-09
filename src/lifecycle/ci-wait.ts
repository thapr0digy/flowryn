import { openItem, resolveDecisionItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { GitRunner } from "../policy/landed.ts";
import { durationSeconds, waitsOnlyOnCi, type NmRun } from "../policy/nomistakes.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { nextRunDecisionId, type DecisionRow } from "./decisions.ts";
import { taskTitle, type RunRow } from "./runs.ts";

/**
 * The CI-wait watchdog (task pipeline-watchdog-and-pt, phase 1). A ship's
 * no-mistakes pipeline that waits in its `ci` step with no checks on its PR
 * waits up to no-mistakes' `ci_timeout` (a week here) and nobody is told.
 * After `[validation] ci_wait_alert` minutes the delivery watcher opens one
 * run-scoped decision reserved for the user (a `worker_question` item, so
 * the leader relays it the way it relays a worker's question): merge
 * origin/main and ship again, accept the ship without CI, or keep waiting.
 * The answer is carried out as one steer to the worker (keep-waiting sends
 * none and asks again after another alert period). Plain code: the status
 * flowrynd already reads, one GitHub read, git; no model.
 */

export const CI_WAIT_ORIGIN = "ci-wait";
export const CI_WAIT_OPTIONS = ["merge-main", "accept-without-ci", "keep-waiting"] as const;
export type CiWaitChoice = (typeof CI_WAIT_OPTIONS)[number];
export const CI_WAIT_RESERVED = "the user's call: a ship waiting on CI";
/** Answers that settle a stall for good: a later wait of the same pipeline run is not asked again. */
const SETTLING: readonly string[] = ["merge-main", "accept-without-ci"];

/** What the branch has of the default branch, read in the run's worktree; null fields when git could not tell. */
export interface BranchFacts {
  /** The default branch's `.no-mistakes.yaml` says `no_ci: true` and the branch's does not. */
  lacksNoCi: boolean | null;
  /** The branch already contains the default branch's tip: merging it changes nothing. */
  hasMain: boolean | null;
}

const NO_CI = /^no_ci:[ \t]*true[ \t]*(#.*)?$/m;

/** A top-level `no_ci: true` in a `.no-mistakes.yaml` (the file is flat; anything unreadable counts as absent). */
export function declaresNoCi(yaml: string | null): boolean {
  return yaml !== null && NO_CI.test(yaml);
}

/**
 * Minutes the pipeline has waited only on CI, or null when this read is not
 * a CI wait. no-mistakes' own clock (the `ci` step's `active_for`) survives a
 * flowrynd restart; when it is unreadable, the time flowrynd first saw this
 * pipeline run waiting (`ciSince`, kept in the run's nomistakes evidence).
 */
export function ciWaitMinutes(nm: NmRun, ciSince: number | null, now: number): number | null {
  if (!waitsOnlyOnCi(nm)) return null;
  const own = durationSeconds(nm.activeSteps!.find((s) => s.step === "ci")?.activeFor ?? "");
  const seconds = own > 0 ? own : ciSince !== null ? Math.max(0, (now - ciSince) / 1000) : 0;
  return Math.floor(seconds / 60);
}

/** The decision key prefix for one pipeline run: lowercase letters, digits and dashes, as decision keys must be. */
function stallPrefix(nmRunId: string): string {
  return `${nmRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}-`;
}

function stallDecisions(db: Db, runId: string, nmRunId: string): DecisionRow[] {
  return db
    .query("SELECT * FROM decisions WHERE origin = ?1 AND run_id = ?2 AND substr(key, 1, ?3) = ?4 ORDER BY created_at DESC, CAST(substr(id, 2) AS INTEGER) DESC")
    .all(CI_WAIT_ORIGIN, runId, stallPrefix(nmRunId).length, stallPrefix(nmRunId)) as DecisionRow[];
}

/**
 * Whether this wait should be asked about now. One decision per run per
 * stall: an open one waits for its answer; merge-main or accept-without-ci
 * settles this pipeline run for good (the next run, after the merge, is a new
 * stall); keep-waiting, or a decision closed unanswered, asks again once
 * another alert period has passed since.
 */
export function ciWaitDue(db: Db, runId: string, nmRunId: string, minutes: number, alertMin: number, now: number): boolean {
  if (alertMin <= 0 || minutes < alertMin) return false;
  const latest = stallDecisions(db, runId, nmRunId)[0];
  if (!latest) return true;
  if (latest.state === "open") return false;
  if (latest.state === "answered" && SETTLING.includes(latest.answer ?? "")) return false;
  return now - (latest.answered_at ?? latest.created_at ?? now) >= alertMin * 60_000;
}

/** Read what the branch has of the default branch. Never throws; a failed fetch still reads the last fetched tip. */
export async function readBranchFacts(git: GitRunner, worktree: string, defaultBranch: string): Promise<BranchFacts> {
  const main = `origin/${defaultBranch}`;
  await git(["fetch", "--quiet", "origin", defaultBranch], worktree).catch(() => null);
  const show = async (rev: string): Promise<string | null> => {
    const r = await git(["show", `${rev}:.no-mistakes.yaml`], worktree).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  };
  const tip = await git(["rev-parse", "--verify", "--quiet", `${main}^{commit}`], worktree).catch(() => null);
  if (!tip || tip.code !== 0) return { lacksNoCi: null, hasMain: null };
  const contains = await git(["merge-base", "--is-ancestor", main, "HEAD"], worktree).catch(() => null);
  const hasMain = contains === null || (contains.code !== 0 && contains.code !== 1) ? null : contains.code === 0;
  return { lacksNoCi: declaresNoCi(await show(main)) && !declaresNoCi(await show("HEAD")), hasMain };
}

export interface CiStall {
  nmRun: string;
  minutes: number;
  /** The PR no-mistakes names, or "" when it names none. */
  pr: string;
  defaultBranch: string;
}

/** The question, its recommendation and the item line. Exposed for tests. */
export function ciWaitText(title: string, project: string, stall: CiStall, facts: BranchFacts, alertMin: number): { question: string; recommend: CiWaitChoice; context: string } {
  const main = `origin/${stall.defaultBranch}`;
  const on = stall.pr ? `PR ${stall.pr}` : "its branch (no PR named yet)";
  const remarks: string[] = [];
  if (facts.lacksNoCi) remarks.push(`Its branch lacks ${stall.defaultBranch}'s \`no_ci: true\` (.no-mistakes.yaml), so its pipeline cannot count a PR with no checks as green; merging ${main} brings it.`);
  if (facts.hasMain && !facts.lacksNoCi) remarks.push(`Its branch already has ${main}: merging changes nothing.`);
  const recommend: CiWaitChoice = facts.hasMain && !facts.lacksNoCi ? "keep-waiting" : "merge-main";
  const question = [
    `${title} (${project}): its no-mistakes pipeline has waited ${stall.minutes} min in CI with no checks registered on ${on}.`,
    ...remarks,
    `merge-main: merge ${main} into the branch and ship again; accept-without-ci: end the CI wait and deliver without checks; keep-waiting: ask again in ${alertMin} min.`,
  ].join(" ");
  const context = `no-mistakes run ${stall.nmRun}, CI wait ${stall.minutes} min, ${on}`;
  return { question, recommend, context };
}

/** Open the stall's decision and its item. Call inside a transaction. Returns the decision id. */
export function openCiWait(db: Db, run: RunRow, project: string, stall: CiStall, facts: BranchFacts, alertMin: number, now: number): string {
  const title = taskTitle(db, run.task_id);
  const { question, recommend, context } = ciWaitText(title, project, stall, facts, alertMin);
  const id = nextRunDecisionId(db);
  const key = `${stallPrefix(stall.nmRun)}${stallDecisions(db, run.id, stall.nmRun).length + 1}`;
  db.query(
    `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, context, recommendation, reserved_reason, created_at, blocks)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).run(id, run.task_id, run.id, question, JSON.stringify(CI_WAIT_OPTIONS), CI_WAIT_ORIGIN, key, context, recommend, CI_WAIT_RESERVED, now, "the ship's CI wait");
  const event = appendEvent(db, {
    source: "nomistakes",
    kind: "decision.opened",
    runId: run.id,
    taskId: run.task_id,
    payload: { decision: id, origin: CI_WAIT_ORIGIN, key, nm_run: stall.nmRun, minutes: stall.minutes, pr: stall.pr || null, lacks_no_ci: facts.lacksNoCi, has_main: facts.hasMain, recommend },
    ts: now,
  });
  const lacks = facts.lacksNoCi ? `; branch lacks ${stall.defaultBranch}'s no_ci: true` : "";
  const item = openItem(db, {
    kind: "worker_question",
    eventSeq: event.seq,
    taskId: run.task_id,
    runId: run.id,
    line: `CI wait ${id} on ${sanitizeLine(title, 60)}: no checks for ${stall.minutes} min${lacks} [${CI_WAIT_OPTIONS.join(" | ")}] recommends ${recommend}; relay: flowryn decide ${id} <choice> --by captain`,
    now,
  });
  db.query("UPDATE items SET decision_id = ?2 WHERE id = ?1").run(item, id);
  return id;
}

/**
 * Close the run's open CI-wait decisions unanswered: the wait ended before
 * the user answered (CI started, the pipeline moved on or ended, the run left
 * validation). No steer: the worker never asked. Call inside a transaction.
 */
export function closeCiWaits(db: Db, run: Pick<RunRow, "id" | "task_id">, why: string, now: number, keepNmRun: string | null = null): string[] {
  const open = db.query("SELECT id, key FROM decisions WHERE origin = ?1 AND run_id = ?2 AND state = 'open'").all(CI_WAIT_ORIGIN, run.id) as { id: string; key: string }[];
  const closed: string[] = [];
  for (const d of open) {
    if (keepNmRun !== null && d.key.startsWith(stallPrefix(keepNmRun))) continue;
    db.query("UPDATE decisions SET state = 'dismissed', answered_at = ?2, answered_via = 'watchdog' WHERE id = ?1").run(d.id, now);
    appendEvent(db, { source: "nomistakes", kind: "decision.dismissed", runId: run.id, taskId: run.task_id, payload: { decision: d.id, origin: CI_WAIT_ORIGIN, why }, ts: now });
    resolveDecisionItems(db, d.id, `ci wait ended: ${why}`, now);
    closed.push(d.id);
  }
  return closed;
}

/** Open CI-wait decisions whose run is no longer running or validating. */
export function strandedCiWaits(db: Db): { id: string; task_id: string; state: string }[] {
  return db
    .query("SELECT DISTINCT r.id, r.task_id, r.state FROM decisions d JOIN runs r ON r.id = d.run_id WHERE d.origin = ?1 AND d.state = 'open' AND r.state NOT IN ('running', 'validating')")
    .all(CI_WAIT_ORIGIN) as { id: string; task_id: string; state: string }[];
}

/** The steer that carries out the user's answer; null for keep-waiting (the watchdog asks again later). */
export function ciWaitSteer(decisionId: string, choice: string, words: string | null): string | null {
  const said = words ? ` The user's words: "${sanitizeLine(words, 300)}"` : "";
  if (choice === "merge-main") {
    return (
      `The user chose merge-main for ${decisionId}: your no-mistakes pipeline waited in CI with no checks registered. ` +
      "Merge origin/main into your branch with a new commit (git fetch origin, then git merge origin/main; never rebase or force-push), run the tests, " +
      "then run the no-mistakes pipeline again so it pushes the merge. If it says a run is still active, end only that run's CI wait first: no-mistakes axi abort. " +
      `Then deliver as usual.${said}`
    );
  }
  if (choice === "accept-without-ci") {
    return (
      `The user accepted this ship without CI (${decisionId}). End only your pipeline's CI wait: no-mistakes axi abort. ` +
      `Make no other change; then git pull --ff-only (your HEAD must be the PR head) and $FLOWRYN_BIN deliver --pr <your PR url>.${said}`
    );
  }
  return null;
}

/** The run's latest accept-without-ci answer, for the merge prompt line; null when there is none. */
export function acceptedWithoutCi(db: Db, runId: string): string | null {
  const row = db
    .query("SELECT id FROM decisions WHERE origin = ?1 AND run_id = ?2 AND state = 'answered' AND answer = 'accept-without-ci' ORDER BY answered_at DESC LIMIT 1")
    .get(CI_WAIT_ORIGIN, runId) as { id: string } | null;
  return row?.id ?? null;
}
