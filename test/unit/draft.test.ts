import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../../src/policy/landed.ts";
import { checkDraftPage, draftPageDigest, draftPagePath, draftPathOfPage, readDraft, renderDraftBody, renderDraftPage, requireDraftPageShown } from "../../src/lifecycle/draft.ts";
import { GIT_ENV, sh } from "../helpers/scratch-git.ts";

/** Notes projects' drafts (docs/notes/2026-10-30-notes-projects-non-8d.md): the file, its page, and the check between them. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git: GitRunner = async (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, ...GIT_ENV } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

function worktree(): { wt: string; reports: string } {
  const root = mkdtempSync(join(tmpdir(), "fl-draft-"));
  dirs.push(root);
  const wt = join(root, "wt");
  mkdirSync(wt);
  sh(wt, ["init", "-q", "-b", "main"]);
  const reports = join(root, "reports");
  mkdirSync(reports);
  return { wt, reports };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("draft files", () => {
  test("a Markdown or text file inside the worktree, with the blob a commit of it stores", async () => {
    const { wt } = worktree();
    mkdirSync(join(wt, "plans"));
    writeFileSync(join(wt, "plans", "q4.md"), "# Q4\n\nShip notes.\n");
    const draft = await readDraft(git, wt, "plans/q4.md");
    expect(draft).toMatchObject({ path: "plans/q4.md", text: "# Q4\n\nShip notes.\n" });
    sh(wt, ["add", "."]);
    sh(wt, ["commit", "-q", "-m", "q4"]);
    expect(draft.blob).toBe(sh(wt, ["rev-parse", "HEAD:plans/q4.md"]));
    expect((await readDraft(git, wt, join(wt, "plans", "q4.md"))).path).toBe("plans/q4.md");
  });

  test("a symlink, a path outside the worktree or in .git, another format, a missing or oversized file is refused", async () => {
    const { wt, reports } = worktree();
    writeFileSync(join(reports, "outside.md"), "x");
    symlinkSync(join(reports, "outside.md"), join(wt, "link.md"));
    writeFileSync(join(wt, "page.html"), "<p>x</p>");
    writeFileSync(join(wt, "big.md"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(wt, "latin1.md"), Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    for (const [raw, said] of [
      ["link.md", "symlink"],
      [join(reports, "outside.md"), "outside your worktree"],
      ["../reports/outside.md", "outside your worktree"],
      [".git/HEAD", "inside .git"],
      ["page.html", "not a Markdown"],
      ["big.md", "over 1 MB"],
      ["nope.md", "no file"],
      ["latin1.md", "not valid UTF-8"],
    ] as const) {
      const refused = await failure(readDraft(git, wt, raw));
      expect(refused.code).toBe("draft_invalid");
      expect(refused.message).toContain(said);
    }
  });
});

describe("the draft page", () => {
  test("assumption: raw HTML in a Markdown draft is shown as text, in a span and in a block", () => {
    const html = renderDraftBody("a.md", 'Hi <script>alert(1)</script> *there*\n\n<div onclick="x">block</div>\n\n<img src=x onerror=alert(1)>\n');
    expect(html).toContain("<em>there</em>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<div");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("plain text is shown as it is, escaped", () => {
    expect(renderDraftBody("a.txt", "a < b & *c*\n")).toBe('<pre class="plain">a &lt; b &amp; *c*\n</pre>\n');
  });

  test("the same file renders the same bytes; the page names its file and mounts the question widget", () => {
    const draft = { path: 'odd "name" <x>.md', text: "# T\n", blob: "a".repeat(40) };
    const page = renderDraftPage(draft);
    expect(renderDraftPage(draft)).toBe(page);
    expect(page).toContain('<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>');
    expect(page).toContain("data-lavish-live-reload-root");
    expect(draftPathOfPage(page)).toBe(draft.path);
    expect(draftPathOfPage("<html><body>a design</body></html>")).toBeNull();
  });

  test("stage done's check: the page must be the file as it is now, never edited by hand", async () => {
    const { wt, reports } = worktree();
    writeFileSync(join(wt, "note.md"), "first\n");
    const page = draftPagePath(reports);
    mkdirSync(join(reports, "draft"));
    writeFileSync(page, renderDraftPage(await readDraft(git, wt, "note.md")));
    expect((await checkDraftPage(git, wt, page, reports)).path).toBe("note.md");

    writeFileSync(join(wt, "note.md"), "second\n");
    const stale = await failure(checkDraftPage(git, wt, page, reports));
    expect(stale.code).toBe("draft_page_invalid");
    expect(stale.message).toContain("as it is now");

    writeFileSync(page, renderDraftPage(await readDraft(git, wt, "note.md")).replace("second", "something else"));
    expect((await failure(checkDraftPage(git, wt, page, reports))).code).toBe("draft_page_invalid");

    const other = join(reports, "draft", "other.html");
    writeFileSync(other, renderDraftPage(await readDraft(git, wt, "note.md")));
    expect((await failure(checkDraftPage(git, wt, other, reports))).message).toContain("a draft's review page is");
  });

  test("a gate passes only while its page is the one stage done checked", async () => {
    const { wt, reports } = worktree();
    writeFileSync(join(wt, "note.md"), "first\n");
    const draft = await readDraft(git, wt, "note.md");
    const page = draftPagePath(reports);
    mkdirSync(join(reports, "draft"));
    writeFileSync(page, renderDraftPage(draft));
    const gate = { id: "g1", page_path: page, draft_page: draftPageDigest(draft) };
    const run = { task_id: "t1" };
    expect(() => requireDraftPageShown(run, gate)).not.toThrow();
    expect(() => requireDraftPageShown(run, { id: "g2", page_path: page, draft_page: null })).not.toThrow();

    writeFileSync(join(wt, "note.md"), "second\n");
    writeFileSync(page, renderDraftPage(await readDraft(git, wt, "note.md")));
    expect(() => requireDraftPageShown(run, gate)).toThrow(expect.objectContaining({ code: "draft_changed" }));
    rmSync(page);
    expect(() => requireDraftPageShown(run, gate)).toThrow(expect.objectContaining({ code: "draft_changed" }));
  });
});
