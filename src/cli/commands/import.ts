import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { okReply } from "../../api/envelope.ts";
import { serverVerb } from "../../api/registry.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { flowrynHome } from "../../config/paths.ts";
import { leaderDir } from "../../bridges/files.ts";
import { ensureDir, writeFileAtomic } from "../../util/fsx.ts";
import { mapMode, parseItems, parseProjects, projectOf, selectDecisions } from "../../import/firstmate.ts";
import type { ImportPlan, PlanRow } from "../../import/apply.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { callServerVerb } from "../client.ts";

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
        const cloned = git(["clone", "-q", origin.out, target]);
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
  for (const item of backlog) {
    if (item.checked || item.tags.kind === "captain" || item.tags.kind === "decision") continue;
    const project = projectOf(item.tags.repo, imported);
    if (item.section === "in flight") {
      rows.push({ item: item.id, kind: "task", action: "skip", reason: "in flight in Firstmate" });
      continue;
    }
    if (item.section !== "queued" || !project) continue;
    const kind = item.tags.kind === "scout" ? "scout" : "ship";
    const blockedBy = (item.tags["blocked-by"] ?? "").split(",").filter((d) => d && backlog.some((b) => b.id === d && b.section === "queued" && projectOf(b.tags.repo, imported)));
    plan.tasks.push({ id: item.id, project, kind, title: item.title, body: [item.title, ...item.body].join("\n"), priority: item.tags.priority ? Number(item.tags.priority) : null, blockedBy });
  }
  // The done-archive carries resolved captain answers too (C3 ruling): its items join the archive set so
  // an answer that moved there before import still resolves the open decision it answers, instead of the
  // decision being imported as if it were still open.
  const noteArchive = parseItems(read(fm, "note-archive.md") ?? "");
  const doneArchive = parseItems(read(fm, "done-archive.md") ?? "");
  const picked = selectDecisions(backlog, [...noteArchive, ...doneArchive], imported);
  plan.decisions = picked.decisions;
  const reply = await callServerVerb(serverVerb("import.apply")!, { plan: JSON.stringify(plan), dry: !apply }, io);
  if (!reply.ok) {
    io.stderr(`error: ${reply.error?.message ?? "the daemon refused the import"}\n`);
    return reply.exitCode;
  }
  rows.push(...(reply.data.rows as Row[]));
  for (const s of picked.skipped) rows.push({ item: s.id, kind: "decision", action: "skip", reason: s.reason });
  for (const r of picked.review) rows.push({ item: r.id, kind: "decision", action: "review", reason: r.reason });
  const keep: string[] = [];
  const review: string[] = [];
  for (const file of ["captain.md", "learnings.md", "captain-shared.md"]) {
    const text = read(fm, file);
    if (text === null) {
      rows.push({ item: file, kind: "preferences", action: "skip", reason: "absent" });
      continue;
    }
    const lines = text.split("\n").filter((l) => l.trim().startsWith("-"));
    const flagged = lines.filter((l) => FIRSTMATE_MACHINERY.test(l));
    keep.push(...lines.filter((l) => !flagged.includes(l)));
    review.push(...flagged);
    rows.push({ item: file, kind: "preferences", action: "create", reason: `${lines.length} line${lines.length === 1 ? "" : "s"}, ${flagged.length} for review` });
  }
  if (apply && (keep.length > 0 || review.length > 0)) {
    const dir = leaderDir(flowrynHome(io.env));
    ensureDir(dir, 0o700);
    const prefs = join(dir, "preferences.md");
    writeFileAtomic(prefs, ["# Your preferences", "", "Imported from Firstmate. The leader keeps this file current: inspect, then update.", "", ...keep, "", "## Review", "", "These name Firstmate machinery; keep, reword or delete them.", "", ...review, ""].join("\n"), 0o600);
  }
  const fw = join(cloneRoot, "flowryn");
  rows.push({ item: "links", kind: "links", action: "review", reason: `after apply: cd ${fw} && bun install && bun run build && ln -sf ${fw}/dist/flowryn ~/.local/bin/flowryn && ln -sf ${fw}/dist/flowryn ~/.local/bin/flowrynd` });
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
