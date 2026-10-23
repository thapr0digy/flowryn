import { existsSync } from "node:fs";
import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { canonicalPrUrl, parsePrUrl, repoOf } from "../forge/github.ts";
import { ForgeError, type PrRef, type PullRequest } from "../forge/types.ts";
import { approvalRef, deliveredOf } from "../lifecycle/delivery.ts";
import { getProject, listProjects, type ProjectRow } from "../lifecycle/projects.ts";
import { runAndProject } from "../policy/verbs.ts";
import { isForgeOutage, noteForgeDown } from "../reconcile/forge-health.ts";
import { capacityConfig } from "../config/workflows.ts";
import type { HostVerdict } from "../sched/host.ts";
import { tx } from "../db/db.ts";
import { verifyConfig, verifySnippet, type VerifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";
import { findQueued, getRequest, insertRequest, positionOf, queuedRequests, requeuedFrom, type VerifyRequest } from "./queue.ts";
import { isVerifying, readTail, type VerifyDeps } from "./runner.ts";
import { admitRequest, launchVerification, planOf, queueHold, verifyRoot as rootOf, VERIFY_POOL, waitingOn } from "./start.ts";
import { getVerification, runningVerifications, type Verification } from "./store.ts";
import { countsLine } from "./summary.ts";

/**
 * The daemon side of `flowryn verify` (the CLI verb is src/cli/commands/verify.ts):
 * `verify.start` resolves the PR head through the forge and starts the job,
 * or queues it behind the others for a validation slot (src/verify/start.ts);
 * `verify show` reads where a verification, or a queued request, stands.
 * Leader and human only: a passing verification counts at the merge gate.
 */

export function verifyRoot(ctx: Pick<HandlerCtx, "config">): string {
  return rootOf(ctx.config());
}

export { VERIFY_POOL };

function verifyDeps(ctx: HandlerCtx): VerifyDeps {
  return { db: ctx.db, git: ctx.delivery.git, now: ctx.now, log: ctx.log, root: verifyRoot(ctx), released: () => ctx.sched.kick() };
}

interface Target {
  project: ProjectRow;
  /** The PR, or null for a local-only task's branch. */
  ref: PrRef | null;
  /** The canonical PR URL, or local:<branch> (what the merge gate reads verifications by). */
  url: string;
  task: string | null;
  /** A local-only task's worktree, whose HEAD is the head verified; null for a PR. */
  worktree: string | null;
}

function sameRepo(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

function githubProjects(db: Db, webUrl: string): { project: ProjectRow; repo: { owner: string; repo: string } }[] {
  return listProjects(db).flatMap((project) => {
    const repo = project.repo_url ? repoOf(project.repo_url, webUrl) : null;
    return repo ? [{ project, repo }] : [];
  });
}

function taskOfPr(db: Db, url: string): string | null {
  return (db.query("SELECT task_id FROM artifacts WHERE kind = 'pr' AND ref = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(url) as { task_id: string } | null)?.task_id ?? null;
}

/** A PR number (with --project, or the one project with a GitHub remote), a PR URL, or a task whose delivery is a PR. */
export function resolveTarget(db: Db, target: string, projectId: string | undefined, webUrl: string): Target {
  const number = /^#?(\d+)$/.exec(target);
  if (number) {
    const candidates = githubProjects(db, webUrl);
    let found;
    if (projectId) {
      found = candidates.find((c) => c.project.id === projectId);
      if (!found) throw new FlowrynError(getProject(db, projectId) ? "not_ready" : "not_found", getProject(db, projectId) ? `project ${projectId} has no GitHub remote` : `no project ${projectId}`, "flowryn project list");
    } else if (candidates.length === 1) found = candidates[0]!;
    else if (candidates.length === 0) throw new FlowrynError("not_found", "no project has a GitHub remote", "flowryn project list");
    else throw new FlowrynError("bad_args", `several projects have a GitHub remote (${candidates.map((c) => c.project.id).join(", ")}); name one with --project`);
    const ref = { ...found.repo, number: Number(number[1]) };
    const url = canonicalPrUrl(ref, webUrl);
    return { project: found.project, ref, url, task: taskOfPr(db, url), worktree: null };
  }
  const parsed = parsePrUrl(target, webUrl);
  if (parsed) {
    const found = githubProjects(db, webUrl).find((c) => sameRepo(c.repo, parsed) && (!projectId || c.project.id === projectId));
    if (!found) throw new FlowrynError("not_found", `no project has the remote ${parsed.owner}/${parsed.repo}`, "flowryn project list");
    const url = canonicalPrUrl(parsed, webUrl);
    return { project: found.project, ref: parsed, url, task: taskOfPr(db, url), worktree: null };
  }
  const { run, project } = runAndProject(db, target);
  const delivered = deliveredOf(db, run.task_id);
  if (!delivered) throw new FlowrynError("not_ready", `${run.task_id} has delivered no PR yet (the run is ${run.state})`, `flowryn show ${run.task_id}`);
  // Local-only work is verified at its worktree HEAD, the head its merge would land (docs/notes/2026-10-15-merge-gate-require-bf.md).
  if (delivered.kind !== "pr") return { project, ref: null, url: approvalRef(delivered), task: run.task_id, worktree: run.worktree_path };
  const ref = parsePrUrl(delivered.ref, webUrl);
  if (!ref) throw new FlowrynError("not_ready", `the delivered PR ${delivered.ref} is not a pull request URL`);
  return { project, ref, url: canonicalPrUrl(ref, webUrl), task: run.task_id, worktree: null };
}

/** The head a verify starts at: the PR's (with its branch), or a local-only worktree's. */
interface HeadToVerify {
  headSha: string;
  headRef: string | null;
}

interface StartPrepared {
  target: Target;
  pr: HeadToVerify;
  config: VerifyConfig;
  /** The identity of `config`, recorded with a new job and required of a running one to attach. */
  policy: string;
  host: HostVerdict;
}

/** What the CLI and `verify show` print: the steps so far, and the tail of a failed step's output. */
export function verificationView(v: Verification, now: number, db?: Db): Record<string, unknown> {
  const failed = v.steps.find((s) => s.state === "failed");
  // A verification the last daemon was running when it stopped runs again from the front of the queue.
  const requeued = db && v.state === "error" ? requeuedFrom(db, v.id) : null;
  return {
    verification: v.id,
    project: v.project_id,
    pr: v.pr_url,
    task: v.task_id ?? "-",
    head: v.head_sha,
    policy: v.policy_id ?? "-",
    state: v.state,
    steps: v.steps.map((s) => ({
      step: s.name,
      state: s.state,
      exit: s.exit ?? "-",
      ms: s.ms ?? "-",
      tests: s.tests ? countsLine(s.tests) : "-",
      detail: s.detail ?? "-",
      group: s.group ?? "-",
      deadline_ms: s.deadline_ms ?? "-",
      attempts: s.attempts ?? "-",
    })),
    tests: v.tests ? countsLine(v.tests) : "-",
    duration_ms: (v.finished_at ?? now) - v.started_at,
    binary: v.binary_path === null ? "-" : existsSync(v.binary_path) ? v.binary_path : `${v.binary_path} (removed)`,
    detail: v.detail ?? "-",
    logs: v.dir,
    tail: failed ? readTail(join(v.dir, failed.log), 16 * 1024).split("\n").slice(-31).join("\n").trimEnd() : "-",
    ...(requeued ? { requeued: requeued.id } : {}),
  };
}

const verifyStart: VerbSpec = {
  name: "verify.start",
  summary: "Start a verification of a PR head (internal; flowryn verify)",
  positionals: [{ name: "target", required: true, help: "task, PR number or PR URL" }],
  flags: {
    project: { type: "string", help: "the project a PR number belongs to", placeholder: "id" },
    path: { type: "string", help: "the caller's PATH, for the steps (the CLI sends it)", placeholder: "dirs" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  replyMs: 60_000,
  async prepare(ctx, args): Promise<StartPrepared> {
    const github = ctx.delivery.github();
    const target = resolveTarget(ctx.db, stringArg(args, "target")!, stringArg(args, "project"), github.web_url);
    const config = verifyConfig(ctx.config(), target.project.id);
    if (!config) {
      throw new FlowrynError("not_configured", `project ${target.project.id} has no verify steps; add them to config.toml:\n${verifySnippet(target.project.id)}`, "then reload the config: flowryn daemon restart, or send flowrynd SIGHUP");
    }
    // Local-only work: the worktree HEAD, the head its merge would land; there is no PR to read.
    if (!target.ref) {
      const head = await ctx.delivery.git(["rev-parse", "HEAD"], target.worktree!);
      if (head.code !== 0) throw new FlowrynError("not_ready", `cannot read the head of ${target.url} in ${target.worktree} (${head.stderr.trim() || `exit ${head.code}`})`, `flowryn show ${target.task}`);
      return { target, pr: { headSha: head.stdout.trim(), headRef: null }, config, policy: verifyPolicyId(config), host: await ctx.sched.host() };
    }
    let pr: PullRequest;
    try {
      pr = await ctx.delivery.forge().pull(target.ref);
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") throw new FlowrynError("not_found", `GitHub has no ${target.url}`);
      if (isForgeOutage(error)) tx(ctx.db, () => noteForgeDown(ctx.db, error, "github", ctx.now()));
      throw new FlowrynError("forge_unavailable", `cannot read ${target.url} from GitHub (${(error as Error).message})`, "try again later");
    }
    if (pr.state !== "open") throw new FlowrynError("not_ready", `${target.url} is ${pr.state}; only an open PR is verified`);
    if (!sameRepo(repoOf(`${github.web_url}/${pr.headRepo}`, github.web_url) ?? { owner: "", repo: "" }, target.ref)) {
      throw new FlowrynError("fork_pr", `${target.url} comes from the fork ${pr.headRepo}; verify runs the PR's code with no sandbox, so it only verifies branches of ${target.ref.owner}/${target.ref.repo}`);
    }
    // Read before the transaction (it may sample the host); apply enforces it only for a new job, never an attach.
    const host = await ctx.sched.host();
    return { target, pr, config, policy: verifyPolicyId(config), host };
  },
  apply(ctx, args, prepared) {
    const { target, pr, config, policy, host } = prepared as StartPrepared;
    const now = ctx.now();
    const running = runningVerifications(ctx.db);
    const same = running.find((v) => v.pr_url === target.url && v.head_sha === pr.headSha && v.policy_id === policy);
    if (same) return { data: { ...verificationView(same, now), attached: true } };
    const caps = capacityConfig(ctx.config()).pools;
    const joined = findQueued(ctx.db, target.url, pr.headSha, policy);
    if (joined) return { data: { ...requestView(ctx.db, joined, caps, now), attached: true } };
    const ahead = queuedRequests(ctx.db).length > 0;
    const request = insertRequest(ctx.db, {
      project_id: target.project.id,
      pr_url: target.url,
      task_id: target.task,
      head_sha: pr.headSha,
      policy_id: policy,
      pr_number: target.ref?.number ?? null,
      head_ref: pr.headRef,
      worktree: target.worktree,
      source: "cli",
      path: stringArg(args, "path") ?? null,
      now,
    });
    // It starts now only when nothing waits ahead of it, no restart holds verifies back, a slot is free and the host check passes; else it waits its turn.
    if (ahead || !host.ok || queueHold(ctx.db, caps, now)) return { data: { ...requestView(ctx.db, request, caps, now, host), attached: false } };
    const v = admitRequest(ctx.db, request, config, caps, verifyRoot(ctx), target.project.path, now);
    return { data: { ...verificationView(v, now), request: request.id, attached: false, started: true } };
  },
  async settle(ctx, result) {
    if (result.data.queued === true) {
      ctx.sched.kick();
      return { data: result.data, hints: [`flowryn verify show ${String(result.data.request)}`] };
    }
    const id = String(result.data.verification ?? "");
    const v = getVerification(ctx.db, id);
    const request = result.data.started === true ? getRequest(ctx.db, String(result.data.request)) : null;
    // A replay of the call, or an attach to a running job, starts nothing.
    if (v && request && v.state === "running" && !isVerifying(id)) {
      const config = verifyConfig(ctx.config(), v.project_id);
      if (config) launchVerification(verifyDeps(ctx), v, planOf(request, config));
    }
    const { started: _s, ...data } = result.data;
    return { data, hints: [`flowryn verify show ${id}`] };
  },
};

/** A request as `verify start` and `verify show` print it: where it stands in the queue and what it waits on, or the verification it started. */
export function requestView(db: Db, request: VerifyRequest, caps: Record<string, number>, now: number, host?: HostVerdict): Record<string, unknown> {
  const place = positionOf(db, request.id);
  let waiting = request.state === "queued" ? waitingOn(db, request, caps, now) : "-";
  if (host && !host.ok && waiting === "starting") waiting = `the host check fails (${host.reason})`;
  return {
    request: request.id,
    queued: request.state === "queued",
    state: request.state,
    project: request.project_id,
    pr: request.pr_url,
    task: request.task_id ?? "-",
    head: request.head_sha,
    policy: request.policy_id,
    source: request.source,
    position: place ? `${place.position} of ${place.of}` : "-",
    waiting,
    waited_ms: (request.ended_at ?? now) - request.requested_at,
    verification: request.verification_id ?? "-",
    detail: request.detail ?? "-",
  };
}

const verifyShow: VerbSpec = {
  name: "verify show",
  summary: "Where a verification stands: each step, the test counts, the kept binary",
  positionals: [{ name: "id", required: true, help: "verification id (v<n>) or queued request (vq<n>)" }],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const id = stringArg(args, "id")!;
    if (/^vq\d+$/.test(id)) {
      const request = getRequest(ctx.db, id);
      if (!request) throw new FlowrynError("not_found", `no verify request ${id}`);
      return { data: requestView(ctx.db, request, capacityConfig(ctx.config).pools, ctx.now), hints: request.verification_id ? [`flowryn verify show ${request.verification_id}`] : [] };
    }
    const v = getVerification(ctx.db, id);
    if (!v) throw new FlowrynError("not_found", `no verification ${id}`);
    return { data: verificationView(v, ctx.now, ctx.db), hints: v.task_id ? [`flowryn show ${v.task_id}`] : [] };
  },
};

export const VERIFY_VERBS: readonly VerbSpec[] = [verifyStart, verifyShow];
