import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateArgs, type CliIo } from "../../src/api/verbs.ts";
import { IMPORT_VERBS, importFirstmate } from "../../src/cli/commands/import.ts";
import { makeOriginRepo } from "../helpers/fleet-env.ts";
import { makeHome, REPO_ROOT, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let daemon: DaemonProc;
afterEach(async () => {
  await daemon?.kill9().catch(() => {});
  h?.cleanup();
});

/** A copy of the fixture home whose old clones point at local bare origins. */
function fixtureHome(): string {
  const fm = join(h.home, "fm");
  cpSync(join(REPO_ROOT, "fixtures/firstmate-home"), fm, { recursive: true, filter: (src) => !src.endsWith("expected-plan.json") });
  for (const name of ["alpha", "beta"]) {
    const { repo } = makeOriginRepo(join(h.home, "origins", name));
    cpSync(repo, join(fm, "projects", name), { recursive: true });
  }
  return fm;
}

/**
 * Run the command in-process as your own terminal: cliJson's subprocess has
 * no TTY, so the daemon would see an anonymous caller and refuse import.apply.
 */
async function runImport(argv: { home: string; "clone-root"?: string; apply?: boolean; only?: string[] }): Promise<{ code: number; reply: { data: Record<string, unknown> } }> {
  let out = "";
  const io: CliIo = { env: h.env, stdinIsTty: true, stdoutIsTty: true, json: true, stdout: (t) => (out += t), stderr: () => {} };
  const code = await importFirstmate(validateArgs(IMPORT_VERBS[0]!, argv), io);
  return { code, reply: out ? JSON.parse(out) : { data: {} } };
}

describe("flowryn import firstmate", () => {
  test("the dry run matches the golden plan and changes nothing", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const dry = await runImport({ home: fm, "clone-root": join(h.home, "clones") });
    expect(dry.code).toBe(0);
    const rows = (dry.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows.map((r) => ({ ...r, reason: r.reason.replaceAll(h.home, "<home>") }));
    expect(rows).toEqual(JSON.parse(readFileSync(join(REPO_ROOT, "fixtures/firstmate-home/expected-plan.json"), "utf8")));
    expect(existsSync(join(h.home, "clones"))).toBe(false);
  });

  test("apply clones, records, writes preferences; a second apply changes nothing; an existing clone of the same origin is adopted", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    const first = await runImport({ home: fm, "clone-root": clones, apply: true });
    expect(first.code).toBe(0);
    expect(existsSync(join(clones, "alpha", ".git"))).toBe(true);
    expect(readFileSync(join(h.home, "leader", "preferences.md"), "utf8")).toContain("## Review");
    const second = await runImport({ home: fm, "clone-root": clones, apply: true });
    // "skip" and "review" decision rows are recomputed from the Firstmate archive on every run (they were
    // never part of a plan the daemon tracks, so there is nothing for a second run to report as existing);
    // every row the daemon did track for a project, task or decision must now read exists.
    const actions = (second.reply.data as { rows: { kind: string; action: string }[] }).rows
      .filter((r) => ["project", "task", "decision"].includes(r.kind) && !["skip", "review"].includes(r.action))
      .map((r) => r.action);
    expect(new Set(actions)).toEqual(new Set(["exists"]));
  });

  test("a target whose origin differs is refused, and the other project still imports", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    const other = makeOriginRepo(join(h.home, "elsewhere"));
    cpSync(other.repo, join(clones, "alpha"), { recursive: true });
    const run = await runImport({ home: fm, "clone-root": clones, apply: true });
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string }[] }).rows;
    const project = (item: string) => rows.filter((r) => r.kind === "project" && r.item === item).pop();
    // alpha's refusal is the only row for it (the command never hands it to the daemon); beta gets a
    // "clone" row from the command and then the daemon's own "create" row, in that order.
    expect(project("alpha")!.action).toBe("refuse");
    expect(project("beta")!.action).toBe("create");
  });

  test("an old clone origin that looks like a git option is refused, not passed to git", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const marker = join(h.home, "pwned");
    const configured = Bun.spawnSync(["git", "config", "remote.origin.url", `--upload-pack=touch ${marker}`], { cwd: join(fm, "projects", "alpha"), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(configured.exitCode).toBe(0);
    const clones = join(h.home, "clones");
    const run = await runImport({ home: fm, "clone-root": clones, apply: true });
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
    const alpha = rows.filter((r) => r.kind === "project" && r.item === "alpha").pop();
    expect(alpha).toMatchObject({ action: "refuse" });
    expect(alpha!.reason).toContain("not a repository URL");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(clones, "alpha"))).toBe(false);
    const beta = rows.filter((r) => r.kind === "project" && r.item === "beta").pop();
    expect(beta).toMatchObject({ action: "create" });
  });

  test("--only limits the plan to the named project; the other project's work is neither recorded nor imported as open", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const run = await runImport({ home: fm, "clone-root": join(h.home, "clones"), only: ["beta"] });
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
    expect(rows.some((r) => r.item === "alpha" && (r.kind === "project" || r.kind === "task"))).toBe(false);
    expect(rows.some((r) => r.item === "alpha-amend-q1")).toBe(false);
    const alphaDecisions = rows.filter((r) => r.kind === "decision" && r.item.startsWith("alpha"));
    expect(alphaDecisions.length).toBeGreaterThan(0);
    for (const d of alphaDecisions) expect(d.action).not.toBe("create");
    expect(rows.some((r) => r.kind === "project" && r.item === "beta" && r.action === "create")).toBe(true);
  });

  test("a missing old clone is refused", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    writeFileSync(join(fm, "data", "projects.md"), readFileSync(join(fm, "data", "projects.md"), "utf8") + "- gamma [direct-PR] - No clone (added 2026-09-30)\n");
    const run = await runImport({ home: fm, "clone-root": join(h.home, "clones") });
    expect((run.reply.data as { rows: { item: string; action: string; reason: string }[] }).rows.find((r) => r.item === "gamma")).toMatchObject({ action: "refuse", reason: expect.stringContaining("no old clone") });
  });

  test("a done-archive.md captain answer resolves an open decision the same way note-archive.md does", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    writeFileSync(
      join(fm, "data", "done-archive.md"),
      [
        "## Archived 2026-09-25",
        "- [x] alpha-arch-r3-decision-retention - Confirm the retention plan (repo: alpha) (kind: captain) (done 2026-09-25) (hold: retention) (hold-kind: captain)",
        "  Origin: alpha-arch-r3",
        "  Decision key: retention",
        "  Captain decision:",
        "  approve",
        "",
      ].join("\n"),
    );
    const run = await runImport({ home: fm, "clone-root": join(h.home, "clones") });
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
    const retention = rows.find((r) => r.item === "alpha-arch-r2-decision-retention");
    expect(retention).toMatchObject({ kind: "decision", action: "skip", reason: "resolved (alpha-arch-r3-decision-retention is done)" });
  });
});
