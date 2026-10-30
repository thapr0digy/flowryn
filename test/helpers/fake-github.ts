import { createHash } from "node:crypto";

/**
 * A fake GitHub for tests, the cleanup-guard fixtures and the lab: the REST
 * calls Flowryn makes (src/forge/github.ts), answered from memory, with ETags
 * and 304s like GitHub. A repository can be backed by a local bare git repo
 * (its "origin"): then a PR's head follows the pushed branch, as on GitHub,
 * and a merge really lands on the bare repo's base branch (a squash or a
 * merge commit), so the cleanup guard sees what it would see after a real
 * merge. A PR's reviews, inline review comments and conversation comments
 * are served in GitHub's REST shapes, and their threads' resolution through
 * the GraphQL reviewThreads query (POST /graphql). Knobs make the forge unreachable, rate limited, fail annotation reads, or accept a merge it
 * never reports (the unproven-merge case). Nothing here reaches the network.
 */

export type FakeCheckState = "green" | "red" | "pending";

export interface FakeCheck {
  name: string;
  state: FakeCheckState;
  /** A commit status instead of a check run. */
  status?: boolean;
  /** A red check run GitHub never started (Actions billing): its failure annotation says so. */
  notStarted?: boolean;
}

/** GitHub's annotation on a job it never started, verbatim from a real PR whose Actions minutes ran out. */
export const NOT_STARTED_MESSAGE =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

export interface FakePr {
  number: number;
  title: string;
  headRef: string;
  /** Fixed head; when the repo has a bare origin and the PR is open, the pushed branch wins. */
  headSha: string;
  baseRef: string;
  /** owner/repo the head branch lives in, when it is a fork; the repo itself otherwise. */
  headRepo?: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  /** Set by an accepted-but-unproven merge; `prove()` makes it read merged. */
  pendingMerge: string | null;
  /**
   * What GitHub's `mergeable` reads for the open PR: undefined computes it (a
   * trial merge of the head into the base on the bare origin, true without
   * one); a boolean or null (GitHub still computing) forces it.
   */
  mergeable?: boolean | null;
  /** The login that opened it (user.login); the repo owner by default. */
  author?: string;
  reviews: FakeReview[];
  reviewComments: FakeComment[];
  issueComments: FakeComment[];
  /** Root comment ids of the resolved review threads. */
  resolvedThreads: Set<number>;
}

/** Who wrote a review or comment: a login, its author_association, and whether it is a bot. */
export interface FakeAuthor {
  login: string;
  association?: string;
  bot?: boolean;
}

export interface FakeReview extends FakeAuthor {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  at: string;
}

export interface FakeComment extends FakeAuthor {
  id: number;
  body: string;
  at: string;
  /** Inline review comments only. */
  path?: string;
  line?: number;
  inReplyTo?: number;
}

export type MergeMode = "real" | "accept-unproven" | "error-500" | "refuse";

export interface FakeRepo {
  owner: string;
  repo: string;
  /** Bare repository backing the PR heads and merges, or null for static data. */
  bare: string | null;
  prs: FakePr[];
  /** Checks per head SHA; heads without an entry get `defaultChecks`. */
  checks: Map<string, FakeCheck[]>;
  defaultChecks: FakeCheck[];
  mergeMode: MergeMode;
  deleteBranchOnMerge: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  status: number;
  body?: unknown;
}

function gitSync(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

const IDENTITY = { GIT_AUTHOR_NAME: "Fake GitHub", GIT_AUTHOR_EMAIL: "noreply@github.invalid", GIT_COMMITTER_NAME: "Fake GitHub", GIT_COMMITTER_EMAIL: "noreply@github.invalid" };

export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly requests: FakeRequest[] = [];
  /** Every request fails as if GitHub were down. */
  unreachable = false;
  /** Every request answers 403 with the rate limit spent. */
  rateLimited = false;
  /** Check-run annotation reads answer 500. */
  annotationsDown = false;
  /** A silent forge: "headers" never answers; "body" answers 200 and a start of a body that never ends. */
  stall: "none" | "headers" | "body" = "none";
  /** Releases the requests held by `stall`, on stop. */
  private readonly stalled: (() => void)[] = [];
  readonly webUrl: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextNumber = 1;
  /** Review and comment ids, one sequence as on GitHub, so a later one has a larger id. */
  private nextFeedbackId = 1000;
  /** Check runs served so far, by id, for their annotations. */
  private readonly checkRuns = new Map<number, FakeCheck>();

  constructor(webUrl = "https://github.com") {
    this.webUrl = webUrl;
  }

  static async start(webUrl?: string): Promise<FakeGitHub> {
    const fake = new FakeGitHub(webUrl);
    fake.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => fake.handle(req) });
    return fake;
  }

  get apiUrl(): string {
    if (!this.server) throw new Error("the fake GitHub is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    for (const release of this.stalled.splice(0)) release();
    await this.server?.stop(true);
    this.server = null;
  }

  addRepo(owner: string, repo: string, options: { bare?: string | null; defaultChecks?: FakeCheck[]; deleteBranchOnMerge?: boolean } = {}): FakeRepo {
    const entry: FakeRepo = {
      owner,
      repo,
      bare: options.bare ?? null,
      prs: [],
      checks: new Map(),
      defaultChecks: options.defaultChecks ?? [{ name: "ci/test", state: "green" }],
      mergeMode: "real",
      deleteBranchOnMerge: options.deleteBranchOnMerge ?? true,
    };
    this.repos.set(`${owner}/${repo}`, entry);
    return entry;
  }

  repo(fullName: string): FakeRepo {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error(`fake GitHub has no repo ${fullName}`);
    return repo;
  }

  /** Add a PR directly (fixtures and tests); `open` keeps following the bare branch when there is one. */
  addPr(fullName: string, pr: Partial<Omit<FakePr, "reviews" | "reviewComments" | "issueComments" | "resolvedThreads">> & { headRef: string; headSha?: string }): FakePr {
    const repo = this.repo(fullName);
    const number = pr.number ?? this.nextNumber;
    this.nextNumber = Math.max(this.nextNumber, number + 1);
    const headSha = pr.headSha ?? this.branchHead(repo, pr.headRef) ?? "";
    const created: FakePr = {
      number,
      title: pr.title ?? `PR ${number}`,
      headRef: pr.headRef,
      headSha,
      baseRef: pr.baseRef ?? "main",
      ...(pr.headRepo ? { headRepo: pr.headRepo } : {}),
      state: pr.state ?? "open",
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      mergedAt: pr.mergedAt ?? (pr.merged ? "2026-06-26T00:00:00Z" : null),
      mergeSha: pr.mergeSha ?? null,
      pendingMerge: null,
      ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable } : {}),
      ...(pr.author ? { author: pr.author } : {}),
      reviews: [],
      reviewComments: [],
      issueComments: [],
      resolvedThreads: new Set(),
    };
    repo.prs.push(created);
    return created;
  }

  pr(fullName: string, number: number): FakePr {
    const found = this.repo(fullName).prs.find((p) => p.number === number);
    if (!found) throw new Error(`fake GitHub has no PR ${fullName}#${number}`);
    return found;
  }

  prUrl(fullName: string, number: number): string {
    return `${this.webUrl}/${fullName}/pull/${number}`;
  }

  /** A submitted review; returns its id. */
  addReview(fullName: string, number: number, review: FakeAuthor & { state: FakeReview["state"]; body?: string; at?: string }): number {
    const id = this.nextFeedbackId++;
    this.pr(fullName, number).reviews.push({ ...review, id, body: review.body ?? "", at: review.at ?? new Date().toISOString() });
    return id;
  }

  /** An inline review comment (a reply when `inReplyTo` names its thread's first comment); returns its id. */
  addReviewComment(fullName: string, number: number, comment: FakeAuthor & { body: string; path?: string; line?: number; inReplyTo?: number; at?: string }): number {
    const id = this.nextFeedbackId++;
    this.pr(fullName, number).reviewComments.push({ path: "src/app.ts", line: 1, ...comment, id, at: comment.at ?? new Date().toISOString() });
    return id;
  }

  /** A comment on the PR's conversation tab; returns its id. */
  addIssueComment(fullName: string, number: number, comment: FakeAuthor & { body: string; at?: string }): number {
    const id = this.nextFeedbackId++;
    this.pr(fullName, number).issueComments.push({ ...comment, id, at: comment.at ?? new Date().toISOString() });
    return id;
  }

  /** Resolve the review thread whose first comment is `rootId`. */
  resolveThread(fullName: string, number: number, rootId: number): void {
    this.pr(fullName, number).resolvedThreads.add(rootId);
  }

  setChecks(fullName: string, sha: string, checks: FakeCheck[]): void {
    this.repo(fullName).checks.set(sha, checks);
  }

  /** An accepted-but-unproven merge now reads merged, the way GitHub catches up. */
  prove(fullName: string, number: number): void {
    const pr = this.pr(fullName, number);
    if (!pr.pendingMerge) throw new Error(`PR ${number} has no pending merge`);
    pr.merged = true;
    pr.state = "closed";
    pr.mergeSha = pr.pendingMerge;
    pr.mergedAt = new Date().toISOString();
    pr.pendingMerge = null;
  }

  count(method: string, pathPart: string): number {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathPart)).length;
  }

  private branchHead(repo: FakeRepo, branch: string): string | null {
    if (!repo.bare) return null;
    const result = gitSync(repo.bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    return result.code === 0 && result.out ? result.out : null;
  }

  /** The PR's head now: an open PR follows its pushed branch, as GitHub does. */
  private headOf(repo: FakeRepo, pr: FakePr): string {
    if (pr.state === "open" && !pr.merged) {
      const live = this.branchHead(repo, pr.headRef);
      if (live) pr.headSha = live;
    }
    return pr.headSha;
  }

  /** GitHub's `mergeable` for an open PR: whether the head merges into the base without conflicts. */
  private mergeableOf(repo: FakeRepo, pr: FakePr, head: string): boolean | null {
    if (pr.merged || pr.state !== "open") return null;
    if (pr.mergeable !== undefined) return pr.mergeable;
    if (!repo.bare) return true;
    const base = gitSync(repo.bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${pr.baseRef}^{commit}`]).out;
    if (!base || !head) return null;
    return gitSync(repo.bare, ["merge-tree", "--write-tree", base, head]).code === 0;
  }

  private prJson(repo: FakeRepo, pr: FakePr): Record<string, unknown> {
    const full = `${repo.owner}/${repo.repo}`;
    const head = this.headOf(repo, pr);
    return {
      number: pr.number,
      html_url: `${this.webUrl}/${full}/pull/${pr.number}`,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      merged_at: pr.mergedAt,
      // GitHub reports a test merge commit for an open PR too; only a merged PR's is a landing.
      merge_commit_sha: pr.merged ? pr.mergeSha : "0000000000000000000000000000000000000000",
      head: { ref: pr.headRef, sha: head, repo: { full_name: pr.headRepo ?? full } },
      base: { ref: pr.baseRef, repo: { full_name: full } },
      mergeable: this.mergeableOf(repo, pr, head),
      user: { login: pr.author ?? repo.owner, type: "User" },
    };
  }

  private userJson(author: FakeAuthor): Record<string, unknown> {
    return { user: { login: author.login, type: author.bot ? "Bot" : "User" }, author_association: author.association ?? "NONE" };
  }

  private feedbackJson(repo: FakeRepo, pr: FakePr, kind: "reviews" | "comments" | "issue-comments"): Record<string, unknown>[] {
    const base = `${this.webUrl}/${repo.owner}/${repo.repo}/pull/${pr.number}`;
    if (kind === "reviews") {
      return pr.reviews.map((r) => ({ id: r.id, ...this.userJson(r), state: r.state, body: r.body, submitted_at: r.at, html_url: `${base}#pullrequestreview-${r.id}`, commit_id: pr.headSha }));
    }
    if (kind === "comments") {
      return pr.reviewComments.map((c) => ({
        id: c.id,
        ...this.userJson(c),
        body: c.body,
        created_at: c.at,
        updated_at: c.at,
        html_url: `${base}#discussion_r${c.id}`,
        path: c.path,
        line: c.line ?? null,
        original_line: c.line ?? null,
        ...(c.inReplyTo ? { in_reply_to_id: c.inReplyTo } : {}),
      }));
    }
    return pr.issueComments.map((c) => ({ id: c.id, ...this.userJson(c), body: c.body, created_at: c.at, updated_at: c.at, html_url: `${base}#issuecomment-${c.id}` }));
  }

  /** One page of a list, as GitHub pages it (`per_page`, `page`). */
  private page<T>(url: URL, all: T[]): T[] {
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const page = Number(url.searchParams.get("page") ?? "1");
    return all.slice((page - 1) * perPage, page * perPage);
  }

  /** GitHub's GraphQL API, for the one query Flowryn makes: a PR's reviewThreads. */
  private graphql(req: Request, path: string, body: Record<string, unknown>): Response {
    const query = String(body.query ?? "");
    const variables = (body.variables ?? {}) as { owner?: string; name?: string; number?: number };
    if (!query.includes("reviewThreads")) return this.json(req, path, 200, { errors: [{ message: "the fake GitHub answers only reviewThreads" }] });
    const repo = this.repos.get(`${variables.owner}/${variables.name}`);
    const pr = repo?.prs.find((p) => p.number === variables.number);
    if (!repo || !pr) return this.json(req, path, 200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] });
    const roots = pr.reviewComments.filter((c) => !c.inReplyTo);
    const nodes = roots.map((c) => ({ isResolved: pr.resolvedThreads.has(c.id), comments: { nodes: [{ databaseId: c.id }] } }));
    return this.json(req, path, 200, { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  }

  private json(req: Request, path: string, status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
    const text = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    if (req.method === "GET" && status === 200 && req.headers.get("if-none-match") === etag) {
      this.requests.push({ method: req.method, path, status: 304 });
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    this.requests.push({ method: req.method, path, status, body });
    return new Response(text, { status, headers: { "Content-Type": "application/json", ETag: etag, "X-RateLimit-Remaining": "4999", ...extraHeaders } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    if (this.stall !== "none") {
      this.requests.push({ method: req.method, path, status: 0 });
      const held = new Promise<void>((resolve) => this.stalled.push(resolve));
      if (this.stall === "headers") {
        await held;
        return new Response("", { status: 503 });
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('{"number":'));
          await held;
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (this.unreachable) {
      this.requests.push({ method: req.method, path, status: 503 });
      return new Response(JSON.stringify({ message: "Service Unavailable (fake)" }), { status: 503 });
    }
    if (this.rateLimited) {
      return this.json(req, path, 403, { message: "API rate limit exceeded (fake)" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60) });
    }
    if (req.method === "POST" && url.pathname === "/graphql") {
      let query: Record<string, unknown> = {};
      try {
        query = (await req.json()) as Record<string, unknown>;
      } catch {
        query = {};
      }
      return this.graphql(req, path, query);
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(url.pathname);
    const repo = match ? this.repos.get(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`) : undefined;
    if (!match || !repo) return this.json(req, path, 404, { message: "Not Found" });
    const rest = match[3]!;
    let body: Record<string, unknown> = {};
    if (req.method !== "GET") {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    if (req.method === "GET" && rest === "pulls") {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
      const list = repo.prs.filter((p) => !branch || p.headRef === branch).toReversed();
      return this.json(req, path, 200, list.map((p) => this.prJson(repo, p)));
    }
    if (req.method === "POST" && rest === "pulls") {
      const headRef = String(body.head ?? "").replace(/^[^:]+:/, "");
      if (!headRef || !this.branchHead(repo, headRef)) return this.json(req, path, 422, { message: `head ${headRef} does not exist` });
      if (repo.prs.some((p) => p.headRef === headRef && p.state === "open")) return this.json(req, path, 422, { message: `A pull request already exists for ${headRef}` });
      const pr = this.addPr(`${repo.owner}/${repo.repo}`, { headRef, title: String(body.title ?? headRef), baseRef: String(body.base ?? "main"), draft: body.draft === true });
      return this.json(req, path, 201, this.prJson(repo, pr));
    }
    const pull = /^pulls\/(\d+)(\/merge)?$/.exec(rest);
    if (pull) {
      const pr = repo.prs.find((p) => p.number === Number(pull[1]));
      if (!pr) return this.json(req, path, 404, { message: "Not Found" });
      if (req.method === "GET" && !pull[2]) return this.json(req, path, 200, this.prJson(repo, pr));
      if (req.method === "PATCH" && !pull[2]) {
        if (typeof body.draft === "boolean") pr.draft = body.draft;
        if (body.state === "closed" || body.state === "open") pr.state = body.state;
        if (typeof body.base === "string") {
          if (pr.state !== "open" || pr.merged) return this.json(req, path, 422, { message: "Cannot change the base branch of a closed pull request." });
          if (repo.bare && !this.branchHead(repo, body.base)) return this.json(req, path, 422, { message: `Proposed base branch '${body.base}' was not found` });
          pr.baseRef = body.base;
        }
        return this.json(req, path, 200, this.prJson(repo, pr));
      }
      if (req.method === "PUT" && pull[2]) return this.merge(req, path, repo, pr, body);
    }
    const feedback = /^(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(rest);
    if (req.method === "GET" && feedback && !(feedback[1] === "issues" && feedback[3] === "reviews")) {
      const pr = repo.prs.find((p) => p.number === Number(feedback[2]));
      if (!pr) return this.json(req, path, 404, { message: "Not Found" });
      const kind = feedback[1] === "issues" ? "issue-comments" : (feedback[3] as "reviews" | "comments");
      return this.json(req, path, 200, this.page(url, this.feedbackJson(repo, pr, kind)));
    }
    const commit = /^commits\/([^/]+)\/(check-runs|status)$/.exec(rest);
    if (req.method === "GET" && commit) {
      const checks = repo.checks.get(commit[1]!) ?? repo.defaultChecks;
      if (commit[2] === "check-runs") {
        const runs = checks.filter((c) => !c.status).map((c) => {
          const id = this.checkRunId(`${repo.owner}/${repo.repo}`, commit[1]!, c.name);
          this.checkRuns.set(id, c);
          return {
            id,
            name: c.name,
            status: c.state === "pending" ? "in_progress" : "completed",
            conclusion: c.state === "pending" ? null : c.state === "green" ? "success" : "failure",
            app: { slug: "github-actions" },
            output: { title: null, summary: null, annotations_count: c.notStarted ? 2 : 0 },
          };
        });
        return this.json(req, path, 200, { total_count: runs.length, check_runs: runs });
      }
      const statuses = checks.filter((c) => c.status).map((c) => ({ context: c.name, state: c.state === "green" ? "success" : c.state === "red" ? "failure" : "pending" }));
      const state = statuses.some((s) => s.state === "failure") ? "failure" : statuses.some((s) => s.state === "pending") ? "pending" : "success";
      return this.json(req, path, 200, { state, total_count: statuses.length, statuses });
    }
    const annotations = /^check-runs\/(\d+)\/annotations$/.exec(rest);
    if (req.method === "GET" && annotations) {
      if (this.annotationsDown) return this.json(req, path, 500, { message: "Server Error" });
      const check = this.checkRuns.get(Number(annotations[1]));
      if (!check) return this.json(req, path, 404, { message: "Not Found" });
      const list = check.notStarted
        ? [
            { path: ".github", annotation_level: "failure", title: "", message: NOT_STARTED_MESSAGE },
            { path: ".github", annotation_level: "notice", title: "", message: "The ubuntu-latest label will migrate to a newer image." },
          ]
        : [];
      return this.json(req, path, 200, list);
    }
    return this.json(req, path, 404, { message: "Not Found" });
  }

  /** A stable id for a check run: the same check at the same head always gets the same one. */
  private checkRunId(repo: string, sha: string, name: string): number {
    return Number.parseInt(createHash("sha1").update(`${repo}@${sha}#${name}`).digest("hex").slice(0, 8), 16);
  }

  private merge(req: Request, path: string, repo: FakeRepo, pr: FakePr, body: Record<string, unknown>): Response {
    if (repo.mergeMode === "error-500") return this.json(req, path, 500, { message: "Server Error (fake)" });
    if (pr.merged || pr.state !== "open" || pr.pendingMerge) return this.json(req, path, 405, { message: "Pull Request is not mergeable" });
    if (pr.draft) return this.json(req, path, 405, { message: "Pull Request is still a draft" });
    if (repo.mergeMode === "refuse") return this.json(req, path, 405, { message: "Pull Request is not mergeable (fake)" });
    const head = this.headOf(repo, pr);
    if (typeof body.sha === "string" && body.sha !== head) return this.json(req, path, 409, { message: "Head branch was modified. Review and try the merge again." });
    const sha = this.land(repo, pr, head, String(body.merge_method ?? "merge"), String(body.commit_title ?? pr.title));
    if (sha === null) return this.json(req, path, 405, { message: "Pull Request is not mergeable: conflicts" });
    if (repo.mergeMode === "accept-unproven") {
      pr.pendingMerge = sha;
      return this.json(req, path, 200, { sha, merged: true, message: "Pull Request successfully merged" });
    }
    pr.merged = true;
    pr.state = "closed";
    pr.mergeSha = sha;
    pr.mergedAt = new Date().toISOString();
    if (repo.bare && repo.deleteBranchOnMerge) {
      gitSync(repo.bare, ["update-ref", "-d", `refs/heads/${pr.headRef}`]);
      // GitHub moves the open PRs into a branch it deletes on merge onto that PR's base.
      for (const other of repo.prs) if (other.state === "open" && other.baseRef === pr.headRef) other.baseRef = pr.baseRef;
    }
    return this.json(req, path, 200, { sha, merged: true, message: "Pull Request successfully merged" });
  }

  /** Land the head on the base branch of the bare repo: a squash (or rebase) commit, or a merge commit. */
  private land(repo: FakeRepo, pr: FakePr, head: string, method: string, title: string): string | null {
    if (!repo.bare) return createHash("sha1").update(`${repo.owner}/${repo.repo}#${pr.number}@${head}`).digest("hex");
    const base = gitSync(repo.bare, ["rev-parse", "--verify", `refs/heads/${pr.baseRef}^{commit}`]).out;
    const tree = gitSync(repo.bare, ["merge-tree", "--write-tree", base, head]);
    if (tree.code !== 0) return null;
    const treeSha = tree.out.split("\n")[0]!;
    const parents = method === "merge" ? ["-p", base, "-p", head] : ["-p", base];
    const commit = gitSync(repo.bare, ["commit-tree", treeSha, ...parents, "-m", `${title} (#${pr.number})`], IDENTITY);
    if (commit.code !== 0) return null;
    const moved = gitSync(repo.bare, ["update-ref", `refs/heads/${pr.baseRef}`, commit.out, base]);
    return moved.code === 0 ? commit.out : null;
  }
}
