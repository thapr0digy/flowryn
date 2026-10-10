import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPrUrl, GitHubForge, parsePrUrl, repoOf } from "../../src/forge/github.ts";
import { checksLine, ForgeError } from "../../src/forge/types.ts";
import { FakeGitHub, NOT_STARTED_MESSAGE } from "../helpers/fake-github.ts";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

let dir = "";
let fake: FakeGitHub;
let forge: GitHubForge;
let bare = "";
let clone = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fw-forge-"));
  bare = join(dir, "origin.git");
  clone = join(dir, "clone");
  git(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, ["clone", "-q", bare, clone]);
  writeFileSync(join(clone, "a.txt"), "a\n");
  git(clone, ["add", "."]);
  git(clone, ["commit", "-q", "-m", "init"]);
  git(clone, ["push", "-q", "origin", "HEAD:main"]);
  git(clone, ["checkout", "-q", "-b", "flowryn/t1"]);
  writeFileSync(join(clone, "b.txt"), "b\n");
  git(clone, ["add", "."]);
  git(clone, ["commit", "-q", "-m", "work"]);
  git(clone, ["push", "-q", "origin", "flowryn/t1"]);
  fake = await FakeGitHub.start();
  fake.addRepo("acme", "web", { bare });
  forge = new GitHubForge({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, token: async () => "t0ken" });
});

afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function openPr(title = "work"): Promise<number> {
  const response = await fetch(`${fake.apiUrl}/repos/acme/web/pulls`, { method: "POST", body: JSON.stringify({ title, head: "flowryn/t1", base: "main" }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { number: number }).number;
}

describe("GitHub forge client", () => {
  test("reads a pull request and follows its pushed head", async () => {
    const number = await openPr();
    const head = git(clone, ["rev-parse", "HEAD"]);
    const pr = await forge.pull({ owner: "acme", repo: "web", number });
    expect(pr).toMatchObject({ number, url: "https://github.com/acme/web/pull/1", state: "open", draft: false, headSha: head, headRef: "flowryn/t1", baseRef: "main", mergeSha: null });
    writeFileSync(join(clone, "c.txt"), "c\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-q", "-m", "more"]);
    git(clone, ["push", "-q", "origin", "flowryn/t1"]);
    expect((await forge.pull({ owner: "acme", repo: "web", number })).headSha).toBe(git(clone, ["rev-parse", "HEAD"]));
  });

  test("a check run carries its id, app and annotation count, and its annotations read back", async () => {
    await openPr();
    const head = git(clone, ["rev-parse", "HEAD"]);
    fake.setChecks("acme/web", head, [
      { name: "build", state: "red", notStarted: true },
      { name: "legacy", state: "red", status: true },
    ]);
    const summary = await forge.checks({ owner: "acme", repo: "web" }, head);
    const build = summary.checks.find((c) => c.name === "build")!;
    expect(build).toMatchObject({ state: "red", detail: "failure", app: "github-actions", annotations: 2 });
    expect(typeof build.id).toBe("number");
    expect(summary.checks.find((c) => c.name === "legacy")).toEqual({ name: "legacy", state: "red", detail: "failure" });
    expect(await forge.annotations({ owner: "acme", repo: "web" }, build.id!)).toEqual([
      { level: "failure", message: NOT_STARTED_MESSAGE },
      { level: "notice", message: "The ubuntu-latest label will migrate to a newer image." },
    ]);
    await expect(forge.annotations({ owner: "acme", repo: "web" }, 1)).rejects.toMatchObject({ kind: "not_found" });
  });

  test("an unchanged read is a 304 from the ETag cache", async () => {
    const number = await openPr();
    await forge.pull({ owner: "acme", repo: "web", number });
    await forge.pull({ owner: "acme", repo: "web", number });
    expect(forge.stats.notModified).toBe(1);
    expect(fake.requests.filter((r) => r.status === 304)).toHaveLength(1);
  });

  test("checks: check runs and commit statuses in one summary", async () => {
    await openPr();
    const head = git(clone, ["rev-parse", "HEAD"]);
    expect(checksLine(await forge.checks({ owner: "acme", repo: "web" }, head))).toBe("green (1)");
    fake.setChecks("acme/web", head, [
      { name: "ci/test", state: "green" },
      { name: "lint", state: "red" },
      { name: "deploy", state: "pending", status: true },
    ]);
    const summary = await forge.checks({ owner: "acme", repo: "web" }, head);
    expect(summary.state).toBe("red");
    expect(summary.checks.map((c) => `${c.name}:${c.state}`).toSorted()).toEqual(["ci/test:green", "deploy:pending", "lint:red"]);
    fake.setChecks("acme/web", head, []);
    expect((await forge.checks({ owner: "acme", repo: "web" }, head)).state).toBe("none");
  });

  test("lists a branch's pull requests", async () => {
    const number = await openPr();
    const list = await forge.pullsForBranch({ owner: "acme", repo: "web" }, "flowryn/t1");
    expect(list.map((p) => p.number)).toEqual([number]);
    expect(await forge.pullsForBranch({ owner: "acme", repo: "web" }, "other")).toEqual([]);
  });

  test("merges only at the named head, lands on the base branch, and then reads merged", async () => {
    const number = await openPr("ship it");
    const ref = { owner: "acme", repo: "web", number };
    await forge.pull(ref);
    const wrong = await forge.merge(ref, "0".repeat(40), "squash", "ship it").catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ForgeError);
    expect((wrong as ForgeError).kind).toBe("conflict");
    const head = git(clone, ["rev-parse", "HEAD"]);
    const merged = await forge.merge(ref, head, "squash", "ship it");
    expect(merged.merged).toBe(true);
    const after = await forge.pull(ref);
    expect(after.state).toBe("merged");
    expect(after.mergeSha).toBe(merged.sha);
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(merged.sha!);
    expect(git(bare, ["show", "main:b.txt"])).toBe("b");
  });

  test("an unreachable or rate-limited forge is a typed error", async () => {
    const number = await openPr();
    fake.unreachable = true;
    const down = await forge.pull({ owner: "acme", repo: "web", number }).catch((e: unknown) => e);
    expect((down as ForgeError).kind).toBe("unreachable");
    fake.unreachable = false;
    fake.rateLimited = true;
    const limited = await forge.pull({ owner: "acme", repo: "web", number: 99 }).catch((e: unknown) => e);
    expect((limited as ForgeError).kind).toBe("rate_limited");
    expect((limited as ForgeError).retryAt).toBeGreaterThan(Date.now());
    fake.rateLimited = false;
    const missing = await forge.pull({ owner: "acme", repo: "web", number: 99 }).catch((e: unknown) => e);
    expect((missing as ForgeError).kind).toBe("not_found");
  });

  test("repository and PR URLs", () => {
    for (const url of ["https://github.com/acme/web", "https://github.com/acme/web.git", "git@github.com:acme/web.git", "ssh://git@github.com/acme/web.git", "https://x-token@github.com/acme/web.git"]) {
      expect(repoOf(url)).toEqual({ owner: "acme", repo: "web" });
    }
    expect(repoOf("/tmp/origin.git")).toBeNull();
    expect(repoOf("https://gitlab.com/acme/web")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/web/pull/42")).toEqual({ owner: "acme", repo: "web", number: 42 });
    expect(parsePrUrl("https://github.com/acme/web/pull/42/files")).toEqual({ owner: "acme", repo: "web", number: 42 });
    expect(parsePrUrl("https://github.com/acme/web/issues/42")).toBeNull();
    expect(canonicalPrUrl({ owner: "acme", repo: "web", number: 7 })).toBe("https://github.com/acme/web/pull/7");
  });
});
