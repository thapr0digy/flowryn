#!/usr/bin/env bun
/**
 * A fake Claude or Pi worker for tests, started by the fake Herdr's
 * agent.start. It behaves like the harness only through the flowryn CLI:
 * the same hook verbs Claude's hooks and the Pi extension call, and the same
 * worker verbs a model would run. What it does comes from `FAKE:` lines in the
 * task file (the dispatch body):
 *
 *   FAKE: sleep <ms>                 a tool call; steers may arrive beside it
 *   FAKE: deliver <file> <text...>   write $FLOWRYN_REPORT_DIR/<file>, deliver --report
 *   FAKE: deliver-raw <file> <text...>  like deliver, but literal \n tokens become real newlines
 *                                    (hand-craft a report's exact bytes, such as a malformed heading)
 *   FAKE: deliver-decisions <file> <k:q:opts:rec:reserved ; ...>  write a report with an ## Open decisions
 *                                    section (- for no recommendation or reason), then deliver --report
 *   FAKE: symlink <name> <target>    make $FLOWRYN_REPORT_DIR/<name> a symlink to <target>
 *   FAKE: write <file> <text...>     write $FLOWRYN_REPORT_DIR/<file> (literal \n tokens become newlines): a review
 *                                    page, a questions file
 *   FAKE: verb <args...>             run flowryn <args> --json ($FLOWRYN_REPORT_DIR and lavish:<file> expand, as in
 *                                    stage-done); the reply goes to $FLOWRYN_REPORT_DIR/fake-replies.jsonl
 *   FAKE: ask <a,b> <question...>    ask (blocking), then end the turn
 *   FAKE: fail <reason...>           fail
 *   FAKE: report <status> [body...]  report, with the body on stdin when given (literal \n tokens become newlines)
 *   FAKE: crash                      exit 1 at once, like a killed process
 *   FAKE: no-start                   never report worker-start (a trust wedge)
 *   FAKE: cwd <path>                 report this cwd at worker-start (isolation test)
 *   FAKE: ignore-steers              never acknowledge a steer
 *   FAKE: commit <file> <text...>    write <file> in the worktree and commit it
 *   FAKE: scratch <file> <text...>   write <file> in the worktree and leave it uncommitted
 *   FAKE: push                       git push origin HEAD (the run branch)
 *   FAKE: pr <api> <owner/repo> [draft]  open a PR for the run branch on a fake GitHub
 *   FAKE: deliver-pr                 deliver --pr <the PR it opened>; the reply goes to fake-replies.jsonl
 *   FAKE: deliver-local              deliver --local; the reply goes to fake-replies.jsonl
 *   FAKE: wait-file <name>           wait until $FLOWRYN_REPORT_DIR/<name> exists (the test sequences a step)
 *   FAKE: stage-done [args...]       flowryn stage done <args> ($FLOWRYN_REPORT_DIR expands, and so does lavish:<file>,
 *                                    below); the reply goes to fake-replies.jsonl; on success the turn ends and the
 *                                    steps after it run when the next steer arrives (the stage start, or the
 *                                    review's verdict)
 *
 * In stage-done and verb arguments, lavish:<file> becomes lavish-axi's review URL for $FLOWRYN_REPORT_DIR/<file>
 * (http://127.0.0.1:4387/session/<its key>, src/lavish/session-key.ts), as a worker hosting the page gets it.
 * The page is written (a bare <html>) when missing, except a QA page (qa/evidence.html), which a test writes
 * with qa-page or leaves missing on purpose.
 *   FAKE: qa-page [verdict]          write $FLOWRYN_REPORT_DIR/qa/evidence.html: the QA template, every slot filled
 *                                    (verdict works unless named), as the visual QA skill asks
 *   FAKE: plan-phase <title...>      append a "## <title>" phase (workflow fix) to $FLOWRYN_REPORT_DIR/plan.md
 *   FAKE: docker-up <name> [project] a running container labelled flowryn.run=$FLOWRYN_RUN, in the fake
 *                                    docker's list ($FLOWRYN_HOME/docker-ps.txt), in a compose project if named
 *   FAKE: docker-down <name>         that container stops
 *   FAKE: usage-limit                the turn ends in StopFailure with error rate_limit (a claude.ai usage limit)
 *   FAKE: prompt <text...>           a permission dialog: the screen shows <text>, hook notify permission_prompt, then
 *                                    no hook until the screen is cleared (the test clears it), then one tool call
 *   FAKE: stall                      a turn that goes quiet: no hooks, no Stop, for good
 *   FAKE: no-waiter                  (Claude) never arm the wait-steer waiter, as if it expired or died with an old
 *                                    daemon: an idle wake comes only from a line the fake Herdr's pane.send_text and
 *                                    Enter typed ($FLOWRYN_REPORT_DIR/fake-typed.txt)
 *   FAKE: dialog-tool <ms> <text...> a tool call whose PreToolUse raises a permission dialog: pre-tool, the screen
 *                                    shows <text>, hook notify permission_prompt, then (once the test clears the
 *                                    screen) the tool runs <ms> and post-tool follows
 *   FAKE: bg-start <job>             (Claude) a Bash tool call run in the background: its post-tool input carries
 *                                    backgroundTaskId <job>, as Claude's does
 *   FAKE: bg-end <job>               that job ends: its <task-notification> goes into the fake transcript, as the
 *                                    prompt of a woken turn
 *   FAKE: stop-no-outcome            end the turn with no outcome. A turn-end reminder (appended to
 *                                    $FLOWRYN_REPORT_DIR/fake-reminders.txt) continues it: the steps after it run
 *                                    at once, so a report or stage-done next obeys it. With none, the turn ends and
 *                                    the steps after it run when the next steer arrives
 *
 * Any other turn end that brings a turn-end reminder ignores it: the continued turn ends again at once.
 *
 * Tool calls carry a tool_use_id. A PreToolUse that denies (an urgent steer) skips the tool and hands the
 * steer to the model. The fake Pi plays its extension's urgent steers: one that arrives while a tool runs
 * asks hook preempt once the tool has run preempt_after_ms, and on go aborts (the steer it held is dropped,
 * as Pi drops it, and comes again after the stop).
 *
 * Steps run once per session: a resumed session continues after the last step
 * it finished (state kept next to the task file).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lavishSessionKey } from "../../src/lavish/session-key.ts";
import { QA_PLACEHOLDERS, QA_TEMPLATE } from "../../src/skills/qa-template.ts";
import { TURN_END_REMINDER } from "../../src/harness/contract-text.ts";

const [kind = "claude", ...args] = process.argv.slice(2);

/** lavish:<file> → lavish-axi's URL for that page under the report directory (see the header). */
function lavishArg(arg: string): string {
  if (!arg.startsWith("lavish:")) return arg;
  const file = arg.slice("lavish:".length);
  const dir = process.env.FLOWRYN_REPORT_DIR ?? ".";
  const path = join(dir, file);
  if (!existsSync(path) && file !== "qa/evidence.html") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<html><body>review</body></html>\n");
  }
  mkdirSync(dirname(path), { recursive: true });
  return `http://127.0.0.1:4387/session/${lavishSessionKey(join(realpathSync(dirname(path)), basename(path)))}`;
}
const env = process.env;
const BIN = env.FLOWRYN_BIN ?? "";
const harness = kind === "pi" ? "pi" : "claude";

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const session = flag("--session-id") ?? flag("--resume") ?? "no-session";
const prompt = args[args.length - 1] ?? "";
const taskFile = env.FLOWRYN_TASK_FILE ?? /task is in (\S+);/.exec(prompt)?.[1] ?? "";
const taskText = taskFile && existsSync(taskFile) ? readFileSync(taskFile, "utf8") : prompt;
const steps = taskText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("FAKE:"))
  .map((l) => l.slice(5).trim());
const stateFile = join(dirname(taskFile || "."), `fake-state-${session}.json`);
const transcript = join(dirname(taskFile || "."), `fake-transcript-${session}.jsonl`);
const ignoreSteers = steps.includes("ignore-steers");
const noWaiter = steps.includes("no-waiter");
const cwdOverride = steps.find((s) => s.startsWith("cwd "))?.slice(4) ?? null;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} fake-${harness}: ${message}\n`);
}

function done(): number {
  try {
    return (JSON.parse(readFileSync(stateFile, "utf8")) as { done: number }).done;
  } catch {
    return 0;
  }
}

function markDone(n: number): void {
  writeFileSync(stateFile, JSON.stringify({ done: n }));
}

async function flowryn(argv: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BIN, ...argv], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function hook(name: string, input: Record<string, unknown> = {}, extra: string[] = []) {
  return flowryn(["hook", name, "--harness", harness, ...extra], JSON.stringify(input));
}

const acked = new Set<string>();

/** The additionalContext a Claude hook printed, if any. */
function contextOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim()) as { hookSpecificOutput?: { additionalContext?: string } };
    return value.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    return null;
  }
}

/** Act on steer text (hook context, a pointer, or a Pi message): ack every id it names, unless told to ignore. */
async function onSteer(text: string): Promise<void> {
  if (ignoreSteers) return;
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bm\d+\b/g)) ids.add(match[0]);
  if (/inbox/.test(text) && !/Flowryn steer \[/.test(text)) {
    const inbox = await flowryn(["inbox", "--json"]);
    for (const match of inbox.stdout.matchAll(/"id":"(m\d+)"/g)) ids.add(match[1]!);
  }
  for (const id of ids) {
    if (acked.has(id)) continue;
    const result = await flowryn(["ack", id]);
    log(`ack ${id} -> ${result.code}`);
    if (result.code === 0) acked.add(id);
  }
  if (awaitingStage && ids.size > 0) {
    woken = true;
    wake?.();
  }
}

let interrupted = false;
/** The step to continue from once a steer wakes the worker after a stage done; null when not waiting. */
let resumeAt: number | null = null;
/** A stage done succeeded: the next steer (even one beside its own tool result) starts the next stage. */
let awaitingStage = false;
let wake: (() => void) | null = null;
let woken = false;
let abortSleep: (() => void) | null = null;

process.on("SIGINT", () => {
  // The interrupt key: the running tool dies and the transcript records it; no hook fires (M0 c04).
  interrupted = true;
  appendFileSync(transcript, JSON.stringify({ type: "user", message: "[Request interrupted by user for tool use]" }) + "\n");
  abortSleep?.();
});
process.on("SIGTERM", () => process.exit(0));

/** A tool call's wait; an interrupt that landed before it started still ends it, as Pi's abort ends the whole run. */
function sleep(ms: number): Promise<void> {
  if (interrupted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

let toolNo = 0;
/** bg-start's jobs: job id to the tool use id that started it. */
const backgroundJobs = new Map<string, string>();
/** When the running tool started, or null (the fake Pi extension times urgent steers from it). */
let toolStartedAt: number | null = null;

/** A PreToolUse deny's reason, if the hook printed one: an urgent steer blocking the call. */
function denyOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim()) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return value.hookSpecificOutput?.permissionDecision === "deny" ? (value.hookSpecificOutput.permissionDecisionReason ?? "") : null;
  } catch {
    return null;
  }
}

/** One tool call, with the busy lease refreshed and a steer possibly riding back on PostToolUse (or blocking it at PreToolUse). */
async function tool(run: () => Promise<void>, beforeRun?: () => Promise<void>, post: Record<string, unknown> = {}): Promise<void> {
  const id = `toolu_fake_${++toolNo}`;
  const pre = await hook("pre-tool", { tool_name: "Bash", tool_use_id: id });
  const denied = denyOf(pre.stdout);
  if (denied !== null) {
    log(`tool ${id} denied: ${denied}`);
    await onSteer(denied);
    return;
  }
  if (beforeRun) await beforeRun();
  toolStartedAt = Date.now();
  await run();
  toolStartedAt = null;
  if (interrupted) return;
  const posted = await hook("post-tool", { tool_name: "Bash", tool_use_id: id, transcript_path: transcript, ...post });
  const context = contextOf(posted.stdout);
  if (context) await onSteer(context);
}

const WORKTREE = env.FLOWRYN_WORKTREE ?? process.cwd();
const GIT_ENV = { ...env, GIT_AUTHOR_NAME: "fake worker", GIT_AUTHOR_EMAIL: "fake@worker.invalid", GIT_COMMITTER_NAME: "fake worker", GIT_COMMITTER_EMAIL: "fake@worker.invalid", GIT_CONFIG_GLOBAL: "/dev/null" };

async function git(gitArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...gitArgs], { cwd: WORKTREE, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) log(`git ${gitArgs.join(" ")} -> ${code}: ${stderr.trim()}`);
  return { code, stdout: stdout.trim(), stderr };
}

function recordReply(called: string[], result: { code: number; stdout: string }): void {
  const dir = env.FLOWRYN_REPORT_DIR ?? ".";
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "fake-replies.jsonl"), JSON.stringify({ args: called, code: result.code, reply: result.stdout.trim() }) + "\n");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase";
}

/** The fake docker's container list: one line per running container, id, name, run and compose project. */
function dockerFile(): string {
  return join(env.FLOWRYN_HOME ?? ".", "docker-ps.txt");
}

/** A stop-no-outcome step already ended the turn: the pause after it must not end it again. */
let turnEnded = false;

async function runStep(step: string): Promise<"continue" | "end-turn" | "await-steer"> {
  const [verb = "", ...rest] = step.split(/\s+/);
  switch (verb) {
    case "sleep":
      await tool(() => sleep(Number(rest[0] ?? 1000)));
      return interrupted ? "end-turn" : "continue";
    case "deliver": {
      const [file = "report.md", ...words] = rest;
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${words.join(" ") || "fake report"}\n`);
      await tool(async () => {
        const result = await flowryn(["deliver", "--report", path]);
        log(`deliver -> ${result.code} ${result.stdout.trim()}`);
      });
      return "continue";
    }
    case "deliver-raw": {
      // Like deliver, but the body is taken verbatim (literal `\n` tokens become real newlines), so
      // a test can hand-craft report content a scout would never produce, such as a malformed
      // "### " heading with no key or question.
      const [file = "report.md", ...words] = rest;
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${words.join(" ").replaceAll("\\n", "\n")}\n`);
      await tool(async () => {
        const result = await flowryn(["deliver", "--report", path]);
        log(`deliver -> ${result.code} ${result.stdout.trim()}`);
      });
      return "continue";
    }
    case "deliver-decisions": {
      const [file = "report.md", ...spec] = rest;
      const entries = spec.join(" ").split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
        const [key = "k", question = "?", opts = "", rec = "-", reserved = "-"] = s.split(":");
        return [`### ${key}: ${question}`, `Options: ${opts.split(",").join(", ")}`, ...(rec !== "-" ? [`Recommendation: ${rec}`] : []), "Why it matters: fake", ...(reserved !== "-" ? [`Reserved: ${reserved}`] : []), ""].join("\n");
      });
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `# Fake report\n\n## Open decisions\n\n${entries.join("\n")}`);
      await tool(async () => {
        const result = await flowryn(["deliver", "--report", path]);
        log(`deliver -> ${result.code} ${result.stdout.trim()}`);
      });
      return "continue";
    }
    case "write": {
      const [file = "note.txt", ...words] = rest;
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${words.join(" ").replaceAll("\\n", "\n")}\n`);
      return "continue";
    }
    case "symlink": {
      const [name = "report.md", target = "/dev/null"] = rest;
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, join(dir, name));
      return "continue";
    }
    case "verb": {
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      await tool(async () => {
        const result = await flowryn([...rest.map((a) => lavishArg(a.replaceAll("$FLOWRYN_REPORT_DIR", env.FLOWRYN_REPORT_DIR ?? "."))), "--json"]);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "fake-replies.jsonl"), JSON.stringify({ args: rest, code: result.code, reply: result.stdout.trim() }) + "\n");
      });
      return "continue";
    }
    case "ask": {
      const [options = "yes,no", ...words] = rest;
      await tool(async () => {
        const result = await flowryn(["ask", "--options", options, "--blocking", "--blocks", "the rest of this fake task", "--body-file", "-"], words.join(" ") || "which one?");
        log(`ask -> ${result.code} ${result.stdout.trim()}`);
      });
      return "end-turn";
    }
    case "fail":
      await tool(async () => {
        await flowryn(["fail", "--body-file", "-"], rest.join(" ") || "cannot");
      });
      return "end-turn";
    case "report":
      await tool(async () => {
        const [status = "progress", ...body] = rest;
        await flowryn(body.length > 0 ? ["report", status, "--body-file", "-"] : ["report", status], body.join(" ").replaceAll("\\n", "\n") || undefined);
      });
      return "continue";
    case "commit": {
      const [file = "change.txt", ...words] = rest;
      await tool(async () => {
        writeFileSync(join(WORKTREE, file), `${words.join(" ") || "a change"}\n`);
        await git(["add", "--", file]);
        await git(["commit", "-q", "-m", `fake: ${file}`]);
      });
      return "continue";
    }
    case "scratch": {
      const [file = "scratch.txt", ...words] = rest;
      await tool(async () => {
        writeFileSync(join(WORKTREE, file), `${words.join(" ") || "scratch work"}\n`);
      });
      return "continue";
    }
    case "push":
      await tool(async () => {
        await git(["push", "-q", "origin", "HEAD"]);
      });
      return "continue";
    case "pr": {
      const [api = "", repo = "", draft] = rest;
      await tool(async () => {
        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout;
        const response = await fetch(`${api}/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: `fake PR for ${branch}`, head: branch, base: "main", draft: draft === "draft" }) });
        const body = (await response.json()) as { html_url?: string };
        log(`pr -> ${response.status} ${body.html_url ?? ""}`);
        const dir = env.FLOWRYN_REPORT_DIR ?? ".";
        mkdirSync(dir, { recursive: true });
        if (body.html_url) writeFileSync(join(dir, "pr-url"), body.html_url);
      });
      return "continue";
    }
    case "deliver-pr":
      await tool(async () => {
        const url = readFileSync(join(env.FLOWRYN_REPORT_DIR ?? ".", "pr-url"), "utf8").trim();
        const called = ["deliver", "--pr", url];
        recordReply(called, await flowryn([...called, "--json"]));
      });
      return "continue";
    case "wait-file": {
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", rest[0] ?? "go");
      await tool(async () => {
        while (!existsSync(path)) await Bun.sleep(50);
      });
      return "continue";
    }
    case "deliver-local":
      await tool(async () => {
        const called = ["deliver", "--local"];
        recordReply(called, await flowryn([...called, "--json"]));
      });
      return "continue";
    case "stage-done": {
      const expanded = rest.map((a) => lavishArg(a.replaceAll("$FLOWRYN_REPORT_DIR", env.FLOWRYN_REPORT_DIR ?? ".")));
      let ok = false;
      woken = false;
      await tool(async () => {
        const called = ["stage", "done", ...expanded];
        const result = await flowryn([...called, "--json"]);
        recordReply(called, result);
        log(`stage done -> ${result.code} ${result.stdout.trim()}`);
        // Exit 75 is spooled: the contract says end the turn and wait all the same; the steer comes once it is ingested.
        ok = result.code === 0 || result.code === 75;
        awaitingStage = ok;
      });
      return ok ? "await-steer" : "continue";
    }
    case "qa-page": {
      const dir = join(env.FLOWRYN_REPORT_DIR ?? ".", "qa");
      mkdirSync(dir, { recursive: true });
      let page = QA_TEMPLATE.replace("{{VERDICT}}", rest[0] ?? "works");
      for (const slot of QA_PLACEHOLDERS) page = page.replaceAll(slot, "Filled by the fake worker.");
      writeFileSync(join(dir, "evidence.html"), page);
      return "continue";
    }
    case "plan-phase": {
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "plan.md"), `## ${rest.join(" ") || "next phase"}\nworkflow: fix\nFAKE: commit ${slug(rest.join(" "))}.txt ${rest.join(" ")}\nFAKE: deliver-local\nFAKE: sleep 120000\n\n`);
      return "continue";
    }
    case "docker-up": {
      const [name = "app", project = ""] = rest;
      appendFileSync(dockerFile(), `c${Math.random().toString(16).slice(2, 10)}\t${name}\t${env.FLOWRYN_RUN ?? ""}\t${project}\n`);
      return "continue";
    }
    case "docker-down": {
      const name = rest[0] ?? "app";
      const lines = existsSync(dockerFile()) ? readFileSync(dockerFile(), "utf8").split("\n").filter((l) => l && l.split("\t")[1] !== name) : [];
      writeFileSync(dockerFile(), lines.map((l) => `${l}\n`).join(""));
      return "continue";
    }
    case "usage-limit":
      await hook("stop-failure", { error: "rate_limit", error_details: "429 Too Many Requests" });
      return "continue";
    case "prompt": {
      const text = rest.join(" ");
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fake-screen.txt"), text);
      await hook("notify", { notification_type: "permission_prompt", message: "Claude needs your permission" });
      // Wait until the test clears the screen (the user answered), then carry on.
      while (existsSync(join(dir, "fake-screen.txt"))) await Bun.sleep(200);
      return "continue";
    }
    case "stall":
      for (;;) await Bun.sleep(60_000);
    case "dialog-tool": {
      const [ms = "1000", ...words] = rest;
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      await tool(
        () => sleep(Number(ms)),
        async () => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "fake-screen.txt"), words.join(" ") || "Do you want to proceed?");
          await hook("notify", { notification_type: "permission_prompt", message: "Claude needs your permission" });
          while (existsSync(join(dir, "fake-screen.txt"))) await Bun.sleep(100);
        },
      );
      return interrupted ? "end-turn" : "continue";
    }
    case "bg-start": {
      const job = rest[0] ?? "bfake";
      backgroundJobs.set(job, `toolu_fake_${toolNo + 1}`);
      await tool(async () => {}, undefined, {
        tool_input: { command: "bun test", run_in_background: true },
        tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: job },
      });
      return "continue";
    }
    case "bg-end": {
      const job = rest[0] ?? "bfake";
      const notice = `<task-notification>\n<task-id>${job}</task-id>\n<tool-use-id>${backgroundJobs.get(job) ?? "none"}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
      appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: notice } }) + "\n");
      return "continue";
    }
    case "stop-no-outcome": {
      if ((await stopOnce()) === "reminded") return "continue";
      awaitingStage = true;
      woken = false;
      turnEnded = true;
      return "await-steer";
    }
    case "crash":
      log("crash");
      process.exit(1);
    default:
      return "continue";
  }
}

/**
 * One turn end. Stop may continue the turn with a steer, at most twice in a
 * row (design section 5), or answer it with the turn-end reminder: a Claude
 * continuation, a Pi follow-up (its stop hook prints JSON).
 */
async function stopOnce(): Promise<"reminded" | "ended"> {
  for (;;) {
    const stop = harness === "pi" ? await hook("stop", {}, ["--json"]) : await hook("stop");
    const context = harness === "pi" ? piContextOf(stop.stdout) : contextOf(stop.stdout);
    if (!context) return "ended";
    if (context === TURN_END_REMINDER) {
      log(`reminded: ${context}`);
      const dir = env.FLOWRYN_REPORT_DIR ?? ".";
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "fake-reminders.txt"), `${context}\n`);
      return "reminded";
    }
    await onSteer(context);
  }
}

/** The data.context a Pi stop hook printed with --json, if any. */
function piContextOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { context?: unknown };
    return typeof value.context === "string" ? value.context : null;
  } catch {
    return null;
  }
}

/** End the turn; a reminder is ignored: the continued (or followed-up) turn ends again at once. */
async function endTurn(): Promise<void> {
  for (let i = 0; i < 3 && (await stopOnce()) === "reminded"; i++);
}

let typedSeen = 0;

/** What wakes an idle Claude session: the asyncRewake waiter's line (exit 2), or with no-waiter a typed prompt; null for neither yet. */
async function idleWake(): Promise<string | null> {
  if (noWaiter) {
    const file = join(env.FLOWRYN_REPORT_DIR ?? ".", "fake-typed.txt");
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0) : [];
    if (lines.length > typedSeen) {
      typedSeen = lines.length;
      log(`typed: ${lines[lines.length - 1]}`);
      return lines[lines.length - 1]!;
    }
    await Bun.sleep(200);
    return null;
  }
  const waiter = await hook("wait-steer");
  if (waiter.code === 2) return waiter.stderr;
  await Bun.sleep(200);
  return null;
}

async function claudeIdle(): Promise<never> {
  for (;;) {
    const line = await idleWake();
    if (line === null) continue;
    await hook("prompt");
    await onSteer(line);
    await endTurn();
  }
}

async function piLoop(): Promise<void> {
  // The extension's long poll runs all the time, busy or idle.
  for (;;) {
    const reply = await hook("wait-steer", {}, ["--json"]);
    const message = (() => {
      try {
        return JSON.parse(reply.stdout.trim().split("\n").pop() ?? "{}") as { exit?: boolean; command?: string; steer?: { id: string; line: string; urgent?: boolean; preempt_after_ms?: number } };
      } catch {
        return {};
      }
    })();
    if (message.exit) return;
    if (message.command === "interrupt") {
      interrupted = true;
      abortSleep?.();
      continue;
    }
    if (message.steer?.urgent && toolStartedAt !== null) void urgentWhileBusy(message.steer);
    else if (message.steer) await onSteer(message.steer.line);
    else await Bun.sleep(200);
  }
}

/** The extension's urgent steer in a busy turn: held (queued) until the tool ends, or cut once it has run long enough. */
async function urgentWhileBusy(steer: { id: string; line: string; preempt_after_ms?: number }): Promise<void> {
  const after = steer.preempt_after_ms ?? 3_000;
  while (toolStartedAt !== null) {
    const ran = Date.now() - toolStartedAt;
    if (ran < after) {
      await Bun.sleep(Math.min(100, after - ran));
      continue;
    }
    const reply = await hook("preempt", { steer: steer.id, tool_ms: ran }, ["--json"]);
    const answer = (() => {
      try {
        return JSON.parse(reply.stdout.trim().split("\n").pop() ?? "{}") as { go?: boolean; defer?: string };
      } catch {
        return {};
      }
    })();
    log(`preempt ${steer.id} -> ${reply.stdout.trim()}`);
    if (answer.go === true) {
      // Pi's abort drops the queued steer (M0 p14); the stop that follows makes the daemon ring it again.
      interrupted = true;
      abortSleep?.();
      return;
    }
    if (answer.go === false) break;
    await Bun.sleep(1_000);
  }
  await onSteer(steer.line);
}

/** Run the steps from `from`; returns where a stage done paused them, or null when they ended (or a turn ended for good). */
async function runSteps(from: number): Promise<number | null> {
  for (let i = from; i < steps.length; i++) {
    log(`step ${i + 1}/${steps.length}: ${steps[i]}`);
    if (steps[i] === "crash") markDone(i + 1);
    const outcome = await runStep(steps[i]!);
    markDone(i + 1);
    if (outcome === "await-steer") return i + 1;
    if (outcome === "end-turn") return null;
  }
  return null;
}

/** Idle after a stage done until a steer wakes the worker: Claude's asyncRewake waiter, or Pi's long poll. */
async function awaitWake(): Promise<void> {
  log(`waiting for a steer to continue at step ${(resumeAt ?? 0) + 1}`);
  if (woken) return;
  if (harness === "pi") {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
    return;
  }
  while (!woken) {
    const line = await idleWake();
    if (line === null) continue;
    await hook("prompt");
    await onSteer(line);
    if (!woken) await endTurn();
  }
}

async function main(): Promise<void> {
  if (steps.includes("no-start")) {
    log("no-start: waiting forever");
    for (;;) await Bun.sleep(60_000);
  }
  await hook("worker-start", { session_id: session, cwd: cwdOverride ?? process.cwd(), transcript_path: transcript, source: flag("--resume") ? "resume" : "startup" });
  if (harness === "pi") void piLoop();
  await hook("prompt");
  let from: number | null = done();
  while (from !== null) {
    const paused = await runSteps(from);
    if (paused === null) break;
    // A stage done: end the turn; a steer (often the Stop continuation itself) starts the next stage.
    resumeAt = paused;
    if (!turnEnded) await endTurn();
    turnEnded = false;
    await awaitWake();
    from = resumeAt;
    resumeAt = null;
    awaitingStage = false;
    woken = false;
    if (harness === "claude") await hook("prompt");
  }
  // Pi's abort still ends in agent_settled (M0 p14); Claude's interrupt fires no hook at all (M0 c04).
  if (!interrupted || harness === "pi") await endTurn();
  if (harness === "claude") await claudeIdle();
  for (;;) await Bun.sleep(60_000);
}

void main();
