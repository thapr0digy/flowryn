import { runBounded } from "../runtime/bounded.ts";
import {
  summarize,
  ForgeError,
  type Annotation,
  type Check,
  type ChecksSummary,
  type FeedbackAuthor,
  type Forge,
  type IssueComment,
  type MergeResult,
  type PrFeedback,
  type PrRef,
  type PullRequest,
  type RepoRef,
  type Review,
  type ReviewComment,
  type ReviewThread,
} from "./types.ts";

/**
 * GitHub's REST API (v3, api version 2022-11-28) for the calls Flowryn makes:
 * read a pull request, list a branch's pull requests, read a head's check runs
 * and commit statuses, read a PR's reviews and comments, and merge at an
 * exact head; GraphQL only for review threads' resolution, which REST lacks. Reads are conditional
 * (ETag / If-None-Match): an unchanged answer is a 304 that costs no rate
 * limit, which keeps the watcher's poll cheap (design section 4). The base
 * URL is configurable, so tests, the cleanup-guard fixtures and the lab point
 * the same code at a local fake forge.
 */

export type TokenSource = () => Promise<string | null>;

export interface GitHubOptions {
  apiUrl: string;
  webUrl: string;
  token: TokenSource;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface Cached {
  etag: string;
  body: unknown;
}

const MAX_CACHE = 500;
const MAX_PAGES = 5;
const PER_PAGE = 100;
const GH_TOKEN_TIMEOUT_MS = 5_000;

/** https://github.com/o/r(.git), git@github.com:o/r(.git) or ssh://git@github.com/o/r(.git) -> {owner, repo}. */
export function repoOf(url: string, webUrl = "https://github.com"): RepoRef | null {
  const host = hostOf(webUrl);
  const patterns = [
    new RegExp(`^https?://(?:[^@/]+@)?${escape(host)}/([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`),
    new RegExp(`^(?:ssh://)?git@${escape(host)}[:/]([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

/** <web_url>/<owner>/<repo>/pull/<n>[/...] -> the PR it names. */
export function parsePrUrl(url: string, webUrl = "https://github.com"): PrRef | null {
  const match = new RegExp(`^${escape(webUrl.replace(/\/+$/, ""))}/([^/\\s]+)/([^/\\s]+)/pull/(\\d+)(?:[/?#].*)?$`).exec(url.trim());
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** The one spelling Flowryn records: <web_url>/<owner>/<repo>/pull/<n>. */
export function canonicalPrUrl(ref: PrRef, webUrl = "https://github.com"): string {
  return `${webUrl.replace(/\/+$/, "")}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

function hostOf(webUrl: string): string {
  return webUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A check run: completed with success, neutral or skipped is green; still running is pending; anything else is red. */
function checkRunState(run: { status?: unknown; conclusion?: unknown }): Check["state"] {
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped" ? "green" : "red";
}

/**
 * GitHub's GraphQL endpoint beside a REST base: Enterprise serves REST at
 * <host>/api/v3 and GraphQL at <host>/api/graphql; api.github.com (and the
 * fake forge) at <api_url>/graphql.
 */
export function graphqlUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  return base.endsWith("/api/v3") ? `${base.slice(0, -"/api/v3".length)}/api/graphql` : `${base}/graphql`;
}

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved comments(first:1){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}";

function authorOf(raw: { user?: { login?: unknown; type?: unknown } | null; author_association?: unknown }): FeedbackAuthor {
  return { login: str(raw.user?.login), bot: raw.user?.type === "Bot", association: str(raw.author_association) };
}

function idOf(raw: { id?: unknown }, what: string): number {
  if (typeof raw.id !== "number") throw new ForgeError("protocol", `${what} has no numeric id`);
  return raw.id;
}

function statusState(state: unknown): Check["state"] {
  if (state === "success") return "green";
  if (state === "pending") return "pending";
  return "red";
}

export class GitHubForge implements Forge {
  private readonly opts: GitHubOptions;
  private readonly cache = new Map<string, Cached>();
  private readonly fetcher: typeof fetch;

  constructor(opts: GitHubOptions) {
    this.opts = { ...opts, apiUrl: opts.apiUrl.replace(/\/+$/, ""), webUrl: opts.webUrl.replace(/\/+$/, "") };
    this.fetcher = opts.fetch ?? fetch;
  }

  /** Requests made and 304s answered, for the watcher's log and the tests. */
  readonly stats = { requests: 0, notModified: 0 };

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "flowryn", ...extra };
    const token = await this.opts.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async request(method: string, path: string, body?: unknown, url = `${this.opts.apiUrl}${path}`): Promise<{ status: number; body: unknown; headers: Headers }> {
    const cached = method === "GET" ? this.cache.get(url) : undefined;
    const headers = await this.headers(cached ? { "If-None-Match": cached.etag } : body === undefined ? {} : { "Content-Type": "application/json" });
    this.stats.requests++;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new ForgeError("unreachable", `${method} ${path}: ${(error as Error).message}`);
    }
    // The deadline covers the body too: a stalled body is a failed request, never a raw AbortError.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new ForgeError("unreachable", `${method} ${path}: reading the answer: ${(error as Error).message}`, response.status);
    }
    if (response.status === 304 && cached) {
      this.stats.notModified++;
      return { status: 200, body: cached.body, headers: response.headers };
    }
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new ForgeError("protocol", `${method} ${path}: the answer is not JSON`, response.status);
      }
    }
    if (response.ok && method === "GET") {
      const etag = response.headers.get("etag");
      if (etag) this.remember(url, { etag, body: parsed });
    }
    if (method !== "GET") this.forget(path);
    if (!response.ok) throw this.errorFor(method, path, response, parsed);
    return { status: response.status, body: parsed, headers: response.headers };
  }

  private remember(url: string, entry: Cached): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
  }

  /** A mutation invalidates every cached read of the same repository, so the next read sees it. */
  private forget(path: string): void {
    const repo = /^\/repos\/[^/]+\/[^/]+/.exec(path)?.[0];
    if (!repo) return;
    for (const url of this.cache.keys()) if (url.startsWith(`${this.opts.apiUrl}${repo}/`)) this.cache.delete(url);
  }

  private errorFor(method: string, path: string, response: Response, body: unknown): ForgeError {
    const message = `${method} ${path}: ${response.status} ${str((body as { message?: unknown } | null)?.message) || response.statusText}`;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? "");
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0))) {
      const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
      return new ForgeError("rate_limited", message, response.status, retryAt);
    }
    if (response.status === 404) return new ForgeError("not_found", message, 404);
    if (response.status === 401 || response.status === 403) return new ForgeError("auth", message, response.status);
    if (response.status === 409) return new ForgeError("conflict", message, 409);
    if (response.status === 405 || response.status === 422) return new ForgeError("refused", message, response.status);
    return new ForgeError("unreachable", message, response.status);
  }

  private toPull(raw: unknown): PullRequest {
    const pr = raw as Record<string, any> | null;
    if (!pr || typeof pr.number !== "number" || !pr.head || typeof pr.head.sha !== "string") throw new ForgeError("protocol", "a pull request answer is missing number or head.sha");
    const merged = pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at.length > 0);
    const base = pr.base?.repo?.full_name ? String(pr.base.repo.full_name).split("/") : [];
    const url = base.length === 2 ? `${this.opts.webUrl}/${base[0]}/${base[1]}/pull/${pr.number}` : str(pr.html_url);
    return {
      number: pr.number,
      url,
      title: str(pr.title),
      state: merged ? "merged" : pr.state === "open" ? "open" : "closed",
      draft: pr.draft === true,
      headSha: pr.head.sha,
      headRef: str(pr.head.ref),
      headRepo: str(pr.head.repo?.full_name),
      baseRef: str(pr.base?.ref),
      // An open PR's merge_commit_sha is GitHub's test merge, not a landing: only a merged PR's counts.
      mergeSha: merged && typeof pr.merge_commit_sha === "string" && pr.merge_commit_sha.length > 0 ? pr.merge_commit_sha : null,
      mergedAt: merged ? str(pr.merged_at) || null : null,
      // Only a single-PR answer carries it; a list answer and a closed PR read null.
      mergeable: !merged && pr.state === "open" && typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      ...(typeof pr.user?.login === "string" ? { author: pr.user.login } : {}),
    };
  }

  async pull(ref: PrRef): Promise<PullRequest> {
    const { body } = await this.request("GET", `/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls/${ref.number}`);
    return this.toPull(body);
  }

  async pullsForBranch(repo: RepoRef, branch: string): Promise<PullRequest[]> {
    const head = encodeURIComponent(`${repo.owner}:${branch}`);
    const { body } = await this.request("GET", `/repos/${enc(repo.owner)}/${enc(repo.repo)}/pulls?state=all&head=${head}&per_page=${PER_PAGE}&sort=created&direction=desc`);
    if (!Array.isArray(body)) throw new ForgeError("protocol", "a pull request list is not a list");
    return body.map((pr) => this.toPull(pr)).filter((pr) => pr.headRef === branch);
  }

  async checks(repo: RepoRef, sha: string): Promise<ChecksSummary> {
    const checks: Check[] = [];
    const base = `/repos/${enc(repo.owner)}/${enc(repo.repo)}/commits/${enc(sha)}`;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { body } = await this.request("GET", `${base}/check-runs?per_page=${PER_PAGE}&page=${page}`);
      const runs = (body as { check_runs?: unknown; total_count?: unknown } | null)?.check_runs;
      if (!Array.isArray(runs)) throw new ForgeError("protocol", "check runs answer has no check_runs list");
      for (const run of runs as { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; app?: { slug?: unknown } | null; output?: { annotations_count?: unknown } | null }[]) {
        const check: Check = { name: str(run.name) || "check", state: checkRunState(run), detail: str(run.conclusion) || str(run.status) };
        if (typeof run.id === "number") check.id = run.id;
        if (typeof run.app?.slug === "string") check.app = run.app.slug;
        if (typeof run.output?.annotations_count === "number") check.annotations = run.output.annotations_count;
        checks.push(check);
      }
      const total = Number((body as { total_count?: unknown }).total_count ?? runs.length);
      if (runs.length < PER_PAGE || checks.length >= total) break;
    }
    const { body } = await this.request("GET", `${base}/status`);
    const statuses = (body as { statuses?: unknown } | null)?.statuses;
    if (Array.isArray(statuses)) {
      for (const status of statuses as { context?: unknown; state?: unknown }[]) {
        checks.push({ name: str(status.context) || "status", state: statusState(status.state), detail: str(status.state) });
      }
    }
    return summarize(checks);
  }

  async annotations(repo: RepoRef, checkRunId: number): Promise<Annotation[]> {
    const { body } = await this.request("GET", `/repos/${enc(repo.owner)}/${enc(repo.repo)}/check-runs/${checkRunId}/annotations?per_page=${PER_PAGE}`);
    if (!Array.isArray(body)) throw new ForgeError("protocol", "an annotations answer is not a list");
    return (body as { annotation_level?: unknown; message?: unknown }[]).map((a) => ({ level: str(a.annotation_level), message: str(a.message) }));
  }

  async merge(ref: PrRef, sha: string, method: string, title: string): Promise<MergeResult> {
    const { body } = await this.request("PUT", `/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls/${ref.number}/merge`, { sha, merge_method: method, commit_title: title });
    const answer = body as { merged?: unknown; sha?: unknown; message?: unknown } | null;
    return { merged: answer?.merged === true, sha: typeof answer?.sha === "string" ? answer.sha : null, message: str(answer?.message) };
  }

  async setBase(ref: PrRef, base: string): Promise<PullRequest> {
    const { body } = await this.request("PATCH", `/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls/${ref.number}`, { base });
    return this.toPull(body);
  }

  /** Every item of a paged REST list, up to MAX_PAGES pages; each page is a conditional read. */
  private async list(path: string, what: string): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { body } = await this.request("GET", `${path}?per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(body)) throw new ForgeError("protocol", `${what} is not a list`);
      items.push(...(body as Record<string, any>[]));
      if (body.length < PER_PAGE) break;
    }
    return items;
  }

  async feedback(ref: PrRef): Promise<PrFeedback> {
    const repo = `/repos/${enc(ref.owner)}/${enc(ref.repo)}`;
    const [reviews, comments, issueComments] = await Promise.all([
      this.list(`${repo}/pulls/${ref.number}/reviews`, "a reviews answer"),
      this.list(`${repo}/pulls/${ref.number}/comments`, "a review comments answer"),
      this.list(`${repo}/issues/${ref.number}/comments`, "an issue comments answer"),
    ]);
    return {
      reviews: reviews.map(
        (r): Review => ({ id: idOf(r, "a review"), author: authorOf(r), state: str(r.state), body: str(r.body), at: str(r.submitted_at), url: str(r.html_url) }),
      ),
      reviewComments: comments.map(
        (c): ReviewComment => ({
          id: idOf(c, "a review comment"),
          author: authorOf(c),
          body: str(c.body),
          at: str(c.created_at),
          url: str(c.html_url),
          path: str(c.path),
          line: typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : null,
          inReplyTo: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
        }),
      ),
      issueComments: issueComments.map((c): IssueComment => ({ id: idOf(c, "an issue comment"), author: authorOf(c), body: str(c.body), at: str(c.created_at), url: str(c.html_url) })),
    };
  }

  async reviewThreads(ref: PrRef): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const variables = { owner: ref.owner, name: ref.repo, number: ref.number, after };
      const { body } = await this.request("POST", "/graphql", { query: REVIEW_THREADS_QUERY, variables }, graphqlUrl(this.opts.apiUrl));
      const answer = body as { data?: any; errors?: { type?: unknown; message?: unknown }[] } | null;
      if (Array.isArray(answer?.errors) && answer.errors.length > 0) {
        const first = answer.errors[0]!;
        throw new ForgeError(first.type === "NOT_FOUND" ? "not_found" : "protocol", `POST /graphql reviewThreads: ${str(first.message) || "an error"}`);
      }
      const connection = answer?.data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes)) throw new ForgeError("protocol", "a reviewThreads answer has no nodes list");
      for (const node of connection.nodes as { isResolved?: unknown; comments?: { nodes?: { databaseId?: unknown }[] } }[]) {
        const root = node.comments?.nodes?.[0]?.databaseId;
        threads.push({ resolved: node.isResolved === true, rootCommentId: typeof root === "number" ? root : null });
      }
      if (connection.pageInfo?.hasNextPage !== true || typeof connection.pageInfo?.endCursor !== "string") break;
      after = connection.pageInfo.endCursor;
    }
    return threads;
  }
}

function enc(part: string): string {
  return encodeURIComponent(part);
}

/**
 * The daemon's token: the first set variable in [github] token_env, else
 * `gh auth token` for the web host (the user's own gh login), read once and
 * kept. A token is only ever sent to GitHub's own API (api.github.com, or an
 * Enterprise API on the web host); an api_url anywhere else (the fake forge in
 * tests and the lab) gets none, so a credential never reaches it. No token is
 * fine too: a public repository answers without one.
 */
export function tokenSource(env: NodeJS.ProcessEnv, names: string[], gh: string | null, apiUrl: string, webUrl: string, ghTimeoutMs = GH_TOKEN_TIMEOUT_MS): TokenSource {
  const apiHost = hostOf(apiUrl);
  const webHost = hostOf(webUrl);
  const trusted = apiHost === "api.github.com" || apiHost === webHost;
  let cached: string | null | undefined;
  return async () => {
    if (!trusted) return null;
    for (const name of names) {
      const value = env[name];
      if (value && value.length > 0) return value;
    }
    if (cached !== undefined) return cached;
    cached = null;
    if (!gh) return null;
    const result = await runBounded([gh, "auth", "token", "--hostname", webHost], { label: "gh auth token", timeoutMs: ghTimeoutMs, stderr: "ignore" });
    if (result.code === 0 && result.stdout.trim().length > 0) cached = result.stdout.trim();
    return cached;
  };
}
