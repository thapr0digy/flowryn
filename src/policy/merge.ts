import { FlowrynError } from "../api/errors.ts";
import type { Caller } from "../api/verbs.ts";
import { hashToken } from "../api/auth.ts";
import { openItem, findOpenRunItem } from "../attention/items.ts";
import type { GitHubConfig } from "../config/delivery.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { canonicalPrUrl, parsePrUrl } from "../forge/github.ts";
import { checksLine, ForgeError, type ChecksSummary, type Forge, type PrRef, type PullRequest } from "../forge/types.ts";
import { getSession, leaseOfSession } from "../lease/lease.ts";
import { approvalRef, deliveredOf, prEvidenceFrom, recordPrEvidence, remoteHead, type Delivered } from "../lifecycle/delivery.ts";
import { landRun, type LandedBy } from "../lifecycle/landing.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { isTerminal, runBase, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import {
  consumeApproval,
  findAttempt,
  findHumanApproval,
  insertApproval,
  matchAttempt,
  staleApprovals,
  type ApprovalRow,
  type AttemptRow,
  type Channel,
} from "./approvals.ts";
import type { GitRunner } from "./landed.ts";
import { noteMergedAfterEnd } from "../reconcile/delivery.ts";
import { isForgeOutage, noteForgeDown, noteForgeUp } from "../reconcile/forge-health.ts";
import { shellWord } from "../util/shell-word.ts";
import { grantActor, takeGrant, voidItemGrants } from "./grants.ts";
import { shortPolicy } from "../verify/policy.ts";
import { finishedAtHead, finishedAtHeadUnderOther, lastPassed, type Verification } from "../verify/store.ts";

/**
 * The merge gate (design section 7, policy/merge), in order: the canonical PR
 * for the task at its delivered head; not a draft, and the head on the
 * remote; every check green, or exactly one waived by a human; an approval
 * record or the yolo posture; sensitive work only with a human record. Else
 * a refusal with a code. The merge is then asked of GitHub at exactly the
 * approved head, and it is landed only when the PR reads merged with a merge
 * commit; otherwise it is unproven, the task is not landed, and a P1 says so.
 * A local-only ship's gate is the same with its branch head in place of the
 * PR: a fast-forward of the project's default branch, proven when the head
 * is on it.
 *
 * A project with verify steps merges only on local green: the newest
 * finished `flowryn verify` of exactly this head, under today's verify
 * policy, passed (docs/notes/2026-10-15-merge-gate-require-bf.md), whatever
 * GitHub's checks say. Red checks GitHub never started (its Actions billing
 * or spending limit: the check run fails with an annotation saying the job
 * was not started) are covered by that same pass. A check that ran and
 * failed is never covered by it; only a human's one-check waiver passes it.
 */

export interface MergeContext {
  db: Db;
  forge: Forge;
  git: GitRunner;
  github: GitHubConfig;
  now(): number;
  /** The project's verify policy identity under today's config, or null when it has no verify steps (src/verify/policy.ts). */
  verifyPolicy(projectId: string): string | null;
}

export interface MergeFacts {
  run: RunWithPolicy;
  project: ProjectRow;
  delivered: Delivered;
  /** What approvals bind to: the canonical PR URL, or local:<branch>. */
  ref: string;
  /** The head the merge would land: the PR head now, or the worktree HEAD now. */
  head: string;
  title: string;
  pr: PullRequest | null;
  checks: ChecksSummary | null;
  remote: string | null;
  primaryBranch: string | null;
  primaryDirty: boolean;
  fastForward: boolean;
  /** Read when the project has verify steps, or when every red check may be one GitHub never started; absent: no verify is required. */
  local?: LocalEvidence;
}

/** The local verifications of this head the gate requires, and the red checks GitHub never ran that they cover. */
export interface LocalEvidence {
  /** The check run ids GitHub never started (empty when none). */
  notStarted: number[];
  /** Today's verify policy identity of the project, or null when it has no verify steps. */
  policy: string | null;
  /** The newest finished verification of this PR at exactly this head under today's policy. */
  atHead: Verification | null;
  /** The newest finished verification at this head under another policy or none recorded: it covers nothing, it only names re-verification. */
  otherPolicyAtHead: Verification | null;
  /** The newest passing verification of this PR at any head. */
  lastPassed: Verification | null;
}

/** GitHub's own words on a job it never started: Actions billing, a spending limit, a locked account. */
export const NOT_STARTED_ANNOTATION = /^The job was not started because/;

/**
 * The ids of the red check runs GitHub never started: a github-actions check
 * run that failed with a failure annotation in GitHub's not-started words.
 * Asked only when every red check could be one; otherwise none (fails closed).
 */
export async function notStartedChecks(forge: Forge, ref: PrRef, checks: ChecksSummary): Promise<number[]> {
  const red = checks.checks.filter((c) => c.state === "red");
  if (red.length === 0 || !red.every((c) => c.app === "github-actions" && c.detail === "failure" && c.id !== undefined && (c.annotations ?? 0) > 0)) return [];
  const ids: number[] = [];
  for (const check of red) {
    const annotations = await forge.annotations(ref, check.id!);
    if (annotations.some((a) => a.level === "failure" && NOT_STARTED_ANNOTATION.test(a.message))) ids.push(check.id!);
  }
  return ids;
}

async function out(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  const r = await git(args, cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** GitHub could not be asked while a merge waits on it: the outage's P1 (design section 16), in its own transaction, since the refusal that follows rolls nothing back. */
function noteMergeBlocked(mc: MergeContext, error: unknown): void {
  if (isForgeOutage(error)) tx(mc.db, () => noteForgeDown(mc.db, error, "github", mc.now()));
}

/** Everything the gate looks at, read now from the systems of record (GitHub, git). */
export async function gatherFacts(mc: MergeContext, run: RunWithPolicy, project: ProjectRow): Promise<MergeFacts> {
  const delivered = deliveredOf(mc.db, run.task_id);
  if (!delivered) throw new FlowrynError("not_ready", `${run.task_id} has delivered nothing to merge (the run is ${run.state})`, `flowryn show ${run.task_id}`);
  const title = taskTitle(mc.db, run.task_id);
  const base = { run, project, delivered, ref: approvalRef(delivered), title, pr: null, checks: null, remote: null, primaryBranch: null, primaryDirty: false, fastForward: false };
  if (delivered.kind === "pr") {
    const ref = parsePrUrl(delivered.ref, mc.github.web_url);
    if (!ref) throw new FlowrynError("not_ready", `the delivered PR ${delivered.ref} is not a pull request URL`);
    let pr: PullRequest;
    try {
      pr = await mc.forge.pull(ref);
    } catch (error) {
      noteMergeBlocked(mc, error);
      throw new FlowrynError("forge_unavailable", `cannot read ${delivered.ref} from GitHub (${(error as Error).message}); a merge that cannot be proven is not attempted`, "try again later");
    }
    let checks: ChecksSummary | null = null;
    if (pr.state === "open") {
      try {
        checks = await mc.forge.checks(ref, pr.headSha);
      } catch (error) {
        noteMergeBlocked(mc, error);
        throw new FlowrynError("forge_unavailable", `cannot read the checks of ${delivered.ref} (${(error as Error).message})`, "try again later");
      }
    }
    let notStarted: number[] = [];
    let annotationsUnread = false;
    if (checks && checks.state === "red") {
      try {
        notStarted = await notStartedChecks(mc.forge, ref, checks);
      } catch (error) {
        noteMergeBlocked(mc, error);
        annotationsUnread = true;
      }
    }
    if (!annotationsUnread) tx(mc.db, () => noteForgeUp(mc.db, "github", mc.now()));
    const local = localEvidence(mc, project.id, canonicalPrUrl(ref, mc.github.web_url), pr.headSha, notStarted);
    const remote = pr.state === "open" ? await remoteHead(mc.git, run.worktree_path, pr.headRef) : null;
    return { ...base, head: pr.headSha, pr, checks, remote, ...(local ? { local } : {}) };
  }
  const head = (await out(mc.git, run.worktree_path, ["rev-parse", "HEAD"])) ?? "";
  const primaryBranch = await out(mc.git, project.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = await out(mc.git, project.path, ["status", "--porcelain", "--untracked-files=no"]);
  const fastForward = head !== "" && (await mc.git(["merge-base", "--is-ancestor", `refs/heads/${project.default_branch}`, head], project.path)).code === 0;
  const local = localEvidence(mc, project.id, base.ref, head, []);
  return { ...base, head, primaryBranch, primaryDirty: status === null || status.length > 0, fastForward, ...(local ? { local } : {}) };
}

/**
 * The local verifications of `ref` (a canonical PR URL, or local:<branch>) at
 * `head`: read when the project has verify steps today (they are required),
 * or when red checks GitHub never started want covering; otherwise none.
 */
function localEvidence(mc: MergeContext, projectId: string, ref: string, head: string, notStarted: number[]): LocalEvidence | null {
  const policy = mc.verifyPolicy(projectId);
  if (policy === null && notStarted.length === 0) return null;
  const atHead = policy === null ? null : finishedAtHead(mc.db, ref, head, policy);
  return { notStarted, policy, atHead, otherPolicyAtHead: atHead ? null : finishedAtHeadUnderOther(mc.db, ref, head, policy), lastPassed: lastPassed(mc.db, ref) };
}

export type ApprovalChoice =
  | { kind: "row"; row: ApprovalRow }
  | { kind: "attempt"; attempt: AttemptRow; session: string }
  | { kind: "key"; session: string; allowRed: string | null }
  /** Your chat answer (docs/notes/2026-10-10-chat-answers-authorise-5g.md), already checked against Claude's transcript; never a waiver. */
  | { kind: "grant"; grant: string; session: string }
  | { kind: "yolo" };

/**
 * The daemon's own merge (the yolo auto-merge, src/verify/auto-merge.ts): it
 * brings no harness channel, so only a standing human record or the yolo
 * posture can allow it. Never a token's role: nothing outside the daemon
 * process can be it.
 */
export interface DaemonCaller {
  role: "daemon";
}

export const DAEMON_CALLER: DaemonCaller = { role: "daemon" };

export type MergeCaller = Caller | DaemonCaller;

export interface MergeAsk {
  caller: MergeCaller;
  /** The Pi extension's approval key, read from stdin (never from an environment). */
  approvalKey?: string;
  /** The head the Pi confirm showed you. */
  head?: string;
  /** `merge --allow-red`: the one red check this merge asks to waive. */
  allowRed?: string;
  /** A chat-answer grant the merge's prepare step found for this task at this head. */
  grant?: string | null;
}

export interface ChoiceResult {
  choice: ApprovalChoice | null;
  /** Why no approval applies, for the refusal. */
  why: string;
  /** The red check the merge asked to waive (`merge --allow-red`), if any. */
  allowRed?: string | null;
}

/**
 * Which approval allows this merge. A standing human record for this head
 * comes first (it can carry a waiver); then the harness channel the caller
 * brought (Claude's prompt, Pi's confirm); then the yolo posture. A merge
 * that asks to waive a red check takes only a record waiving that check, a
 * Claude prompt that named it, or a Pi confirm that showed it; never yolo.
 */
export function chooseApproval(db: Db, facts: MergeFacts, ask: MergeAsk, action: "merge" | "discard", now: number): ChoiceResult {
  const chosen = chooseFor(db, facts, ask, action, now);
  return ask.allowRed === undefined ? chosen : { ...chosen, allowRed: ask.allowRed };
}

function chooseFor(db: Db, facts: MergeFacts, ask: MergeAsk, action: "merge" | "discard", now: number): ChoiceResult {
  const task = facts.run.task_id;
  const allowRed = ask.allowRed ?? null;
  const row = findHumanApproval(db, { task, action, ref: facts.ref, head: facts.head, now, allowRed });
  if (row) return { choice: { kind: "row", row }, why: "" };
  const reasons: string[] = [];
  // A head you confirmed is a precondition: another head is never merged in its place, not even under yolo.
  if (ask.head && ask.head !== facts.head) return { choice: null, why: `the head moved from ${ask.head.slice(0, 8)} since you confirmed; it is now ${facts.head.slice(0, 8)}` };
  const session = ask.caller.role === "leader" ? (ask.caller.session ?? null) : null;
  const leader = session ? getSession(db, session) : null;
  if (leader?.harness === "claude") {
    const attempt = findAttempt(db, { session: leader.session_id, action, task, now, allowRed });
    if (attempt && (!attempt.head_sha || attempt.head_sha === facts.head)) return { choice: { kind: "attempt", attempt, session: leader.session_id }, why: "" };
    if (attempt) return { choice: null, why: `the head moved from ${attempt.head_sha?.slice(0, 8)} since your prompt; it is now ${facts.head.slice(0, 8)}` };
    if (ask.grant && allowRed === null) return { choice: { kind: "grant", grant: ask.grant, session: leader.session_id }, why: "" };
    reasons.push(
      allowRed === null
        ? "no confirmed Claude prompt for this command (under bypassPermissions there is none to trust)"
        : `no confirmed Claude prompt waiving ${JSON.stringify(allowRed)} for this command (under bypassPermissions there is none to trust)`,
    );
  }
  if (leader?.harness === "pi") {
    const lease = leaseOfSession(db, leader.session_id);
    if (!ask.approvalKey) reasons.push("no approval key: merge through the flowryn_merge tool, which asks you first");
    else if (!lease || lease.session_id !== leader.session_id || !lease.approval_key_hash || hashToken(ask.approvalKey) !== lease.approval_key_hash) reasons.push("the approval key is not this lease's");
    else return { choice: { kind: "key", session: leader.session_id, allowRed }, why: "" };
  }
  if (allowRed !== null) reasons.push(`waiving ${JSON.stringify(allowRed)} needs your word; yolo never waives a check`);
  const policy = db.query("SELECT yolo FROM task_policy WHERE task_id = ?1").get(task) as { yolo: number } | null;
  if (action === "merge" && allowRed === null && policy?.yolo === 1) return { choice: { kind: "yolo" }, why: "" };
  const stale = staleApprovals(db, { task, action, head: facts.head, now });
  if (stale.length > 0) reasons.unshift(`your approval ${stale[0]!.id} was for head ${stale[0]!.head_sha.slice(0, 8)}; the head is now ${facts.head.slice(0, 8)}`);
  return { choice: null, why: reasons.join("; ") || `no approval for head ${facts.head.slice(0, 8)}` };
}

export interface GateResult {
  /** The one red check a human waived, if any. */
  waived: string | null;
  /** The PR already reads merged: nothing to ask of GitHub, only the landing to record. */
  alreadyMerged: boolean;
  /** The passing verification that stood in for checks GitHub never started, if any. */
  localGreen: string | null;
}

/** The red check an approval waives: a human record's, a Claude prompt's or a Pi confirm's; yolo never waives. */
export function waiverOf(choice: ApprovalChoice | null): string | null {
  if (!choice) return null;
  if (choice.kind === "row") return choice.row.allow_red_check;
  if (choice.kind === "attempt") return choice.attempt.allow_red_check;
  if (choice.kind === "key") return choice.allowRed;
  return null;
}

/** How to waive one red check: through the leader (it asks you) or in your shell. */
function waiveHint(task: string, check: string): string {
  const word = shellWord(check);
  return `fix it, or waive it: the leader runs flowryn merge ${task} --allow-red ${word} and asks you, or in your shell: flowryn approve ${task} --allow-red ${word}`;
}

/**
 * Local green: the newest finished verify of exactly this head under today's
 * verify policy passed. Returns its id, or throws why not: it failed at this
 * head (verify_failed), it ran here under another policy or none recorded
 * (verify_stale), it passed at an older head (head_moved), or there is none
 * (verify_required). `ci` opens the message with what GitHub's checks say.
 * With no verify steps today it is asked only to cover checks GitHub never
 * started, and a missing verify stays red_checks.
 */
function localGreenOf(facts: MergeFacts, ci: string): string {
  const task = facts.run.task_id;
  const local = facts.local!;
  const head = facts.head.slice(0, 8);
  const at = local.atHead;
  if (at?.state === "passed") return at.id;
  if (at) throw new FlowrynError("verify_failed", `${ci}, and the local verify ${at.id} at this head ${at.state}: ${at.detail ?? "no detail"}`, `flowryn verify show ${at.id}; once fixed: flowryn verify ${task}`);
  const other = local.otherPolicyAtHead;
  if (other) {
    const project = facts.project.id;
    const why =
      local.policy === null
        ? `and project ${project} has no verify steps now`
        : other.policy_id === null
          ? "before Flowryn recorded its verify policy"
          : `under another verify policy (${shortPolicy(other.policy_id)}, today's is ${shortPolicy(local.policy)}: the [projects.${project}] verify steps or verify_binary changed since)`;
    throw new FlowrynError(
      "verify_stale",
      `${ci}; the local verify ${other.id} (${other.state}) at this head ran ${why}, so it does not cover today's verify policy`,
      local.policy === null ? `add [projects.${project}] verify steps to config.toml, then re-verify this head: flowryn verify ${task}` : `re-verify this head under today's steps: flowryn verify ${task}`,
    );
  }
  if (local.lastPassed) {
    throw new FlowrynError("head_moved", `${ci}; the local verify ${local.lastPassed.id} passed at ${local.lastPassed.head_sha.slice(0, 8)}, but the head is now ${head}`, `verify this head: flowryn verify ${task}`);
  }
  if (local.policy === null) throw new FlowrynError("red_checks", `${ci}, and no local verify passed at this head`, `verify it locally, then merge again: flowryn verify ${task}`);
  throw new FlowrynError("verify_required", `${ci}, and no local verify of this head has finished`, `verify it locally, then merge again: flowryn verify ${task}`);
}

/** What GitHub's checks say, to open a local-green refusal. */
function ciNote(facts: MergeFacts, notStarted: string[]): string {
  const head = facts.head.slice(0, 8);
  if (notStarted.length > 0) return `merge refused: CI never started at ${head} (GitHub did not run ${notStarted.map((name) => JSON.stringify(name)).join(", ")})`;
  const required = `merge refused: project ${facts.project.id} merges only on a passing flowryn verify of exactly the head`;
  if (!facts.pr) return `${required} (local-only work at ${head} has no CI)`;
  const checks = facts.checks;
  return `${required} (${!checks || checks.state === "none" ? "the PR has no checks" : `checks: ${checksLine(checks)}`} at ${head})`;
}

/** The gate, in the design's order; throws the first refusal. */
export function checkGate(facts: MergeFacts, chosen: ChoiceResult): GateResult {
  const { run, delivered, pr, project } = facts;
  const task = run.task_id;
  // 1 · the canonical PR for the task, at the head that was delivered.
  if (pr) {
    if (pr.state === "merged") return { waived: null, alreadyMerged: true, localGreen: null };
    if (pr.state === "closed") throw new FlowrynError("pr_closed", `${delivered.ref} was closed without being merged`, `flowryn show ${task}`);
  }
  if (facts.head !== delivered.head) {
    throw new FlowrynError("head_moved", `the head moved from ${delivered.head.slice(0, 8)} (delivered) to ${facts.head.slice(0, 8)}; the worker must deliver again`, `flowryn steer ${task} --body-file -`);
  }
  // 2 · not a draft, and the head on the remote (local-only: a clean fast-forward of the default branch).
  if (pr) {
    if (pr.draft) throw new FlowrynError("pr_draft", `${delivered.ref} is a draft`);
    const base = runBase(run, project);
    if (pr.baseRef !== base) throw new FlowrynError("base_mismatch", `merge refused: ${delivered.ref} targets ${pr.baseRef}, not its base ${base}`, `retarget it to ${base}, or flowryn decline ${task}`);
    if (facts.remote !== pr.headSha) throw new FlowrynError("head_not_on_remote", `the remote has ${facts.remote?.slice(0, 8) ?? "nothing"} for ${pr.headRef}, not the PR head ${pr.headSha.slice(0, 8)}`);
  } else {
    if (facts.primaryBranch !== project.default_branch) {
      throw new FlowrynError("primary_checkout_tangle", `${project.path} is on ${facts.primaryBranch ?? "a detached HEAD"}, not ${project.default_branch}; a local merge lands there`, `check out ${project.default_branch} there first`);
    }
    if (facts.primaryDirty) throw new FlowrynError("primary_checkout_tangle", `${project.path} has uncommitted changes to tracked files; refusing to merge into it`);
    if (!facts.fastForward) {
      throw new FlowrynError("not_fast_forward", `${run.branch} is not a fast-forward of ${project.default_branch} (it has diverged)`, `steer the worker to rebase onto ${project.default_branch} and deliver again`);
    }
  }
  // 3 · every check green or exactly one red check waived by a human; local green when the project has verify steps (it also covers checks GitHub never started).
  let waived: string | null = null;
  let localGreen: string | null = null;
  const checks = facts.checks;
  const asked = chosen.allowRed ?? null;
  const redRuns = checks ? checks.checks.filter((c) => c.state === "red") : [];
  const red = redRuns.map((c) => c.name);
  // A merge that names a check to waive goes ahead only when that check is the one failing now.
  if (asked !== null && !(red.length === 1 && red[0] === asked)) {
    const failing = red.length > 0 ? `failing now: ${red.map((name) => JSON.stringify(name)).join(", ")}` : checks ? "no check is failing" : "there are no checks to waive";
    throw new FlowrynError(
      "red_checks",
      `merge refused: the waiver names ${JSON.stringify(asked)}, but ${failing}; one check may be waived, and only while it is the only one failing`,
      red.length === 1 ? waiveHint(task, red[0]!) : red.length === 0 ? `merge without --allow-red: flowryn merge ${task}` : "fix them; at most one check can be waived",
    );
  }
  if (asked !== null && !chosen.choice) {
    throw new FlowrynError("approval_required", `merge refused: ${chosen.why}`, `approve in your shell: flowryn approve ${task} --allow-red ${shellWord(asked)}`);
  }
  // A red check is passed only by the one waiver or, if GitHub never started it, by local green; one that ran and failed never by local green.
  let notStarted: string[] = [];
  if (red.length > 0) {
    const waiver = waiverOf(chosen.choice);
    if (red.length === 1 && waiver === red[0]) waived = red[0]!;
    else if (facts.local && redRuns.every((c) => c.id !== undefined && facts.local!.notStarted.includes(c.id))) notStarted = red;
    else {
      throw new FlowrynError(
        "red_checks",
        `merge refused: ${red.length} red check${red.length === 1 ? "" : "s"}: ${red.join(", ")}${waiver ? ` (your waiver names ${waiver}, and only one may be waived)` : ""}`,
        red.length === 1 ? waiveHint(task, red[0]!) : "fix them; at most one check can be waived",
      );
    }
  }
  // Local green: required whenever the project has verify steps; without them, only to cover checks GitHub never started.
  if (facts.local && (facts.local.policy !== null || notStarted.length > 0)) localGreen = localGreenOf(facts, ciNote(facts, notStarted));
  const pending = checks ? checks.checks.filter((c) => c.state === "pending").map((c) => c.name) : [];
  if (pending.length > 0) throw new FlowrynError("checks_pending", `merge refused: checks still running: ${pending.join(", ")}`, `flowryn show ${task}`);
  // 4 · an approval record or yolo.
  if (!chosen.choice) {
    throw new FlowrynError("approval_required", `merge refused: ${chosen.why}`, `approve in your shell: flowryn approve ${task}`);
  }
  // 5 · sensitive work needs a human record even under yolo.
  if (run.sensitive && chosen.choice.kind === "yolo") {
    throw new FlowrynError("approval_required", "merge refused: sensitive work needs a human approval even under yolo", `approve in your shell: flowryn approve ${task}`);
  }
  return { waived, alreadyMerged: false, localGreen };
}

export function channelOf(choice: ApprovalChoice): Channel {
  return choice.kind === "row" ? choice.row.channel : choice.kind === "attempt" ? "claude-ask" : choice.kind === "key" ? "pi-confirm" : choice.kind === "grant" ? "claude-chat" : "yolo";
}

function user(): string {
  return process.env.USER || process.env.LOGNAME || "you";
}

/** Use up the approval that allowed the merge, and return its id. Call inside a transaction. */
export function takeApproval(db: Db, facts: MergeFacts, choice: ApprovalChoice, action: "merge" | "discard", now: number): string {
  const task = facts.run.task_id;
  if (choice.kind === "row") {
    const fresh = db.query("SELECT consumed_at FROM approvals WHERE id = ?1").get(choice.row.id) as { consumed_at: number | null } | null;
    if (!fresh || fresh.consumed_at !== null) throw new FlowrynError("approval_required", `approval ${choice.row.id} was just used by another merge`);
    consumeApproval(db, choice.row.id, now, `${action} ${task}`);
    if (action === "merge") voidItemGrants(db, `merge:${task}`, "a standing approval approved it", now);
    return choice.row.id;
  }
  if (choice.kind === "attempt") {
    const fresh = db.query("SELECT matched_at FROM approval_attempts WHERE id = ?1").get(choice.attempt.id) as { matched_at: number | null } | null;
    if (!fresh || fresh.matched_at !== null) throw new FlowrynError("approval_required", "that Claude prompt was already used");
    matchAttempt(db, choice.attempt.id, now);
    if (action === "merge") voidItemGrants(db, `merge:${task}`, "a confirmed prompt approved it", now);
  }
  const used = choice.kind === "grant" ? takeGrant(db, choice.grant, `${action} ${task}`, now) : null;
  const actor = used ? grantActor(used) : choice.kind === "attempt" ? `${user()} (Claude prompt, leader ${choice.session})` : choice.kind === "key" ? `${user()} (Pi confirm, leader ${choice.session})` : "yolo posture";
  const row = insertApproval(db, { task, ref: facts.ref, head: facts.head, channel: channelOf(choice), actor, action, allowRed: waiverOf(choice), now });
  consumeApproval(db, row.id, now, `${action} ${task}`);
  return row.id;
}

export interface MergeRow {
  id: string;
  task_id: string;
  pr_url: string;
  head_sha: string;
  approval_id: string;
  requested_at: number;
  state: "requested" | "merged" | "unproven" | "refused";
  merge_sha: string | null;
  proven_at: number | null;
  method: string | null;
  detail: string | null;
  checked_at: number | null;
  /** The passing verify that let it through (migration 27); null when none was required or on an older row. */
  local_green: string | null;
}

export function latestMerge(db: Db, taskId: string): MergeRow | null {
  return db.query("SELECT * FROM merges WHERE task_id = ?1 ORDER BY requested_at DESC, rowid DESC LIMIT 1").get(taskId) as MergeRow | null;
}

/** Who asked for a merge, on its `merge.requested` event: the CLI verb (`by` its caller), or the daemon's auto-merge (`by: auto`). */
export interface MergeRequester {
  source: EventSource;
  by: "leader" | "human" | "auto";
}

/** Record the merge request and move the run to merging. Call inside a transaction. */
export function recordMergeRequest(
  db: Db,
  facts: MergeFacts,
  approvalId: string,
  channel: Channel,
  waived: string | null,
  method: string,
  now: number,
  localGreen: string | null = null,
  requester: MergeRequester = { source: "cli", by: "leader" },
): string {
  const next = Number(getMeta(db, "next_merge_no") ?? "1");
  setMeta(db, "next_merge_no", String(next + 1));
  const id = `mg${next}`;
  db.query(
    `INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state, method, detail, local_green)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'requested', ?7, ?8, ?9)`,
  ).run(id, facts.run.task_id, facts.ref, facts.head, approvalId, now, method, waived ? `waived ${waived}` : null, localGreen);
  db.query("UPDATE runs SET state = 'merging', updated_at = ?2 WHERE id = ?1").run(facts.run.id, now);
  appendEvent(db, {
    source: requester.source,
    kind: "merge.requested",
    runId: facts.run.id,
    taskId: facts.run.task_id,
    payload: { merge: id, ref: facts.ref, head: facts.head, approval: approvalId, channel, waived, local_green: localGreen, method, checks: facts.checks ? checksLine(facts.checks) : null, by: requester.by },
    ts: now,
  });
  return id;
}

export type MergeResultState = { state: "merged"; sha: string; detail: string } | { state: "unproven"; detail: string } | { state: "refused"; detail: string };

/** What one merge request lands: rebuilt from its merges row, so a replay needs nothing from memory. */
export interface MergeTarget {
  kind: "pr" | "local";
  /** The canonical PR URL, or the local-only branch. */
  ref: string;
  head: string;
  method: string;
  title: string;
  project: ProjectRow;
}

export function targetOf(merge: MergeRow, project: ProjectRow, title: string): MergeTarget {
  const local = merge.pr_url.startsWith("local:");
  return { kind: local ? "local" : "pr", ref: local ? merge.pr_url.slice("local:".length) : merge.pr_url, head: merge.head_sha, method: merge.method ?? "squash", title, project };
}

/** Ask for the merge at exactly the approved head, then look for the proof. Never throws. */
export async function executeMerge(mc: MergeContext, target: MergeTarget): Promise<MergeResultState> {
  if (target.kind === "local") {
    const merged = await mc.git(["merge", "--ff-only", target.head], target.project.path);
    if (merged.code !== 0) return { state: "refused", detail: `git merge --ff-only failed: ${merged.stderr.trim() || merged.stdout.trim()}` };
    return proveLocal(mc.git, target.project, target.head);
  }
  const ref = parsePrUrl(target.ref, mc.github.web_url);
  if (!ref) return { state: "refused", detail: `${target.ref} is not a pull request URL` };
  let accepted = false;
  let message = "";
  try {
    const result = await mc.forge.merge(ref, target.head, target.method, target.title);
    accepted = result.merged;
    message = result.message;
  } catch (error) {
    if (error instanceof ForgeError && (error.kind === "conflict" || error.kind === "refused" || error.kind === "auth" || error.kind === "not_found")) {
      return { state: "refused", detail: `GitHub refused the merge: ${error.message}` };
    }
    return { state: "unproven", detail: `the merge request's result is unknown: ${(error as Error).message}` };
  }
  return proveRemote(mc, ref, accepted ? `GitHub accepted the merge (${message || "merged"})` : `GitHub did not say it merged (${message || "no message"})`);
}

/** The proof for a PR: it reads merged with a merge commit. */
export async function proveRemote(mc: Pick<MergeContext, "forge">, ref: { owner: string; repo: string; number: number }, context: string): Promise<MergeResultState> {
  try {
    const pr = await mc.forge.pull(ref);
    if (pr.state === "merged" && pr.mergeSha) return { state: "merged", sha: pr.mergeSha, detail: `${context}; the PR reads merged at ${pr.mergeSha.slice(0, 8)}` };
    if (pr.state === "closed") return { state: "refused", detail: `${context}; but the PR reads closed without a merge` };
    return { state: "unproven", detail: `${context}; but the PR does not read merged yet` };
  } catch (error) {
    return { state: "unproven", detail: `${context}; the PR could not be read back: ${(error as Error).message}` };
  }
}

/** The proof for local-only work: the head is on the local default branch. */
export async function proveLocal(git: GitRunner, project: ProjectRow, head: string): Promise<MergeResultState> {
  const onDefault = (await git(["merge-base", "--is-ancestor", head, `refs/heads/${project.default_branch}`], project.path)).code === 0;
  if (!onDefault) return { state: "unproven", detail: `${head.slice(0, 8)} is not on local ${project.default_branch}` };
  const sha = (await out(git, project.path, ["rev-parse", `refs/heads/${project.default_branch}`])) ?? head;
  return { state: "merged", sha, detail: `${head.slice(0, 8)} is on local ${project.default_branch} at ${sha.slice(0, 8)}` };
}

/**
 * Record what came of a merge request. Merged: the run lands (and cleanup
 * follows, outside this transaction), or, if it already ended, is kept as a
 * divergence (noteMergedAfterEnd). Unproven: the run stays merging, the
 * task is not landed, and a P1 says so. Refused: the run is ready again.
 * A merge the auto-merge asked for under yolo lands `by: auto` whoever proves
 * it (its own settle, or the watcher after a restart); its yolo_merged item
 * reports it. One that used a standing human approval lands `by: other`, so a
 * landed item reports it instead. Call inside a transaction.
 */
export function recordMergeResult(db: Db, run: RunWithPolicy, mergeId: string, result: MergeResultState, now: number, by: LandedBy = "other"): void {
  const merge = db.query("SELECT * FROM merges WHERE id = ?1").get(mergeId) as MergeRow | null;
  if (!merge || merge.state === "merged" || merge.state === "refused") return;
  const approval = db.query("SELECT channel FROM approvals WHERE id = ?1").get(merge.approval_id) as { channel: Channel } | null;
  if (db.query("SELECT 1 FROM auto_merges WHERE merge_id = ?1").get(mergeId)) by = approval?.channel === "yolo" ? "auto" : "other";
  if (result.state === "merged") {
    db.query("UPDATE merges SET state = 'merged', merge_sha = ?2, proven_at = ?3, checked_at = ?3, detail = COALESCE(detail || '; ', '') || ?4 WHERE id = ?1").run(mergeId, result.sha, now, result.detail);
    const delivered = isTerminal(run.state) ? deliveredOf(db, run.task_id) : null;
    if (delivered) noteMergedAfterEnd(db, run, delivered, { mergeSha: result.sha, source: merge.pr_url.startsWith("local:") ? "daemon" : "github" }, now);
    else landRun(db, run, { mergeSha: result.sha, how: "merge", mergeId, by }, now);
    if (approval?.channel === "yolo") {
      const event = appendEvent(db, { source: "daemon", kind: "merge.yolo", runId: run.id, taskId: run.task_id, payload: { merge: mergeId, sha: result.sha }, ts: now });
      openItem(db, { kind: "yolo_merged", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Merged under yolo: ${taskTitle(db, run.task_id)} (${run.project_id})`, now });
    }
    return;
  }
  if (result.state === "unproven") {
    db.query("UPDATE merges SET state = 'unproven', checked_at = ?2, detail = ?3 WHERE id = ?1").run(mergeId, now, result.detail);
    const event = appendEvent(db, { source: "daemon", kind: "merge.unproven", runId: run.id, taskId: run.task_id, payload: { merge: mergeId, detail: result.detail }, ts: now });
    if (!findOpenRunItem(db, "unproven_merge", run.id)) {
      openItem(db, { kind: "unproven_merge", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Merge not proven for ${taskTitle(db, run.task_id)}: ${result.detail}; not landed`, now });
    }
    return;
  }
  db.query("UPDATE merges SET state = 'refused', checked_at = ?2, detail = ?3 WHERE id = ?1").run(mergeId, now, result.detail);
  db.query("UPDATE runs SET state = 'ready', updated_at = ?2 WHERE id = ?1 AND state = 'merging'").run(run.id, now);
  appendEvent(db, { source: "daemon", kind: "merge.refused", runId: run.id, taskId: run.task_id, payload: { merge: mergeId, detail: result.detail }, ts: now });
}

/** Refresh the PR evidence the gate read, so show and the board agree with what was decided. */
export function rememberFacts(db: Db, facts: MergeFacts, now: number): void {
  if (facts.pr) recordPrEvidence(db, facts.run.id, prEvidenceFrom(facts.pr, facts.checks, now), now);
}
