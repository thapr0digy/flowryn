import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { VERSION } from "../version.ts";
import { QA_TEMPLATE, QA_TEMPLATE_FILE } from "./qa-template.ts";

/**
 * The three stage skills (design section 11): Flowryn owns when and whether
 * a stage runs; these hold how. Each has a description of at most 60 tokens
 * (always loaded) and a body of at most 1.5k tokens (read on demand), plus
 * any files it names (the QA page's template), written next to it. The
 * launcher writes them under `<state_dir>/skills/`, loads them into a Claude
 * worker as a plugin, and every stage start names the SKILL.md path, so a Pi
 * worker (or any harness) reads the same file.
 */

export interface StageSkill {
  name: string;
  description: string;
  body: string;
  /** Files written next to its SKILL.md, by name (the QA page's template). */
  files?: Record<string, string>;
}

const DESIGN_BODY = `# Flowryn design stage

Goal: a design the user reviews and approves in Lavish, and a phase plan when the feature is bigger than one change. No product code in this stage.

1. Read the task file and the project: its AGENTS.md or CLAUDE.md, the README, and the code the task touches. Note the constraints you find.
2. Write the design as one HTML page in \`$FLOWRYN_REPORT_DIR/design/design.html\` (outside your worktree, so the branch stays clean): the problem, the approach and why, what changes (files, APIs, data, screens), the assumptions the build must test, the risks, and open questions. Show, don't tell: diagrams, tables, before and after.
3. Host it for review: \`lavish-axi $FLOWRYN_REPORT_DIR/design/design.html\` prints its URL. Without lavish-axi, use the page's file:// URL.
4. A phased feature: this task is phase 1. Write \`$FLOWRYN_REPORT_DIR/plan.md\` with one section per later phase:

   ## Phase 2: <title>
   workflow: fix
   <what the phase does, and how to tell it is done>

   The \`workflow:\` line is optional. Approving the design approves the plan; each later phase starts by itself once the phase before it has landed (merged and cleaned up).
5. Finish: \`$FLOWRYN_BIN stage done --review <url> [--plan-file $FLOWRYN_REPORT_DIR/plan.md]\`, then end your turn. The user reviews in Lavish; do not hold a \`lavish-axi poll\` open. A steer brings the verdict: approved (the next stage starts), or changes with the user's words (revise, then run stage done again).

Rules:
- Only the user passes a review gate. Never say or assume the design was approved until the steer says so.
- Keep the page honest: mark guesses as guesses, and list what you could not check.
`;

const BUILD_BODY = `# Flowryn build and test stage

Goal: the change the approved design describes, with tests that prove it and tests that check the design's assumptions. This stage has no review gate: finish it on your own.

1. Re-read the design (its page, and the steer that started this stage). List every assumption it makes: inputs, data shapes, limits, ordering, failure modes.
2. Test each layer with the project's own tools (read package.json, the Makefile, the CI config; add a framework only when the project has none for that layer):
   - Front end: unit tests for the logic behind the UI; one end-to-end smoke of each changed flow when the project has an end-to-end setup.
   - Back end: unit tests for new functions; an API test per changed endpoint covering the status, the body, the errors and the auth.
   - Database: migrations apply forward on a scratch database; queries run against the real schema (a container, or the in-memory engine the project already uses). No test touches a shared database.
3. For each design assumption, write at least one test that fails when the assumption is wrong, and name it after the assumption.
4. Build in small commits on your branch. Run the whole test suite and the linters; everything green before you finish.
5. Finish: commit everything, \`$FLOWRYN_BIN stage done\`, end your turn. The next stage arrives as a steer.

Rules:
- A test you cannot make pass: \`$FLOWRYN_BIN ask\` or \`$FLOWRYN_BIN report blocked --body-file -\`. Never skip, weaken or delete a test to get green.
- Stay inside your worktree and your branch.
`;

const QA_BODY = `# Flowryn visual QA stage

Goal: evidence, reviewed in Lavish, that the change works in the running app, on a page the user understands in under a minute. You hold one Docker environment slot and one browser slot, for this stage only.

1. Start the app's environment with Docker and label every container with your run, so Flowryn can count it:
   - compose: \`docker compose -p flowryn-$FLOWRYN_RUN up -d\`, with \`labels: [flowryn.run=$FLOWRYN_RUN]\` on every service (an override file outside the worktree keeps the branch clean);
   - single container: \`docker run -d --label flowryn.run=$FLOWRYN_RUN ...\`.
   One environment (one compose project) per slot. More than your slot allows is flagged.
2. Walk each flow the design names with chrome-devtools-axi, in your own session: \`export CHROME_DEVTOOLS_AXI_SESSION=flowryn-$FLOWRYN_RUN\`, then \`chrome-devtools-axi open <url>\`, \`snapshot\`, \`click @<uid>\`, \`fill @<uid> <text>\`, and \`chrome-devtools-axi screenshot $FLOWRYN_REPORT_DIR/qa/<step>.png\` after each step. Keep \`console\` and \`network\` errors.
3. Copy \`${QA_TEMPLATE_FILE}\` (next to this SKILL.md) to \`$FLOWRYN_REPORT_DIR/qa/evidence.html\` and fill every {{SLOT}}. The card at the top is for someone who has not read the code, in plain words: what changed that they would notice ("Nothing visible." is fine), what was checked, the verdict (works, works-with-caveats or broken, each caveat spelled out), and each decision as a question with your recommendation (or "Nothing to decide."). Commands, tables, screenshots (relative paths, next to the page) and logs go in the folded sections below it. \`stage done\` refuses a page whose card is missing, blank or not first. Host it: \`lavish-axi $FLOWRYN_REPORT_DIR/qa/evidence.html\` prints its URL.
4. Stop everything you started: \`docker compose -p flowryn-$FLOWRYN_RUN down\` (or \`docker rm -f\`), and \`chrome-devtools-axi stop\`. A labelled container still running after the stage is flagged to the user.
5. Finish: \`$FLOWRYN_BIN stage done --review <url>\`, end your turn. A steer brings the verdict: approved (shipping starts), or changes with the user's words (back to build).

Rules:
- A project without Docker: run the app the way its README says, capture the same evidence, and say so on the page.
- Report what you saw, not what you expected: a failed step stays on the page as failed, and the verdict says broken.
`;

export const STAGE_SKILLS: readonly StageSkill[] = [
  {
    name: "flowryn-design",
    description: "Flowryn design stage: turn the task into a design page reviewed in Lavish and, for a phased feature, a phase plan. Use when your Flowryn stage is design.",
    body: DESIGN_BODY,
  },
  {
    name: "flowryn-build-test",
    description: "Flowryn build stage: build the approved design with tests per layer (front end, back end, database) and tests that check the design's assumptions. Use when your Flowryn stage is build.",
    body: BUILD_BODY,
  },
  {
    name: "flowryn-visual-qa",
    description: "Flowryn visual QA stage: run the app in labelled Docker environments, walk its flows with chrome-devtools-axi, and publish the evidence in Lavish. Use when your Flowryn stage is qa.",
    body: QA_BODY,
    files: { [QA_TEMPLATE_FILE]: QA_TEMPLATE },
  },
];

export function skillMarkdown(skill: StageSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

export function isStageSkill(name: string | null): boolean {
  return name !== null && STAGE_SKILLS.some((s) => s.name === name);
}

export interface StageSkillFiles {
  /** `<state_dir>/skills`: one directory per skill, each with a SKILL.md. */
  root: string;
  /** A Claude plugin holding the same skills, for --plugin-dir. */
  claudePlugin: string;
}

export function skillsRoot(stateDir: string): string {
  return join(stateDir, "skills");
}

/** The SKILL.md a stage names, when the skill is one of Flowryn's. */
export function skillPath(stateDir: string, name: string | null): string | null {
  return isStageSkill(name) ? join(skillsRoot(stateDir), name!, "SKILL.md") : null;
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileAtomic(path, content, 0o644);
}

/** Write the stage skills, and the Claude plugin that carries them; only what changed is rewritten. */
export function writeStageSkills(stateDir: string): StageSkillFiles {
  const root = skillsRoot(stateDir);
  ensureDir(root, 0o755);
  const plugin = join(root, "claude-plugin");
  ensureDir(join(plugin, ".claude-plugin"), 0o755);
  writeIfChanged(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "flowryn-stages", version: VERSION, description: "Flowryn's stage skills, loaded into Flowryn workers" }, null, 2) + "\n");
  for (const skill of STAGE_SKILLS) {
    const text = skillMarkdown(skill);
    ensureDir(join(root, skill.name), 0o755);
    writeIfChanged(join(root, skill.name, "SKILL.md"), text);
    ensureDir(join(plugin, "skills", skill.name), 0o755);
    writeIfChanged(join(plugin, "skills", skill.name, "SKILL.md"), text);
    for (const [name, content] of Object.entries(skill.files ?? {})) {
      writeIfChanged(join(root, skill.name, name), content);
      writeIfChanged(join(plugin, "skills", skill.name, name), content);
    }
  }
  return { root, claudePlugin: plugin };
}
