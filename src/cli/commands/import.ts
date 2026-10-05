import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorReply, okReply } from "../../api/envelope.ts";
import { serverVerb } from "../../api/registry.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { flowrynHome } from "../../config/paths.ts";
import { leaderDir } from "../../bridges/files.ts";
import { ensureDir, writeFileAtomic } from "../../util/fsx.ts";
import { isDecisionItem, mapMode, parseItems, parseProjects, projectOf, selectDecisions } from "../../import/firstmate.ts";
import type { ImportPlan, PlanRow } from "../../import/apply.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { callServerVerb } from "../client.ts";
import { notHumanReason } from "../human.ts";

/**
 * `flowryn import firstmate <home>` (cutover C3): read a Firstmate home and
 * bring its projects, queued work, open decisions and your preferences into
 * Flowryn. A dry run by default; --apply clones each project fresh from its
 * old clone's origin into --clone-root, writes ~/.flowryn/leader/preferences.md
 * and records the rest through the daemon. It never writes to the Firstmate
 * home, and it prints, never runs, the commands that repoint ~/.local/bin.
 */

type Row = Omit<PlanRow, "kind" | "action"> & { kind: PlanRow["kind"] | "preferences" | "links"; action: PlanRow["action"] | "skip" | "clone" | "review" };

const FIRSTMATE_MACHINERY = /\b(captain|fm-[a-z-]+\.sh|bin\/fm-|firstmate|secondmate|crewmate)\b/i;

function git(args: string[], cwd?: string): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: (r.exitCode === 0 ? r.stdout : r.stderr).toString().trim() };
}

function read(home: string, file: string): string | null {
  const path = join(home, "data", file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export async function importFirstmate(args: Parameters<NonNullable<VerbSpec["local"]>>[0], io: CliIo): Promise<number> {
  // Refuse a non-human caller before reading or cloning anything (an agent pane, never a plain terminal
  // run): the daemon's own import.apply role check runs only after the CLI has already cloned.
  const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
  if (reason) {
    const out = errorReply({ code: "human_only", message: `import firstmate runs only in your own terminal: ${reason}` });
    io.stdout(renderReply(out, { json: io.json }));
    return exitCodeOf(out);
  }
  const fm = resolve(stringArg(args, "home")!);
  const apply = boolArg(args, "apply");
  const cloneRoot = resolve(stringArg(args, "clone-root") ?? join(io.env.HOME ?? "~", "projects"));
  const only = new Set((args.only as string[] | undefined) ?? []);
  const projectsText = read(fm, "projects.md");
  if (!projectsText) {
    io.stderr(`error: ${fm} has no data/projects.md; is it a Firstmate home?\n`);
    return 4;
  }
  const rows: Row[] = [];
  const plan: ImportPlan = { projects: [], tasks: [], decisions: [] };
  for (const p of parseProjects(projectsText)) {
    if (only.size > 0 && !only.has(p.name)) continue;
    if (p.mode === "local-only") {
      rows.push({ item: p.name, kind: "project", action: "skip", reason: "local-only, not migrated" });
      continue;
    }
    const old = join(fm, "projects", p.name);
    if (!existsSync(join(old, ".git"))) {
      rows.push({ item: p.name, kind: "project", action: "refuse", reason: `no old clone at ${old}` });
      continue;
    }
    const origin = git(["-C", old, "remote", "get-url", "origin"]);
    if (origin.code !== 0) {
      rows.push({ item: p.name, kind: "project", action: "refuse", reason: `${old} has no origin` });
      continue;
    }
    // A hostile old clone's origin could be "-"-prefixed (e.g. --upload-pack=<cmd>), which git would parse
    // as an option rather than a repository argument; refuse it outright, and also pass "--" below so a
    // value that slips past this check (or a future caller of `git`) still can't be read as a flag.
    if (origin.out.startsWith("-")) {
      rows.push({ item: p.name, kind: "project", action: "refuse", reason: `${old} has an origin that is not a repository URL` });
      continue;
    }
    const target = join(cloneRoot, p.name);
    if (existsSync(target)) {
      const there = git(["-C", target, "remote", "get-url", "origin"]);
      if (there.code !== 0 || there.out !== origin.out) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `${target} exists and is not a clone of ${origin.out}` });
        continue;
      }
    } else {
      rows.push({ item: p.name, kind: "project", action: "clone", reason: `${old} origin into ${target}` });
      if (apply) {
        const cloned = git(["clone", "-q", "--", origin.out, target]);
        if (cloned.code !== 0) {
          rows.push({ item: p.name, kind: "project", action: "refuse", reason: `clone failed: ${cloned.out}` });
          continue;
        }
      }
    }
    plan.projects.push({ name: p.name, path: target, mode: mapMode(p.mode), yolo: p.yolo });
  }
  const imported = new Set(plan.projects.map((p) => p.name));
  const backlog = parseItems(read(fm, "backlog.md") ?? "");
  // Decisions are selected before the task loop below, not after: a task's `blocked-by` may name a
  // Firstmate captain/decision item's own id, and only `picked.decisions` (what import.apply will turn
  // into a real decision) and `picked.skipped` (what has already landed) say what to do with that edge.
  // The done-archive carries resolved captain answers too (C3 ruling): its items join the archive set so
  // an answer that moved there before import still resolves the open decision it answers, instead of the
  // decision being imported as if it were still open.
  const noteArchive = parseItems(read(fm, "note-archive.md") ?? "");
  const doneArchive = parseItems(read(fm, "done-archive.md") ?? "");
  const picked = selectDecisions(backlog, [...noteArchive, ...doneArchive], imported);
  plan.decisions = picked.decisions;
  const decisionIds = new Set(picked.decisions.map((d) => d.id));
  const landedDecisionIds = new Set(picked.skipped.filter((s) => s.reason.startsWith("resolved")).map((s) => s.id));

  /** Why a `blocked-by` reference this import cannot use as a task blocker was dropped. */
  function blockerDropReason(dep: string): string {
    const blocker = backlog.find((b) => b.id === dep);
    if (!blocker) return "not found";
    if (blocker.checked) return "already done in Firstmate";
    if (isDecisionItem(blocker)) return "a Firstmate decision this import does not create";
    if (blocker.section !== "queued") return `not queued in Firstmate (${blocker.section})`;
    return `repo ${blocker.tags.repo ?? "-"} is not imported`;
  }

  for (const item of backlog) {
    if (item.checked || isDecisionItem(item)) continue;
    if (item.section === "in flight") {
      rows.push({ item: item.id, kind: "task", action: "skip", reason: "in flight in Firstmate" });
      continue;
    }
    if (item.section !== "queued") continue;
    const project = projectOf(item.tags.repo, imported);
    if (!project) {
      rows.push({ item: item.id, kind: "task", action: "skip", reason: `repo ${item.tags.repo ?? "-"} is not imported` });
      continue;
    }
    const kind = item.tags.kind === "scout" ? "scout" : "ship";
    const blockedBy: string[] = [];
    for (const raw of (item.tags["blocked-by"] ?? "").split(",").filter(Boolean)) {
      const dep = picked.supersededBy.get(raw) ?? raw;
      if (decisionIds.has(dep)) {
        // A decision this import creates: import.apply remaps this to the decision's real task id once
        // it exists (its id is only known at apply time), so the raw Firstmate item id passes through.
        blockedBy.push(dep);
      } else if (backlog.some((b) => b.id === dep && !b.checked && !isDecisionItem(b) && b.section === "queued" && projectOf(b.tags.repo, imported))) {
        blockedBy.push(dep); // another plan task; import.apply resolves create/exists/refuse and ordering
      } else if (landedDecisionIds.has(dep)) {
        // Already answered in Firstmate (resolved by another decision's own copy): the blocker has
        // effectively landed, so the edge is simply dropped, same as any other landed blocker — no warning.
      } else {
        rows.push({ item: item.id, kind: "task", action: "warn", reason: `blocked-by ${raw} dropped: ${blockerDropReason(dep)}` });
      }
    }
    plan.tasks.push({ id: item.id, project, kind, title: item.title, body: [item.title, ...item.body].join("\n"), priority: item.tags.priority ? Number(item.tags.priority) : null, blockedBy });
    if (item.tags.hold) {
      rows.push({ item: item.id, kind: "task", action: "warn", reason: `held in Firstmate (${item.tags.hold.slice(0, 80)}); not held here` });
    }
  }
  const reply = await callServerVerb(serverVerb("import.apply")!, { plan: JSON.stringify(plan), dry: !apply }, io);
  if (!reply.ok) {
    io.stderr(`error: ${reply.error?.message ?? "the daemon refused the import"}\n`);
    return reply.exitCode;
  }
  rows.push(...(reply.data.rows as Row[]));
  for (const s of picked.skipped) rows.push({ item: s.id, kind: "decision", action: "skip", reason: s.reason });
  for (const r of picked.review) rows.push({ item: r.id, kind: "decision", action: "review", reason: r.reason });
  // The leader's own preferences.md is never overwritten once it exists: the leader keeps it current by
  // hand, and a re-run (or --apply after a dry run the user already edited the file from) must not clobber
  // that edit. Both dry and real runs report the same `exists` row, so a dry run previews this truthfully.
  const prefs = join(leaderDir(flowrynHome(io.env)), "preferences.md");
  const prefsExist = existsSync(prefs);
  const keep: string[] = [];
  const review: string[] = [];
  for (const file of ["captain.md", "learnings.md", "captain-shared.md"]) {
    const text = read(fm, file);
    if (text === null) {
      rows.push({ item: file, kind: "preferences", action: "skip", reason: "absent" });
      continue;
    }
    if (prefsExist) {
      rows.push({ item: file, kind: "preferences", action: "exists", reason: "preferences.md already exists; edit it in place" });
      continue;
    }
    const lines = text.split("\n").filter((l) => l.trim().startsWith("-"));
    const flagged = lines.filter((l) => FIRSTMATE_MACHINERY.test(l));
    keep.push(...lines.filter((l) => !flagged.includes(l)));
    review.push(...flagged);
    rows.push({ item: file, kind: "preferences", action: "create", reason: `${lines.length} line${lines.length === 1 ? "" : "s"}, ${flagged.length} for review` });
  }
  if (apply && !prefsExist && (keep.length > 0 || review.length > 0)) {
    ensureDir(leaderDir(flowrynHome(io.env)), 0o700);
    writeFileAtomic(prefs, ["# Your preferences", "", "Imported from Firstmate. The leader keeps this file current: inspect, then update.", "", ...keep, "", "## Review", "", "These name Firstmate machinery; keep, reword or delete them.", "", ...review, ""].join("\n"), 0o600);
  }
  const fw = join(cloneRoot, "flowryn");
  rows.push({ item: "links", kind: "links", action: "review", reason: `after apply: cd ${fw} && bun install && bun run build && ln -sf ${fw}/dist/flowryn ~/.local/bin/flowryn && ln -sf ${fw}/dist/flowryn ~/.local/bin/flowrynd && flowryn daemon uninstall && flowryn daemon install` });
  const out = okReply({ rows });
  io.stdout(renderReply(out, { json: io.json }));
  return exitCodeOf(out);
}

export const IMPORT_VERBS: VerbSpec[] = [
  {
    name: "import firstmate",
    summary: "Bring a Firstmate home's projects, queued work, open decisions and preferences into Flowryn (dry run unless --apply)",
    positionals: [{ name: "home", required: true, help: "the Firstmate home, such as ~/projects/firstmate" }],
    flags: {
      apply: { type: "boolean", help: "clone, write and record (default: print the plan only)" },
      "clone-root": { type: "string", help: "where fresh clones go (default ~/projects)", placeholder: "dir" },
      only: { type: "list", help: "import only these projects (repeatable)", placeholder: "project" },
    },
    kind: "local",
    roles: ["human"],
    local: importFirstmate,
  },
];
