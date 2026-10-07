import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { canonicalPrUrl, parsePrUrl, repoOf } from "../forge/github.ts";
import { ForgeError, type PrRef, type PullRequest } from "../forge/types.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { getProject, listProjects, type ProjectRow } from "../lifecycle/projects.ts";
import { runAndProject } from "../policy/verbs.ts";
import { isForgeOutage, noteForgeDown } from "../reconcile/forge-health.ts";
import { tx } from "../db/db.ts";
import { verifyConfig, verifySnippet, type VerifyConfig } from "./config.ts";
import { initialSteps, isVerifying, readTail, runVerification, type VerifyDeps } from "./runner.ts";
import { getVerification, insertVerification, runningVerifications, type Verification } from "./store.ts";
import { countsLine } from "./summary.ts";

/**
 * The daemon side of `flowryn verify` (the CLI verb is src/cli/commands/verify.ts):
 * `verify.start` resolves the PR head through the forge and starts the job,
 * `verify show` reads where a verification stands. Leader and human only: a
 * passing verification counts at the merge gate.
 */

export function verifyRoot(ctx: Pick<HandlerCtx, "config">): string {
  return join(ctx.config().state_dir, "verify");
}

function verifyDeps(ctx: HandlerCtx): VerifyDeps {
  return { db: ctx.db, git: ctx.delivery.git, now: ctx.now, log: ctx.log, root: verifyRoot(ctx) };
}

interface Target {
  project: ProjectRow;
  ref: PrRef;
  url: string;
  task: string | null;
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
    return { project: found.project, ref, url, task: taskOfPr(db, url) };
  }
  const parsed = parsePrUrl(target, webUrl);
  if (parsed) {
    const found = githubProjects(db, webUrl).find((c) => sameRepo(c.repo, parsed) && (!projectId || c.project.id === projectId));
    if (!found) throw new FlowrynError("not_found", `no project has the remote ${parsed.owner}/${parsed.repo}`, "flowryn project list");
    const url = canonicalPrUrl(parsed, webUrl);
    return { project: found.project, ref: parsed, url, task: taskOfPr(db, url) };
  }
  const { run, project } = runAndProject(db, target);
  const delivered = deliveredOf(db, run.task_id);
  if (!delivered) throw new FlowrynError("not_ready", `${run.task_id} has delivered no PR yet (the run is ${run.state})`, `flowryn show ${run.task_id}`);
  if (delivered.kind !== "pr") throw new FlowrynError("not_ready", `${run.task_id} is local-only: it delivered a branch, not a PR`, `flowryn show ${run.task_id}`);
  const ref = parsePrUrl(delivered.ref, webUrl);
  if (!ref) throw new FlowrynError("not_ready", `the delivered PR ${delivered.ref} is not a pull request URL`);
  return { project, ref, url: canonicalPrUrl(ref, webUrl), task: run.task_id };
}

interface StartPrepared {
  target: Target;
  pr: PullRequest;
  config: VerifyConfig;
}

/** What the CLI and `verify show` print: the steps so far, and the tail of a failed step's output. */
export function verificationView(v: Verification, now: number): Record<string, unknown> {
  const failed = v.steps.find((s) => s.state === "failed");
  return {
    verification: v.id,
    project: v.project_id,
    pr: v.pr_url,
    task: v.task_id ?? "-",
    head: v.head_sha,
    state: v.state,
    steps: v.steps.map((s) => ({ step: s.name, state: s.state, exit: s.exit ?? "-", ms: s.ms ?? "-", tests: s.tests ? countsLine(s.tests) : "-", detail: s.detail ?? "-" })),
    tests: v.tests ? countsLine(v.tests) : "-",
    duration_ms: (v.finished_at ?? now) - v.started_at,
    binary: v.binary_path ?? "-",
    detail: v.detail ?? "-",
    logs: v.dir,
    tail: failed ? readTail(join(v.dir, failed.log), 16 * 1024).split("\n").slice(-31).join("\n").trimEnd() : "-",
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
    return { target, pr, config };
  },
  apply(ctx, args, prepared) {
    const { target, pr, config } = prepared as StartPrepared;
    const running = runningVerifications(ctx.db);
    const same = running.find((v) => v.pr_url === target.url && v.head_sha === pr.headSha);
    if (same) return { data: { ...verificationView(same, ctx.now()), attached: true } };
    if (running.length > 0) {
      const busy = running[0]!;
      throw new FlowrynError("verify_busy", `verification ${busy.id} of ${busy.pr_url} at ${busy.head_sha.slice(0, 8)} is running; one runs at a time`, `flowryn verify show ${busy.id}`);
    }
    const root = verifyRoot(ctx);
    const v = insertVerification(ctx.db, {
      project_id: target.project.id,
      pr_url: target.url,
      task_id: target.task,
      head_sha: pr.headSha,
      steps: initialSteps(config.steps),
      dir: (id) => join(root, id),
      worktree: (id) => join(root, id, "wt"),
      project_path: target.project.path,
      source: "cli",
      now: ctx.now(),
    });
    return { data: { ...verificationView(v, ctx.now()), attached: false, pr_number: target.ref.number, head_ref: pr.headRef, binary_config: config.binary ?? "", timeout_ms: config.timeout_ms, env_path: stringArg(args, "path") ?? "" } };
  },
  async settle(ctx, result) {
    const id = String(result.data.verification ?? "");
    const v = getVerification(ctx.db, id);
    // A replay of the call, or an attach to a running job, starts nothing.
    if (v && v.state === "running" && !isVerifying(id) && result.data.attached === false) {
      const plan = { prNumber: Number(result.data.pr_number), headRef: String(result.data.head_ref), binary: String(result.data.binary_config) || null, timeoutMs: Number(result.data.timeout_ms), path: String(result.data.env_path ?? "") || null };
      void runVerification(verifyDeps(ctx), v, plan).catch((error: unknown) => ctx.log(`verify ${id}: ${(error as Error).message}`));
    }
    const { pr_number: _n, head_ref: _r, binary_config: _b, timeout_ms: _t, env_path: _p, ...data } = result.data;
    return { data, hints: [`flowryn verify show ${id}`] };
  },
};

const verifyShow: VerbSpec = {
  name: "verify show",
  summary: "Where a verification stands: each step, the test counts, the kept binary",
  positionals: [{ name: "id", required: true, help: "verification id (v<n>)" }],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const id = stringArg(args, "id")!;
    const v = getVerification(ctx.db, id);
    if (!v) throw new FlowrynError("not_found", `no verification ${id}`);
    return { data: verificationView(v, ctx.now), hints: v.task_id ? [`flowryn show ${v.task_id}`] : [] };
  },
};

export const VERIFY_VERBS: readonly VerbSpec[] = [verifyStart, verifyShow];
