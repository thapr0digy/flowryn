#!/usr/bin/env bun
/**
 * Flowryn's cleanup guard in the fixtures' implementation contract
 * (fixtures/cleanup-guard/README.md): `landed-impl.ts <scenario-dir>` reads
 * scenario.json, serves forge.json from the fake GitHub (so the guard talks
 * to it through the same REST client the daemon uses), runs the guard, and
 * prints one JSON verdict.
 *
 *   fixtures/cleanup-guard/run.sh --impl "bun $PWD/scripts/guard/landed-impl.ts"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubForge } from "../../src/forge/github.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { forgePrHead, judgeCleanup } from "../../src/policy/landed.ts";
import { FakeGitHub } from "../../test/helpers/fake-github.ts";

interface Scenario {
  operation: "cleanup" | "record_pr";
  delivery_mode: "no-mistakes" | "direct-PR" | "local-only";
  task_branch: string;
  default_branch: string;
  paths: { worktree: string; forge: string };
  inputs: {
    kind: "ship" | "scout";
    recorded_pr_url: string | null;
    pr_url_to_record: string | null;
    discard_approval: { action?: string; channel?: string } | null;
  };
}

interface ForgeData {
  repo: string;
  reachable: boolean;
  pull_requests: { number: number; headRefName: string; state: string; headRefOid: string; mergedAt: string | null; mergeCommit: { oid: string } | null }[];
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: landed-impl.ts <scenario-dir>");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(process.env.FLOWRYN_SCENARIO ?? join(dir, "scenario.json"), "utf8")) as Scenario;
const data = JSON.parse(readFileSync(process.env.FLOWRYN_FAKE_FORGE ?? scenario.paths.forge, "utf8")) as ForgeData;

const fake = await FakeGitHub.start();
try {
  const [owner, repo] = data.repo.split("/") as [string, string];
  fake.addRepo(owner, repo);
  for (const pr of data.pull_requests) {
    const merged = pr.state === "MERGED";
    fake.addPr(data.repo, {
      number: pr.number,
      headRef: pr.headRefName,
      headSha: pr.headRefOid,
      state: pr.state === "OPEN" ? "open" : "closed",
      merged,
      mergedAt: pr.mergedAt,
      mergeSha: pr.mergeCommit?.oid ?? null,
    });
  }
  fake.unreachable = !data.reachable;
  const forge = new GitHubForge({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, token: async () => null, timeoutMs: 5_000 });
  const git = gitRunner(Bun.which("git") ?? "git");
  if (scenario.operation === "record_pr") {
    const url = scenario.inputs.pr_url_to_record!;
    const head = await forgePrHead(url, { forge, webUrl: fake.webUrl });
    console.log(JSON.stringify({ verdict: "record", reason_class: "forge_pr_head", recorded_pr_head: head, pr_url: url }));
  } else {
    const approval = scenario.inputs.discard_approval;
    const result = await judgeCleanup(
      {
        mode: scenario.delivery_mode,
        kind: scenario.inputs.kind,
        worktree: scenario.paths.worktree,
        branch: scenario.task_branch,
        defaultBranch: scenario.default_branch,
        repo: { owner, repo },
        recordedPrUrl: scenario.inputs.recorded_pr_url,
        discardApproved: approval?.action === "discard" && approval.channel === "human",
      },
      { git, forge, webUrl: fake.webUrl },
    );
    console.log(JSON.stringify({ verdict: result.verdict, reason_class: result.reason, recorded_pr_head: null, pr_url: result.prUrl, detail: result.detail }));
  }
} finally {
  await fake.stop();
}
