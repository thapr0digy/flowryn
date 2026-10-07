import { createHash } from "node:crypto";

/**
 * A fake GitHub for tests, the cleanup-guard fixtures and the lab: the REST
 * calls Flowryn makes (src/forge/github.ts), answered from memory, with ETags
 * and 304s like GitHub. A repository can be backed by a local bare git repo
 * (its "origin"): then a PR's head follows the pushed branch, as on GitHub,
 * and a merge really lands on the bare repo's base branch (a squash or a
 * merge commit), so the cleanup guard sees what it would see after a real
 * merge. Knobs make the forge unreachable, rate limited, or accept a merge it
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
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  /** Set by an accepted-but-unproven merge; `prove()` makes it read merged. */
  pendingMerge: string | null;
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
  readonly webUrl: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextNumber = 1;
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
  addPr(fullName: string, pr: Partial<FakePr> & { headRef: string; headSha?: string }): FakePr {
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
      state: pr.state ?? "open",
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      mergedAt: pr.mergedAt ?? (pr.merged ? "2026-06-26T00:00:00Z" : null),
      mergeSha: pr.mergeSha ?? null,
      pendingMerge: null,
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

  private prJson(repo: FakeRepo, pr: FakePr): Record<string, unknown> {
    const full = `${repo.owner}/${repo.repo}`;
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
      head: { ref: pr.headRef, sha: this.headOf(repo, pr), repo: { full_name: full } },
      base: { ref: pr.baseRef, repo: { full_name: full } },
    };
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
    if (this.unreachable) {
      this.requests.push({ method: req.method, path, status: 503 });
      return new Response(JSON.stringify({ message: "Service Unavailable (fake)" }), { status: 503 });
    }
    if (this.rateLimited) {
      return this.json(req, path, 403, { message: "API rate limit exceeded (fake)" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60) });
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
        return this.json(req, path, 200, this.prJson(repo, pr));
      }
      if (req.method === "PUT" && pull[2]) return this.merge(req, path, repo, pr, body);
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
    if (repo.bare && repo.deleteBranchOnMerge) gitSync(repo.bare, ["update-ref", "-d", `refs/heads/${pr.headRef}`]);
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
