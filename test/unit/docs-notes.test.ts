import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STAGE_SKILLS } from "../../src/skills/stages.ts";
import { SKILL_BODY } from "../../src/bridges/skill.ts";
import { FROZEN_DOCS, NOTES_DIR, headings, parseNote, readNotes, renderIndex, type Note } from "../../scripts/docs/notes.ts";

/**
 * Per-feature notes (docs/notes/README.md): every PR writes its own file, and
 * the shared docs every PR used to append to are frozen, so two PRs that add
 * different features touch disjoint docs files.
 */

const REPO = resolve(import.meta.dir, "../..");

/** The headings of each frozen file as of the freeze. A fix in place keeps them; a new section belongs in docs/notes/. */
const FROZEN_HEADINGS: Record<(typeof FROZEN_DOCS)[number], string[]> = {
  "docs/m1-notes.md": [
    "# M1 notes",
    "## Roles in M1",
    "## The intent journal",
    "## The backlog watcher",
    "## To-dos",
    "## Daemon, service and setup",
  ],
  "docs/m2-notes.md": [
    "# M2 notes",
    "## The Herdr runtime",
    "## Worker adapters",
    "## Dispatch, runs and the worker verbs",
    "## Steers",
    "## The reconciler",
    "## Contract suites",
    "## Tests",
    "## Live runs",
  ],
  "docs/m3-notes.md": [
    "# M3 notes",
    "## Leader sessions and the lease",
    "## Presentations",
    "## The Claude leader bridge (M3a)",
    "## The Pi leader bridge (M3b)",
    "## Attention",
    "## To-dos",
    "## The board",
    "## Config",
    "## Tests",
    "## Live runs",
  ],
  "docs/m4-notes.md": [
    "# M4 notes",
    "## The forge",
    "## Delivery",
    "## The watchers",
    "## Approvals",
    "## The merge gate",
    "## Cleanup",
    "## The fixture sets",
    "## Protocol and version",
    "## Tests",
    "## Live runs",
  ],
  "docs/m5-notes.md": [
    "# M5 notes",
    "## Workflows and stages",
    "## Review gates",
    "## Plans and autonomy",
    "## Capacity pools and the host check",
    "## Docker label evidence",
    "## The Claude usage limit",
    "## The style block and the stage skills",
    "## Notifications: on in your setup, never from tests or live runs",
    "## Protocol and version",
    "## Tests",
    "## Live runs",
    "## The v1 completion pass",
    "### The harness version gate (sections 5 and 16)",
    "### Divergences (section 8)",
    "### The invariant pass (section 8)",
    "### Scouts land with their report (section 8)",
    "### `flowryn promote` (sections 4 and 12)",
    "### Herdr unreachable (section 16)",
    "### GitHub unavailable or rate-limited (section 16)",
    "### The contract suite's host check",
    "### The contract suite pins its harness",
    "### The contract suite waits for Pi's long command",
    "### Protocol and version",
    "### Tests",
    "### Live run",
    "## Idle workers (2026-10-05 fixes)",
    "## Turn-end guard (autonomy spec 2, ship A)",
    "## Gate questions",
    "### One Send, Other, anything else, request pass",
    "### Protocol and version",
    "## Plain-language QA pages and feature-ui (2026-10-05)",
    "## Worker questions wake the leader",
    "## Away mode (autonomy spec 2, ship B)",
    "## Toolkit rules (toolkit enforcement, ship 1)",
    "## Questions stored whole",
    "## Leader contract checks",
    "## Offline contract test",
    "## Automatic restarts (spec 3, phase 1)",
    "## Worker reports reach the leader",
    "## Automatic contract checks (spec 3, phase 2)",
    "## Leader Stop items and restarts past CI",
  ],
  "docs/cutover-notes.md": [
    "# Cutover notes",
    "## C1 · Decisions",
    "## Approval channels · routine merges",
    "## Approval channels · red-check waivers from the leader",
    "## Approval channels · contract records from the leader",
    "## C2 · Prompt wedges",
    "## C3 · Import (removed)",
    "## Steers · latency (Tier 0 and Tier 1)",
    "## Steers · urgent (Tier 2)",
    "## Worker workspaces",
    "## Leader-safe daemon restart",
    "## Live runs",
    "### The cutover live run",
    "### The import dry run (removed)",
  ],
  "docs/v1-status.md": [
    "# Flowryn v1 status",
    "## CI is off (2026-10-07)",
    "## The milestone items (section 17)",
    "## Other v1 items of the design",
    "## Cutover",
    "## Not in v1",
  ],
};

const DONE = "# Away mode\n\n- Status: done\n\nBody.\n";

describe("the docs/notes files", () => {
  test("every file has a dated kebab-case name, a title and a valid Status line", () => {
    const bad = readNotes(join(REPO, NOTES_DIR)).flatMap((r) => (r.ok ? [] : [`${r.file}: ${r.problems.join("; ")}`]));
    expect(bad).toEqual([]);
  });

  test.each([...FROZEN_DOCS])("%s gains no new heading (new work goes in docs/notes/)", (file) => {
    const now = headings(readFileSync(join(REPO, file), "utf8"));
    const added = now.filter((h) => !FROZEN_HEADINGS[file].includes(h));
    if (added.length > 0) throw new Error(`${file} is frozen: move ${JSON.stringify(added)} into its own file under ${NOTES_DIR}/ (see ${NOTES_DIR}/README.md)`);
    expect(now).toEqual(FROZEN_HEADINGS[file]);
  });
});

describe("parseNote", () => {
  test("reads the title, status, open line and config keys", () => {
    const r = parseNote("2026-10-06-away-mode-bb.md", "# Away mode\n\n- Status: partial\n- Open: not run live\n- Config: `[away] max_wakes_per_hour`, `[away] default_hours`\n\n- a body bullet\n");
    expect(r).toEqual({ ok: true, note: { file: "2026-10-06-away-mode-bb.md", date: "2026-10-06", slug: "away-mode-bb", title: "Away mode", status: "partial", open: "not run live", config: ["[away] max_wakes_per_hour", "[away] default_hours"] } });
  });

  test.each([
    ["away-mode.md", DONE, "the name must be"],
    ["2026-10-06-Away_Mode.md", DONE, "the name must be"],
    ["2026-13-45-away.md", DONE, "is not a date"],
    ["2026-10-06-away.md", "Away mode\n\n- Status: done\n", "the first line must be the title"],
    ["2026-10-06-away.md", "# Away mode\n\nBody.\n", "a `- Status: done|partial|not built` line"],
    ["2026-10-06-away.md", "# Away mode\n\n- Status: shipped\n", 'Status "shipped" is not one of'],
    ["2026-10-06-away.md", "# Away mode\n\n- Status: partial\n", "needs an `- Open: <what is left>` line"],
    ["2026-10-06-away.md", "# Away mode\n\n- Status: done\n- Status: done\n", "the Status line appears twice"],
    ["2026-10-06-away.md", "# Away mode\n\n- Status: done\n- Config: away keys\n", "lists its keys in backticks"],
    ["2026-10-06-away.md", "# Away mode\n\nIntro.\n\n- Status: done\n", "a `- Status:"],
  ])("rejects %s with %j", (file, text, problem) => {
    const r = parseNote(file, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain(problem);
  });

  test("ignores the notes README", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    try {
      writeFileSync(join(dir, "README.md"), "no header\n");
      writeFileSync(join(dir, "2026-10-06-a.md"), DONE);
      expect(readNotes(dir).map((r) => r.ok)).toEqual([true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderIndex", () => {
  const note = (file: string, extra: Partial<Note> = {}): Note => ({ file, date: file.slice(0, 10), slug: file.slice(11, -3), title: file.slice(11, -3), status: "done", open: null, config: [], ...extra });
  const notes = [note("2026-10-01-a.md"), note("2026-10-09-c.md", { status: "partial", open: "a | b", config: ["[x] y"] }), note("2026-10-05-b.md")];

  test("lists newest first, with the PR, the open line and the config keys", () => {
    const out = renderIndex(notes, (n) => (n.slug === "a" ? 12 : null));
    expect(out).toBe(
      [
        "| Date | Feature | Status | PR | Config |",
        "|---|---|---|---|---|",
        "| 2026-10-09 | [c](docs/notes/2026-10-09-c.md) | partial; open: a \\| b |  | `[x] y` |",
        "| 2026-10-05 | [b](docs/notes/2026-10-05-b.md) | done |  |  |",
        "| 2026-10-01 | [a](docs/notes/2026-10-01-a.md) | done | #12 |  |",
        "",
      ].join("\n"),
    );
  });

  test("gives the same bytes for the same notes in any order", () => {
    const prOf = () => 7;
    expect(renderIndex(notes.toReversed(), prOf)).toBe(renderIndex(notes, prOf));
  });
});

describe("the layout under git", () => {
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  const must = (cwd: string, ...args: string[]) => {
    const r = git(cwd, ...args);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };

  /** Two branches off one base, each changing the tree its own way, then merged: true when the merge is clean. */
  function mergesCleanly(change: (dir: string, branch: "a" | "b") => void): boolean {
    const dir = mkdtempSync(join(tmpdir(), "notes-git-"));
    try {
      must(dir, "init", "-q");
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs/shared.md"), "# Shared\n\n## One\n\nText.\n");
      must(dir, "add", "-A");
      must(dir, "commit", "-qm", "base");
      for (const branch of ["a", "b"] as const) {
        must(dir, "checkout", "-qb", branch, "main");
        mkdirSync(join(dir, "docs/notes"), { recursive: true });
        change(dir, branch);
        must(dir, "add", "-A");
        must(dir, "commit", "-qm", branch);
      }
      must(dir, "checkout", "-q", "a");
      return git(dir, "merge", "-q", "--no-edit", "b").exitCode === 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("two PRs that each add their own notes file merge without a conflict", () => {
    expect(mergesCleanly((dir, b) => writeFileSync(join(dir, `docs/notes/2026-10-10-feature-${b}.md`), `# Feature ${b}\n\n- Status: done\n`))).toBe(true);
  });

  test("two PRs that each append a section to one shared file conflict (what the layout removes)", () => {
    expect(mergesCleanly((dir, b) => writeFileSync(join(dir, "docs/shared.md"), `# Shared\n\n## One\n\nText.\n\n## Feature ${b}\n\nNotes.\n`))).toBe(false);
  });
});

describe("where the rule reaches workers and the leader", () => {
  test("the build skill sends docs where the project's AGENTS.md says, as a new file when it says so", () => {
    expect(STAGE_SKILLS.find((s) => s.name === "flowryn-build-test")!.body).toContain("Write the docs the change needs where the project's AGENTS.md or CLAUDE.md says, as a new file when it says so.");
  });

  test("the leader skill points a ship brief at the project's docs rule, never at a shared notes file", () => {
    expect(SKILL_BODY).toContain("For docs, point the worker at the project's AGENTS.md rule; never name a shared notes file.");
  });

  test("AGENTS.md names the per-feature layout and no longer says to extend the latest notes file", () => {
    const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    expect(agents).toContain("`docs/notes/<yyyy-mm-dd>-<task id>.md`");
    expect(agents).not.toContain("Extend the latest one");
  });
});
