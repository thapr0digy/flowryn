import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { GitRunner } from "../policy/landed.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { sha256Hex } from "../util/hash.ts";
import { reportDirFor } from "./launcher.ts";
import { getRunWithPolicy, isTerminal, type RunWithPolicy } from "./runs.ts";

/**
 * Notes projects' drafts (docs/notes/2026-10-30-notes-projects-non-8d.md).
 * A draft stage's review page is not written by the worker: Flowryn renders
 * it from one file in the run's worktree, with fixed markup, so the page the
 * user approves shows that file's bytes. `stage done` renders the file again
 * and refuses a page that differs; the gate keeps the file's git blob, and
 * the delivery must carry that blob at the same path.
 */

export const DRAFT_SKILL = "flowryn-draft";
/** The draft page, under the run's $FLOWRYN_REPORT_DIR. */
export const DRAFT_PAGE = join("draft", "draft.html");
export const DRAFT_MAX_BYTES = 1024 * 1024;
const MARKDOWN = new Set([".md", ".markdown"]);
const PLAIN = new Set([".txt"]);

export interface DraftFile {
  /** The path inside the worktree, with forward slashes. */
  path: string;
  text: string;
  /** `git hash-object` of the file: what a commit of it stores. */
  blob: string;
}

/**
 * Read a draft: a regular file inside the worktree (a symlink, a path outside
 * it or inside .git is refused), Markdown or plain text, at most 1 MB, with
 * its git blob.
 */
export async function readDraft(git: GitRunner, worktree: string, raw: string): Promise<DraftFile> {
  const root = realpathSync(worktree);
  const given = isAbsolute(raw) ? raw : join(root, raw);
  let st;
  try {
    st = lstatSync(given);
  } catch {
    throw new FlowrynError("draft_invalid", `no file ${raw} in your worktree`, "name the draft by its path from the worktree's top level");
  }
  if (st.isSymbolicLink()) throw new FlowrynError("draft_invalid", `${raw} is a symlink; name the file itself`);
  if (!st.isFile()) throw new FlowrynError("draft_invalid", `${raw} is not a regular file`);
  const real = realpathSync(given);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new FlowrynError("draft_invalid", `${raw} is outside your worktree`);
  const path = rel.split(sep).join("/");
  if (path === ".git" || path.startsWith(".git/")) throw new FlowrynError("draft_invalid", `${raw} is inside .git`);
  const ext = extname(path).toLowerCase();
  if (!MARKDOWN.has(ext) && !PLAIN.has(ext)) throw new FlowrynError("draft_invalid", `${raw} is not a Markdown (.md, .markdown) or text (.txt) file`);
  if (st.size > DRAFT_MAX_BYTES) throw new FlowrynError("draft_invalid", `${raw} is over 1 MB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
  } catch {
    throw new FlowrynError("draft_invalid", `${raw} is not valid UTF-8`, "save the draft as UTF-8, then render it again");
  }
  const hashed = await git(["hash-object", "--", path], root);
  const blob = hashed.stdout.trim();
  if (hashed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(blob)) throw new FlowrynError("draft_invalid", `git cannot hash ${path}: ${hashed.stderr.trim() || `exit ${hashed.code}`}`);
  return { path, text, blob };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The file's body as HTML: Markdown with any raw HTML shown as text, or plain text as it is. */
export function renderDraftBody(path: string, text: string): string {
  if (MARKDOWN.has(extname(path).toLowerCase())) return Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true });
  return `<pre class="plain">${escapeHtml(text)}</pre>\n`;
}

const STYLE = `:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#66635c;--card:#fff;--line:#e3e0d8;--acc:#2f6f5e;--code:#f1efe8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161614;--fg:#ecebe6;--mut:#a29f97;--card:#1f1f1c;--line:#34332f;--acc:#7cc4ad;--code:#262624}}
:root[data-theme="dark"]{--bg:#161614;--fg:#ecebe6;--mut:#a29f97;--card:#1f1f1c;--line:#34332f;--acc:#7cc4ad;--code:#262624}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:820px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:1.5rem}.sub{color:var(--mut);margin:0 0 20px}
section[data-section="ask"]{border:2px solid var(--acc);border-radius:10px;padding:4px 18px 10px;background:var(--card);margin-bottom:28px}
section[data-section="ask"] h2{color:var(--acc);font-size:1.1rem}
article{overflow-wrap:anywhere}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:6px 8px}
code,pre{background:var(--code);border-radius:4px;font-size:.9em}code{padding:1px 5px}pre{padding:10px;overflow-x:auto;white-space:pre-wrap}
blockquote{border-left:3px solid var(--line);margin-left:0;padding-left:14px;color:var(--mut)}`;

/**
 * The draft review page: fixed markup around the rendered file. The same
 * file always renders the same bytes, which is how `stage done` checks it.
 * The question widget is mounted always; without questions its script is
 * simply absent.
 */
export function renderDraftPage(draft: Pick<DraftFile, "path" | "text" | "blob">): string {
  const path = escapeHtml(draft.path);
  return `<!doctype html>
<html lang="en" data-lavish-live-reload-root><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft: ${path}</title>
<style>
${STYLE}
</style></head><body>
<h1>Draft: ${path}</h1>
<p class="sub">The file below is exactly what lands once you approve it (git blob ${draft.blob.slice(0, 12)}).</p>
<section data-section="ask">
<h2>What I need from you</h2>
<p>Approve this draft, or send changes in your own words.</p>
<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>
</section>
<article data-flowryn-draft="${path}" data-flowryn-blob="${draft.blob}">
${renderDraftBody(draft.path, draft.text)}</article>
</body></html>
`;
}

/** The draft page's path for a run's task. */
export function draftPagePath(reportDir: string): string {
  return join(reportDir, DRAFT_PAGE);
}

/** Where the draft a page shows lives, read from its fixed markup; null when the page is not a draft page. */
export function draftPathOfPage(html: string): string | null {
  const match = /<article data-flowryn-draft="([^"]*)" data-flowryn-blob="[0-9a-f]+">/.exec(html);
  if (!match) return null;
  return match[1]!.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

/**
 * At a draft stage's `stage done`: the page must be the draft page, exactly
 * as the file in the worktree renders now. Returns the file it showed.
 */
export async function checkDraftPage(git: GitRunner, worktree: string, page: string, reportDir: string): Promise<DraftFile> {
  const rendered = draftPagePath(reportDir);
  if (!existsSync(rendered)) throw new FlowrynError("draft_page_invalid", `no draft page at ${rendered}`, "$FLOWRYN_BIN draft render <file>, host that page, then stage done");
  const expected = realpathSync(rendered);
  if (realpathSync(page) !== expected) throw new FlowrynError("draft_page_invalid", `a draft's review page is ${expected}`, "$FLOWRYN_BIN draft render <file>, host that page, then stage done");
  const html = readFileSync(expected, "utf8");
  const path = draftPathOfPage(html);
  if (path === null) throw new FlowrynError("draft_page_invalid", `${expected} is not a rendered draft`, "$FLOWRYN_BIN draft render <file>");
  const draft = await readDraft(git, worktree, path);
  if (renderDraftPage(draft) !== html) {
    throw new FlowrynError("draft_page_invalid", `${expected} does not show ${path} as it is now`, `$FLOWRYN_BIN draft render ${path}, then stage done again (the page must never be edited by hand)`);
  }
  return draft;
}

/** What a draft review gate keeps of the page `stage done` checked. */
export function draftPageDigest(draft: Pick<DraftFile, "path" | "text" | "blob">): string {
  return sha256Hex(renderDraftPage(draft));
}

/**
 * Before a draft review gate passes: its page must still be the one `stage
 * done` checked, so the user approved the draft the gate keeps.
 */
export function requireDraftPageShown(run: Pick<RunWithPolicy, "task_id">, gate: { id: string; page_path?: string | null; draft_page?: string | null }): void {
  if (!gate.draft_page) return;
  let shown: string | null = null;
  try {
    if (gate.page_path) shown = sha256Hex(readFileSync(gate.page_path));
  } catch {
    shown = null;
  }
  if (shown === gate.draft_page) return;
  throw new FlowrynError(
    "draft_changed",
    `the page of gate ${gate.id} no longer shows the draft its review opened with`,
    `send it back so the worker renders the draft and opens a new review: flowryn gate changes ${run.task_id} --body-file -`,
  );
}

/** The draft the run's last passed review gate approved, if any. */
export function approvedDraft(db: Db, runId: string): { gate: string; path: string; blob: string } | null {
  const row = db
    .query("SELECT id, draft_path, draft_blob FROM gates WHERE run_id = ?1 AND kind = 'review' AND state = 'passed' AND draft_blob IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 1")
    .get(runId) as { id: string; draft_path: string; draft_blob: string } | null;
  return row ? { gate: row.id, path: row.draft_path, blob: row.draft_blob } : null;
}

/**
 * At delivery: a run that passed a draft review delivers that file as
 * approved. Its committed blob at HEAD must be the approved one, and the
 * branch must change no other path since it forked from the default branch.
 */
export async function requireApprovedDraft(db: Db, git: GitRunner, run: RunWithPolicy, defaultBranch: string): Promise<void> {
  const approved = approvedDraft(db, run.id);
  if (!approved) return;
  const shown = await git(["rev-parse", "--verify", "--quiet", `HEAD:${approved.path}`], run.worktree_path);
  const blob = shown.code === 0 ? shown.stdout.trim() : null;
  if (blob === approved.blob) return requireOnlyDraftChanged(git, run, defaultBranch, approved);
  throw new FlowrynError(
    "draft_changed",
    blob === null ? `${approved.path}, approved at ${approved.gate}, is not committed on your branch` : `${approved.path} differs from the draft approved at ${approved.gate}`,
    blob === null ? `commit ${approved.path} as approved, then deliver again` : `restore ${approved.path} to the approved text (git blob ${approved.blob.slice(0, 12)}), commit, then deliver again; a change needs a new review`,
  );
}

async function requireOnlyDraftChanged(git: GitRunner, run: RunWithPolicy, defaultBranch: string, approved: { gate: string; path: string }): Promise<void> {
  const diff = await git(["diff", "--name-only", "--no-renames", "-z", `refs/heads/${defaultBranch}...HEAD`], run.worktree_path);
  if (diff.code !== 0) throw new FlowrynError("draft_changed", `cannot list what your branch changes against ${defaultBranch}: ${diff.stderr.trim() || `exit ${diff.code}`}`);
  const others = diff.stdout.split("\0").filter((path) => path !== "" && path !== approved.path);
  if (others.length === 0) return;
  throw new FlowrynError(
    "draft_changed",
    `your branch changes ${others.join(", ")} besides ${approved.path}, approved at ${approved.gate}; only the approved draft lands`,
    "drop those changes from your branch (only the approved file may differ from where it forks from the default branch), then deliver again; another change needs its own review",
  );
}

/** A draft under review stays as the user sees it: a revision waits for the verdict. */
function draftableRun(db: Db, runId: string | null): RunWithPolicy {
  const run = runId ? getRunWithPolicy(db, runId) : null;
  if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
  if (run.stage_state === "review") {
    throw new FlowrynError("wrong_stage", `stage ${run.stage} is under review; its draft page stays as the user sees it`, "answer on the page with $FLOWRYN_BIN review reply --body-file -; once the review sends changes back, edit the file and render it again");
  }
  return run;
}

/** `flowryn draft render <file>`: write the draft review page for one file in your worktree. */
const draftRender: VerbSpec = {
  name: "draft render",
  summary: "Render one Markdown or text file in your worktree as the draft review page; host that page, then stage done",
  positionals: [{ name: "file", required: true, help: "the draft, by its path from the worktree's top level" }],
  flags: {},
  kind: "mutation",
  roles: ["worker"],
  async prepare(ctx, args) {
    const run = draftableRun(ctx.db, ctx.caller.runId);
    return readDraft(ctx.delivery.git, run.worktree_path, stringArg(args, "file")!);
  },
  apply(ctx, _args, prepared) {
    const run = draftableRun(ctx.db, ctx.caller.runId);
    const draft = prepared as DraftFile;
    const page = draftPagePath(reportDirFor(ctx.config(), run.task_id));
    ensureDir(join(page, ".."), 0o755);
    writeFileAtomic(page, renderDraftPage(draft), 0o644);
    appendEvent(ctx.db, { source: "cli", kind: "draft.rendered", runId: run.id, taskId: run.task_id, payload: { path: draft.path, blob: draft.blob, page }, ts: ctx.now() });
    return {
      data: { draft: draft.path, blob: draft.blob, page },
      hints: [`lavish-axi --no-open ${page}`, `$FLOWRYN_BIN stage done --review <its url> --page ${page}`],
    };
  },
};

export const DRAFT_VERBS: VerbSpec[] = [draftRender];
