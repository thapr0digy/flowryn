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

describe("flowryn import firstmate: human only", () => {
  test("a non-human caller is refused before anything is read or cloned", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    let out = "";
    const io: CliIo = { env: { ...h.env, FLOWRYN_TOKEN: "sometoken" }, stdinIsTty: true, stdoutIsTty: true, json: true, stdout: (t) => (out += t), stderr: () => {} };
    const code = await importFirstmate(validateArgs(IMPORT_VERBS[0]!, { home: fm, "clone-root": clones, apply: true }), io);
    expect(code).not.toBe(0);
    const reply = JSON.parse(out) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("human_only");
    expect(existsSync(clones)).toBe(false);
  });

  test("a caller with neither stdin nor stdout a terminal is refused", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    let out = "";
    const io: CliIo = { env: h.env, stdinIsTty: false, stdoutIsTty: false, json: true, stdout: (t) => (out += t), stderr: () => {} };
    const code = await importFirstmate(validateArgs(IMPORT_VERBS[0]!, { home: fm, "clone-root": clones, apply: true }), io);
    expect(code).not.toBe(0);
    const reply = JSON.parse(out) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("human_only");
    expect(existsSync(clones)).toBe(false);
  });
});

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
    // "skip", "review" and "warn" rows (such as a dropped dependency on an unimported repo) are recomputed
    // from the Firstmate data on every run (they were never part of a plan the daemon tracks, so there is
    // nothing for a second run to report as existing); every row the daemon did track for a project, task
    // or decision must now read exists.
    const actions = (second.reply.data as { rows: { kind: string; action: string }[] }).rows
      .filter((r) => ["project", "task", "decision"].includes(r.kind) && !["skip", "review", "warn"].includes(r.action))
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
    expect(rows.some((r) => r.item === "alpha" && r.kind === "project")).toBe(false);
    // alpha's own queued task is never dropped silently (cutover C3 fix 4): --only filters it out of the
    // plan the same way an unimported repo does, and it shows as its own skip row, naming why.
    expect(rows.find((r) => r.item === "alpha-amend-q1")).toMatchObject({ kind: "task", action: "skip", reason: "repo alpha is not imported" });
    const alphaDecisions = rows.filter((r) => r.kind === "decision" && r.item.startsWith("alpha"));
    expect(alphaDecisions.length).toBeGreaterThan(0);
    for (const d of alphaDecisions) expect(d.action).not.toBe("create");
    expect(rows.some((r) => r.kind === "project" && r.item === "beta" && r.action === "create")).toBe(true);
  });

  test("an old clone already copied into --clone-root (a partial earlier run) is adopted, not re-cloned, and an empty database still creates its project, task and decision", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    cpSync(join(fm, "projects", "alpha"), join(clones, "alpha"), { recursive: true });
    const run = await runImport({ home: fm, "clone-root": clones, apply: true });
    expect(run.code).toBe(0);
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string }[] }).rows;
    expect(rows.some((r) => r.item === "alpha" && r.kind === "project" && r.action === "clone")).toBe(false);
    expect(rows.find((r) => r.item === "alpha" && r.kind === "project")).toMatchObject({ action: "create" });
    expect(rows.find((r) => r.item === "alpha-amend-q1" && r.kind === "task")).toMatchObject({ action: "create" });
    expect(rows.find((r) => r.item === "alpha-arch-r2-decision-retention" && r.kind === "decision")).toMatchObject({ action: "create" });
    expect(existsSync(join(clones, "alpha", ".git"))).toBe(true);
  });

  test("a queued task held in Firstmate still imports Queued, plus a warn row carrying the hold reason (truncated)", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const longReason = "waiting on the vendor to confirm the contract renewal before we touch any of this, seriously do not touch";
    const backlogPath = join(fm, "data", "backlog.md");
    const held = `- [ ] beta-held-q1 - Rework the cache (repo: beta) (kind: ship) (since 2026-09-17) (hold: ${longReason}) (hold-kind: captain)\n`;
    writeFileSync(backlogPath, readFileSync(backlogPath, "utf8").replace("## Done", `${held}## Done`));
    const run = await runImport({ home: fm, "clone-root": join(h.home, "clones") });
    const rows = (run.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
    expect(rows.find((r) => r.item === "beta-held-q1" && r.kind === "task" && r.action === "create")).toBeTruthy();
    const warning = rows.find((r) => r.item === "beta-held-q1" && r.action === "warn")!;
    expect(warning.reason.startsWith("held in Firstmate (")).toBe(true);
    expect(warning.reason).toContain(longReason.slice(0, 80));
    expect(warning.reason).not.toContain(longReason); // the full (longer) text never appears, only the 80-char prefix
    expect(warning.reason.endsWith("); not held here")).toBe(true);
  });

  test("a missing old clone is refused", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    writeFileSync(join(fm, "data", "projects.md"), readFileSync(join(fm, "data", "projects.md"), "utf8") + "- gamma [direct-PR] - No clone (added 2026-09-30)\n");
    const run = await runImport({ home: fm, "clone-root": join(h.home, "clones") });
    expect((run.reply.data as { rows: { item: string; action: string; reason: string }[] }).rows.find((r) => r.item === "gamma")).toMatchObject({ action: "refuse", reason: expect.stringContaining("no old clone") });
  });

  test("preferences.md is never overwritten once it exists: an edit in between two applies survives, and both runs report exists", async () => {
    h = makeHome();
    daemon = await startDaemon(h);
    const fm = fixtureHome();
    const clones = join(h.home, "clones");
    const first = await runImport({ home: fm, "clone-root": clones, apply: true });
    expect(first.code).toBe(0);
    const prefsPath = join(h.home, "leader", "preferences.md");
    const firstRows = (first.reply.data as { rows: { item: string; kind: string; action: string }[] }).rows;
    expect(firstRows.filter((r) => r.kind === "preferences").map((r) => r.action)).toEqual(["create", "create", "skip"]);
    writeFileSync(prefsPath, `${readFileSync(prefsPath, "utf8")}\n- my own added line\n`);
    const edited = readFileSync(prefsPath, "utf8");
    const dryAgain = await runImport({ home: fm, "clone-root": clones });
    const dryRows = (dryAgain.reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows.filter((r) => r.kind === "preferences");
    expect(dryRows.find((r) => r.item === "captain.md")).toMatchObject({ action: "exists", reason: "preferences.md already exists; edit it in place" });
    expect(readFileSync(prefsPath, "utf8")).toBe(edited);
    const second = await runImport({ home: fm, "clone-root": clones, apply: true });
    const secondRows = (second.reply.data as { rows: { item: string; kind: string; action: string }[] }).rows.filter((r) => r.kind === "preferences");
    expect(secondRows.find((r) => r.item === "captain.md")).toMatchObject({ action: "exists" });
    expect(secondRows.find((r) => r.item === "learnings.md")).toMatchObject({ action: "exists" });
    expect(readFileSync(prefsPath, "utf8")).toBe(edited);
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
