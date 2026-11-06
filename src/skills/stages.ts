import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { VERSION } from "../version.ts";
import { DESIGN_TEMPLATE, DESIGN_TEMPLATE_FILE, DESIGN_TLDR_WORDS_MAX, DESIGN_VISIBLE_WORDS_MAX } from "./design-template.ts";
import { QA_CARD_WORDS_MAX, QA_TEMPLATE, QA_TEMPLATE_FILE } from "./qa-template.ts";

/**
 * The stage skills (design section 11; the draft one is notes projects'): Flowryn owns when and whether
 * a stage runs; these hold how. Each has a description of at most 60 tokens
 * (always loaded) and a body of at most 1.5k tokens (read on demand), plus
 * any files it names (the design and QA pages' templates), written next to it. The
 * launcher writes them under `<state_dir>/skills/`, loads them into a Claude
 * worker as a plugin, and every stage start names the SKILL.md path, so a Pi
 * worker (or any harness) reads the same file.
 */

export interface StageSkill {
  name: string;
  description: string;
  body: string;
  /** Files written next to its SKILL.md, by name (a review page's template). */
  files?: Record<string, string>;
}

const DESIGN_BODY = `# Flowryn design stage

Goal: a design the user approves in Lavish, plus a phase plan when the feature is bigger than one change. No product code.

1. Read the task file and the project (AGENTS.md or CLAUDE.md, README, the code the task touches); note its constraints.
2. The page, for an engineer who has not read the code and must judge it in two minutes: copy \`${DESIGN_TEMPLATE_FILE}\` (next to this SKILL.md) to \`$FLOWRYN_REPORT_DIR/design/design.html\` (outside your worktree) and fill every {{SLOT}}, in order: In short (problem and change, at most ${DESIGN_TLDR_WORDS_MAX} words); What I need from you (approve or send changes, and the two or three calls worth a look); What changes for you (before and after, as the user notices it); Goals and non-goals; How it works (a diagram, then a few steps); Other ways (doing nothing included); Risks, and how we'd know it's wrong. Folded and last: files, APIs, data, identifiers, the assumptions the build must test, every choice and why, sources, what you could not check.
   Above the fold, plain words (not the terse reply style): no code names (an underscore, an inner capital, a path, a --flag, a call()), no \`<code>\` or \`<pre>\`, no unexplained internal term (\`<dfn>\` on first use, \`<kbd>\` for what the user types); at most ${DESIGN_VISIBLE_WORDS_MAX} words, diagrams aside. \`stage done\` refuses a page that breaks them.
   The build spec, for later stages: \`$FLOWRYN_REPORT_DIR/design/spec.md\` (\`$FLOWRYN_BIN template spec\`): ## Approach, ## Files and interfaces, ## Data and schema, ## Error handling, ## Security (threat surface, secrets, input validation, authorization), ## Test plan (a test per assumption), ## Rejected alternatives. Link it from the folded detail (\`<a href="spec.md">\`). The review approves page and spec together as pinned; a revision during review counts once you answer on the page (\`review reply\`).
3. Questions: only a real decision you cannot proceed without; decide and record the rest. Write \`$FLOWRYN_REPORT_DIR/design/questions.json\`:

   {"questions": [{"key": "token-store", "kind": "single", "question": "Where do cached tokens live?",
     "options": ["db", "file"], "recommend": "db", "blocks": "which store TokenCache writes to", "why": "..."}],
    "decided": [{"choice": "poller home", "picked": "src/lavish/poller.ts", "why": "..."}]}

   kind: single, multi (recommend is a list) or text (recommend is your default, no options). At most 5 questions, 2 to 8 short options (never "other": the widget offers it), blocks names what waits. The template's widget (\`<section id="flowryn-questions">\` in What I need from you) is the only place a question appears: never list them as text or write your own form.
4. Host it: \`lavish-axi --no-open $FLOWRYN_REPORT_DIR/design/design.html\` prints its URL; pass it as it is. Only without lavish-axi, use the page's file:// URL.
5. A phased feature (this task is phase 1): \`$FLOWRYN_REPORT_DIR/plan.md\`, one section per later phase:

   ## Phase 2: <title>
   workflow: fix
   <what it does, and how to tell it is done>

   (\`workflow:\` is optional.) Approving the design approves the plan; each phase starts once the one before has landed.
6. Finish: \`$FLOWRYN_BIN stage done --review <url> --page $FLOWRYN_REPORT_DIR/design/design.html [--plan-file $FLOWRYN_REPORT_DIR/plan.md] [--questions-file $FLOWRYN_REPORT_DIR/design/questions.json]\`. Changes come with the user's words: revise, then stage done again.

Rules:
- Only the user passes a review gate; never assume approval before the steer says so.
- Keep the page honest: mark guesses, list what you could not check.
`;

const BUILD_BODY = `# Flowryn build and test stage

Goal: the change the approved design describes, with tests that prove it and tests that check the design's assumptions. This stage has no review gate: finish it on your own.

1. Re-read your task file: its carried context holds the approved build spec, the review's answers and recorded choices, and any scout report. List every assumption the spec makes: inputs, data shapes, limits, ordering, failure modes.
2. Test each layer with the project's own tools (read package.json, the Makefile, the CI config; add a framework only when the project has none for that layer):
   - Front end: unit tests for the logic behind the UI; one end-to-end smoke of each changed flow when the project has an end-to-end setup.
   - Back end: unit tests for new functions; an API test per changed endpoint covering the status, the body, the errors and the auth.
   - Database: migrations apply forward on a scratch database; queries run against the real schema (a container, or the in-memory engine the project already uses). No test touches a shared database.
3. For each design assumption, write at least one test that fails when the assumption is wrong, and name it after the assumption.
4. Build in small commits on your branch. Run the whole test suite and the linters; everything green before you finish.
5. Principal-level bar, checked before you finish:
   - The change matches the spec; every deviation has a reason.
   - Threat-model it: who controls each input, what an attacker gains; validate inputs at the boundary, enforce authorization where the data is.
   - No secrets in logs, errors, storage, task files or commits.
   - Errors are explicit, never swallowed; each failure path has a test.
6. Self-review: read your whole diff as a reviewer would (\`git diff <base>...HEAD\`), fix what you find, run the suite again.
7. Finish: commit everything, write the handoff (\`$FLOWRYN_BIN template handoff\`: ## Done, ## Deviations from the spec and why, ## Risks), then \`$FLOWRYN_BIN stage begin <next stage> --handoff-file <file>\` and go on at once with the steps its reply gives, in the same turn. End your turn only on stage_waiting: a steer starts the stage. The next stage gets your handoff.

Rules:
- A test you cannot make pass: \`$FLOWRYN_BIN ask --options a,b --blocks <what waits> --body-file -\` or \`$FLOWRYN_BIN report blocked --body-file -\`. Never skip, weaken or delete a test to get green.
- A test that fails the same way on the base branch (outside your change): \`$FLOWRYN_BIN report finding --body-file -\` with the failure, and go on.
- Stay inside your worktree and your branch.
- Write the docs the change needs where the project's AGENTS.md or CLAUDE.md says, as a new file when it says so.
- Be autonomous: choices the design left open are yours; record each and why in the PR. Ask only when you cannot proceed.
`;

const QA_BODY = `# Flowryn visual QA stage

Goal: evidence, reviewed in Lavish, that the change works in the running app, on a page the user understands in under a minute. You hold one Docker environment slot and one browser slot, for this stage only.

1. Start the app's environment with Docker and label every container with your run, so Flowryn can count it:
   - compose: \`docker compose -p flowryn-$FLOWRYN_RUN up -d\`, with \`labels: [flowryn.run=$FLOWRYN_RUN]\` on every service (an override file outside the worktree keeps the branch clean);
   - single container: \`docker run -d --label flowryn.run=$FLOWRYN_RUN ...\`.
   One environment (one compose project) per slot. More than your slot allows is flagged.
2. Walk each flow the design names with chrome-devtools-axi, in your own session: \`export CHROME_DEVTOOLS_AXI_SESSION=flowryn-$FLOWRYN_RUN\`, then \`chrome-devtools-axi open <url>\`, \`snapshot\`, \`click @<uid>\`, \`fill @<uid> <text>\`, and \`chrome-devtools-axi screenshot $FLOWRYN_REPORT_DIR/qa/<step>.png\` after each step. Keep \`console\` and \`network\` errors.
3. Copy \`${QA_TEMPLATE_FILE}\` (next to this SKILL.md) to \`$FLOWRYN_REPORT_DIR/qa/evidence.html\` and fill every {{SLOT}}. The card at the top is for someone who has not read the code, in plain words, not the terse reply style (the design page's rule: no code names or \`<code>\` in it, \`<dfn>\` for a term you need, at most ${QA_CARD_WORDS_MAX} words): what changed that they would notice ("Nothing visible." is fine), what was checked, the verdict (works, works-with-caveats or broken, each caveat spelled out), and each decision as a question with your recommendation (or "Nothing to decide."). Commands, tables, screenshots (relative paths, next to the page) and logs go in the folded sections below it. \`stage done\` refuses a page whose card is missing, blank or not first. Host it: \`lavish-axi --no-open $FLOWRYN_REPORT_DIR/qa/evidence.html\` prints its URL (\`stage done\` checks that the URL is this page's).
4. Stop everything you started: \`docker compose -p flowryn-$FLOWRYN_RUN down\` (or \`docker rm -f\`), and \`chrome-devtools-axi stop\`. A labelled container still running after the stage is flagged to the user.
5. Finish: \`$FLOWRYN_BIN stage done --review <url> --page $FLOWRYN_REPORT_DIR/qa/evidence.html\`. The verdict: approved (shipping starts), or changes with the user's words (back to build).

Rules:
- A project without Docker: run the app the way its README says, capture the same evidence, and say so on the page. Docker failing to start or build: run it once more, then the README way; neither works: \`$FLOWRYN_BIN report blocked --body-file -\` with the output.
- Report what you saw, not what you expected: a failed step stays on the page as failed, and the verdict says broken.
- A question only the user can answer: write \`$FLOWRYN_REPORT_DIR/qa/questions.json\` in the design skill's shape (at most 5, each with options, a recommendation and what it blocks), say "Answer the questions below." in the card's decisions entry, and add \`--questions-file $FLOWRYN_REPORT_DIR/qa/questions.json\` to stage done. Flowryn renders them as clickable options; never list them on the page as text. Decide the rest yourself.
`;

const DRAFT_BODY = `# Flowryn draft stage

Goal: one file of prose (a plan, a note, a comparison, a letter) that the user reviews and approves in Lavish. This is a notes project: no code, no tests, no push. What the user approves is exactly what lands.

1. Read the task file and the repository: its AGENTS.md, CLAUDE.md or README if it has one, and the notes near where this file belongs. Follow its conventions for names, folders and front matter.
2. Write the draft as one Markdown (.md) or plain text (.txt) file in your worktree, at most 1 MB. Do not commit yet.
3. Render the review page: \`$FLOWRYN_BIN draft render <file>\` (its path from the worktree's top level). Flowryn writes \`$FLOWRYN_REPORT_DIR/draft/draft.html\` from the file itself; never write or edit that page by hand (\`stage done\` renders the file again and refuses a page that differs). Raw HTML in the file is shown as text, and so is a link that is not http(s), mailto or relative, or an image that is not relative.
4. Questions for the user: only what you truly cannot proceed without; decide everything else. Write them to \`$FLOWRYN_REPORT_DIR/draft/questions.json\` in the flowryn-design skill's shape (at most 5, each with options, a recommendation and what it blocks; recorded choices under "decided"). The page already mounts the question widget; never list questions in the file as text.
5. Host it: \`lavish-axi --no-open $FLOWRYN_REPORT_DIR/draft/draft.html\` prints its URL; pass it as it is.
6. Finish: \`$FLOWRYN_BIN stage done --review <url> --page $FLOWRYN_REPORT_DIR/draft/draft.html [--questions-file $FLOWRYN_REPORT_DIR/draft/questions.json]\`. The verdict: changes with the user's words (edit the file, render again, host it again, stage done again), or approved.
7. After approval (the final stage): commit the file exactly as approved and \`$FLOWRYN_BIN deliver --local\`. A file that differs from the approved one, or any other file your branch changes, is refused; a change needs a new review.

Rules:
- Only the user passes a review gate. Never say or assume the draft was approved until the steer says so.
- One file per task. Stay inside your worktree and your branch; never push.
- Write in the user's voice for the reader the task names; mark guesses as guesses in the text.
`;

export const STAGE_SKILLS: readonly StageSkill[] = [
  {
    name: "flowryn-design",
    description: "Flowryn design stage: turn the task into a design page reviewed in Lavish and, for a phased feature, a phase plan. Use when your Flowryn stage is design.",
    body: DESIGN_BODY,
    files: { [DESIGN_TEMPLATE_FILE]: DESIGN_TEMPLATE },
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
  {
    name: "flowryn-draft",
    description: "Flowryn draft stage (notes projects): write one Markdown or text file, render it as the Lavish review page, and deliver it locally exactly as approved. Use when your Flowryn stage is draft.",
    body: DRAFT_BODY,
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
