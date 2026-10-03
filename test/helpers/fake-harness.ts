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
 *   FAKE: deliver-decisions <file> <k:q:opts:rec:reserved ; ...>  write a report with an ## Open decisions
 *                                    section (- for no recommendation or reason), then deliver --report
 *   FAKE: symlink <name> <target>    make $FLOWRYN_REPORT_DIR/<name> a symlink to <target>
 *   FAKE: verb <args...>             run flowryn <args> --json; the reply goes to $FLOWRYN_REPORT_DIR/fake-replies.jsonl
 *   FAKE: ask <a,b> <question...>    ask (blocking), then end the turn
 *   FAKE: fail <reason...>           fail
 *   FAKE: report <status>            report
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
 *   FAKE: stage-done [args...]       flowryn stage done <args> ($FLOWRYN_REPORT_DIR expands); the reply goes to
 *                                    fake-replies.jsonl; on success the turn ends and the steps after it run
 *                                    when the next steer arrives (the stage start, or the review's verdict)
 *   FAKE: plan-phase <title...>      append a "## <title>" phase (workflow fix) to $FLOWRYN_REPORT_DIR/plan.md
 *   FAKE: docker-up <name> [project] a running container labelled flowryn.run=$FLOWRYN_RUN, in the fake
 *                                    docker's list ($FLOWRYN_HOME/docker-ps.txt), in a compose project if named
 *   FAKE: docker-down <name>         that container stops
 *   FAKE: usage-limit                the turn ends in StopFailure with error rate_limit (a claude.ai usage limit)
 *
 * Steps run once per session: a resumed session continues after the last step
 * it finished (state kept next to the task file).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind = "claude", ...args] = process.argv.slice(2);
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

/** One tool call, with the busy lease refreshed and a steer possibly riding back on PostToolUse. */
async function tool(run: () => Promise<void>): Promise<void> {
  await hook("pre-tool", { tool_name: "Bash" });
  await run();
  const post = await hook("post-tool", { tool_name: "Bash" });
  const context = contextOf(post.stdout);
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
        const result = await flowryn([...rest, "--json"]);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "fake-replies.jsonl"), JSON.stringify({ args: rest, code: result.code, reply: result.stdout.trim() }) + "\n");
      });
      return "continue";
    }
    case "ask": {
      const [options = "yes,no", ...words] = rest;
      await tool(async () => {
        const result = await flowryn(["ask", "--options", options, "--blocking", "--body-file", "-"], words.join(" ") || "which one?");
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
        await flowryn(["report", rest[0] ?? "progress"]);
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
      const expanded = rest.map((a) => a.replaceAll("$FLOWRYN_REPORT_DIR", env.FLOWRYN_REPORT_DIR ?? "."));
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
    case "crash":
      log("crash");
      process.exit(1);
    default:
      return "continue";
  }
}

async function endTurn(): Promise<void> {
  // Stop may continue the turn with a steer, at most twice in a row (design section 5).
  for (;;) {
    const stop = await hook("stop");
    const context = contextOf(stop.stdout);
    if (!context) return;
    await onSteer(context);
  }
}

async function claudeIdle(): Promise<never> {
  // The asyncRewake waiter: exit 2 with a line on stderr wakes the session.
  for (;;) {
    const waiter = await hook("wait-steer");
    if (waiter.code === 2) {
      await hook("prompt");
      await onSteer(waiter.stderr);
      await endTurn();
    } else await Bun.sleep(200);
  }
}

async function piLoop(): Promise<void> {
  // The extension's long poll runs all the time, busy or idle.
  for (;;) {
    const reply = await hook("wait-steer", {}, ["--json"]);
    const message = (() => {
      try {
        return JSON.parse(reply.stdout.trim().split("\n").pop() ?? "{}") as { exit?: boolean; command?: string; steer?: { id: string; line: string } };
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
    if (message.steer) await onSteer(message.steer.line);
    else await Bun.sleep(200);
  }
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
    const waiter = await hook("wait-steer");
    if (waiter.code === 2) {
      await hook("prompt");
      await onSteer(waiter.stderr);
      if (!woken) await endTurn();
    } else await Bun.sleep(200);
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
    await endTurn();
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
