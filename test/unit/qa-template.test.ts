import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { workflowsConfig } from "../../src/config/workflows.ts";
import { checkQaPage, flowLine } from "../../src/lifecycle/stages.ts";
import { QA_CARD_SLOTS, QA_PLACEHOLDERS, QA_TEMPLATE, QA_TEMPLATE_FILE, qaPageProblems } from "../../src/skills/qa-template.ts";
import { STAGE_SKILLS, writeStageSkills } from "../../src/skills/stages.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-qa-"));
  dirs.push(dir);
  return dir;
}

function filled(verdict = "works", overrides: Record<string, string> = {}): string {
  let page = QA_TEMPLATE.replace("{{VERDICT}}", verdict);
  for (const slot of QA_PLACEHOLDERS) page = page.replaceAll(slot, overrides[slot] ?? "Said in plain words.");
  return page;
}

describe("the QA page's plain-language card", () => {
  test("the template opens with the four-slot card and folds the detail below it", () => {
    for (const slot of QA_PLACEHOLDERS) expect(QA_TEMPLATE).toContain(slot);
    for (const slot of QA_CARD_SLOTS) expect(QA_TEMPLATE).toContain(`data-slot="${slot}"`);
    const card = QA_TEMPLATE.indexOf("data-flowryn-card");
    expect(card).toBeGreaterThan(QA_TEMPLATE.indexOf("<body"));
    expect(QA_TEMPLATE.indexOf("<details")).toBeGreaterThan(card);
  });

  test("an unfilled template is refused, naming every blank slot", () => {
    const problems = qaPageProblems(QA_TEMPLATE);
    expect(problems[0]).toContain("{{WHAT_CHANGED}}");
    expect(problems[0]).toContain("{{RAW_OUTPUT}}");
    expect(problems.some((p) => p.includes("verdict must be"))).toBe(true);
  });

  test("a filled page passes, with each of the three verdicts", () => {
    for (const verdict of ["works", "works-with-caveats", "broken"]) expect(qaPageProblems(filled(verdict))).toEqual([]);
  });

  test("a verdict outside the three is refused", () => {
    expect(qaPageProblems(filled("probably-fine")).join()).toContain('data-verdict="works" | "works-with-caveats" | "broken"');
  });

  test("a slot with markup but no words is empty", () => {
    expect(qaPageProblems(filled("works", { "{{DECISIONS}}": "<ul><li> </li></ul>" }))).toEqual(["the card's decisions entry is empty; say it in words"]);
  });

  test("a page without the card is refused, and so is one that leads with detail", () => {
    expect(qaPageProblems("<html><body><h1>QA</h1><table><tr><td>49 cells</td></tr></table></body></html>").join()).toContain("no summary card");
    const leading = filled().replace("<h1>", "<pre>pytest: 792 passed</pre><h1>");
    expect(qaPageProblems(leading)).toEqual(["the summary card must open the page; move tables, screenshots, raw output and folded sections below it"]);
  });

  test("the gate-question widget may follow the card or sit inside its decisions entry", () => {
    const widget = '<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>';
    const after = filled("works", { "{{DECISIONS}}": "Answer the questions below." }).replace("</section>\n<details>", `</section>\n${widget}\n<details>`);
    expect(after).toContain(widget);
    expect(qaPageProblems(after)).toEqual([]);
    const inside = filled("works", { "{{DECISIONS}}": `Answer the questions here. ${widget}` });
    expect(qaPageProblems(inside)).toEqual([]);
  });

  test("a card missing a slot names it", () => {
    const page = filled().replace(/<dt>For you to decide<\/dt>\s*<dd data-slot="decisions">[^<]*<\/dd>/, "");
    expect(qaPageProblems(page)).toEqual(['the card has no decisions entry (<dd data-slot="decisions">)']);
  });
});

describe("the QA stage's page check", () => {
  test("stage done finds the page at qa/evidence.html; missing, a symlink, or unfilled is refused", () => {
    const dir = scratch();
    expect(() => checkQaPage(dir)).toThrow("no QA page");
    mkdirSync(join(dir, "qa"));
    writeFileSync(join(dir, "elsewhere.html"), filled());
    symlinkSync(join(dir, "elsewhere.html"), join(dir, "qa", "evidence.html"));
    expect(() => checkQaPage(dir)).toThrow("not a regular file");
    rmSync(join(dir, "qa", "evidence.html"));
    writeFileSync(join(dir, "qa", "evidence.html"), QA_TEMPLATE);
    expect(() => checkQaPage(dir)).toThrow("still blank");
    writeFileSync(join(dir, "qa", "evidence.html"), filled("works-with-caveats"));
    expect(() => checkQaPage(dir)).not.toThrow();
  });
});

describe("assumptions the design makes", () => {
  test("the template is written next to the QA skill's SKILL.md, in the state dir and in the Claude plugin", () => {
    const dir = scratch();
    const files = writeStageSkills(dir);
    for (const root of [files.root, join(files.claudePlugin, "skills")]) {
      expect(readFileSync(join(root, "flowryn-visual-qa", QA_TEMPLATE_FILE), "utf8")).toBe(QA_TEMPLATE);
    }
    // A skill body stays well inside 1.5k tokens (about 4 characters a token).
    for (const skill of STAGE_SKILLS) expect(skill.body.length).toBeLessThan(6000);
  });

  test("a config.toml that redefines feature and feature-ui still parses and wins over the built-ins", () => {
    const text = [
      "[workflows.feature]",
      'stages = [ { id = "design", skill = "flowryn-design", gate = "review" }, { id = "build", skill = "flowryn-build-test" }, { id = "ship", pools = ["validation"], gate = "merge" } ]',
      "[workflows.feature-ui]",
      'stages = [ { id = "design", skill = "flowryn-design", gate = "review" }, { id = "build" }, { id = "qa", skill = "flowryn-visual-qa", pools = ["docker_env", "browser"], gate = "review" }, { id = "ship", pools = ["validation"], gate = "merge" } ]',
    ].join("\n");
    const wf = workflowsConfig(parseConfig(text, "/tmp/fw-qa"));
    expect(flowLine(wf.feature!)).toBe("design (review) → build → ship (merge)");
    expect(wf["feature-ui"]!.stages[1]!.skill).toBeNull();
  });
});
