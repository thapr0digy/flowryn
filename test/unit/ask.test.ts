/**
 * Asks (docs/notes/2026-10-30-ask-a-lightweight-4v.md): the config, the print-mode argv and
 * environment, the readers of each harness's output (from output captured live from Claude
 * 2.1.314 and Pi 0.87.1), the store's state machine and items, and the runner through its
 * call seam (no daemon, no harness).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askConfig, checkUsd, DEFAULT_ASK } from "../../src/config/ask.ts";
import { loadConfig, parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { workersConfig, type WorkersConfig } from "../../src/config/workers.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { askContract, askEnv, capBytes, claudeAskArgs, firstSentence, NEEDS_SCOUT, PiMeter, piAskArgs, readClaudeResult, scoutRequest } from "../../src/ask/harness.ts";
import { abortAsk, drainAsks, recoverAsks, resetAskRunner, settledAsks, type AskDeps } from "../../src/ask/runner.ts";
import { getAsk, insertAsk, markStarted, MAX_ASK_ATTEMPTS, recordAnswer, recordCancelled, recoverInterrupted, type AskRow } from "../../src/ask/store.ts";
import { usd } from "../../src/ask/view.ts";
import { composeReturnBrief } from "../../src/attention/briefing.ts";
import { taskProject } from "../../src/leader/scope.ts";
import type { StartDeps } from "../../src/lifecycle/dispatch.ts";
import type { BoundedOptions, BoundedResult } from "../../src/runtime/bounded.ts";
import { noteUsageLimit } from "../../src/sched/usage.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/** Claude 2.1.314's JSON result for a success, as printed live (trimmed of usage detail). */
const CLAUDE_SUCCESS = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "`TIMED_OUT` is `124`.", total_cost_usd: 0.00108937, num_turns: 3, terminal_reason: "completed", permission_denials: [] });
/** Claude 2.1.314 with --max-budget-usd 0.0005, as printed live (exit 1). */
const CLAUDE_OVER_BUDGET = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: null, total_cost_usd: 0.00065673, errors: ["Reached maximum budget ($0.0005)"], terminal_reason: "budget_exhausted" });

/** Pi 0.87.1 `-p --mode json` with the scripted provider, as printed live: the event types and the assistant message's shape. */
function piStream(text: string, cost: number): string {
  const usage = { input: 11, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 19, cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost } };
  const assistant = { role: "assistant", content: [{ type: "text", text }], api: "flowryn-scripted-api", provider: "flowryn-scripted", model: "scripted", usage, stopReason: "stop", timestamp: 1 };
  return [
    { type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Q" }] } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Q" }] } },
    { type: "message_start", message: { ...assistant, content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta" }, usage },
    { type: "message_end", message: assistant },
    { type: "turn_end", message: assistant, toolResults: [] },
    { type: "agent_end", messages: [assistant], willRetry: false },
    { type: "agent_settled" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n")
    .concat("\n");
}

function config(text = ""): FlowrynConfig {
  return parseConfig(text, "/tmp/fw-home");
}

describe("[ask] config", () => {
  test("defaults, and each key checked", () => {
    expect(askConfig(config())).toEqual(DEFAULT_ASK);
    expect(askConfig(config("[ask]\nmax_usd = 0.25\nmax_concurrent = 4"))).toMatchObject({ max_usd: 0.25, max_concurrent: 4 });
    expect(() => askConfig(config("[ask]\nmax_usd = 0"))).toThrow("[ask] max_usd must be a dollar amount above 0 and at most 20");
    expect(() => askConfig(config("[ask]\ntimeout_ms = 1.5"))).toThrow("[ask] timeout_ms must be a positive whole number");
    expect(() => askConfig(config("[ask]\nmax_dollars = 1"))).toThrow("[ask] max_dollars is not a known setting");
  });

  test("a cap is a dollar amount above 0 and at most 20, for the flag too", () => {
    expect(checkUsd(0.5, "--max-usd")).toBe(0.5);
    for (const bad of [0, -1, 21, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => checkUsd(bad, "--max-usd")).toThrow("--max-usd must be");
  });
});

describe("the print-mode call", () => {
  const workers: WorkersConfig = workersConfig(config());

  test("Claude: JSON, no saved session, no settings, hooks or MCP, reading tools only, allowed without asking, and the cap", () => {
    const argv = claudeAskArgs({ harness: "claude", binary: "/bin/claude", workers: { ...workers, claude: { ...workers.claude, model: "haiku", effort: "low" } }, contractFile: "/c.md", maxUsd: 0.75 });
    expect(argv).toEqual([
      "/bin/claude", "-p", "--output-format", "json", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
      "--tools", "Read,Grep,Glob,WebFetch,WebSearch", "--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch", "--permission-mode", "dontAsk",
      "--max-budget-usd", "0.75", "--append-system-prompt-file", "/c.md", "--model", "haiku", "--effort", "low",
    ]);
  });

  test("Pi: its JSON stream, no session file, reading tools only, the account's provider and the extensions it needs", () => {
    const argv = piAskArgs({ harness: "pi", binary: "/bin/pi", workers: { ...workers, pi: { ...workers.pi, provider: "openrouter", model: "openrouter/x", extensions: ["/e.ts"], no_skills: true } }, contractFile: "/c.md", maxUsd: 1 });
    expect(argv).toEqual(["/bin/pi", "-p", "--mode", "json", "--no-session", "--tools", "read,grep,find,ls", "-e", "/e.ts", "--provider", "openrouter", "--model", "openrouter/x", "--no-skills", "--append-system-prompt", "/c.md"]);
  });

  test("a pinned Claude login drops the credentials Claude ranks above it; a Pi account names its agent dir", () => {
    const base = { PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/mine" };
    expect(askEnv("claude", { ...workers, claude: { ...workers.claude, pin_login: true, config_dir: "/acct" } }, base)).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/acct" });
    expect(askEnv("claude", { ...workers, claude: { ...workers.claude, pin_login: true, config_dir: null } }, base)).toEqual({ PATH: "/bin" });
    expect(askEnv("claude", { ...workers, claude: { ...workers.claude, pin_login: false, config_dir: null } }, base)).toEqual(base);
    expect(askEnv("pi", { ...workers, pi: { ...workers.pi, agent_dir: "/agent", env: { X: "1" } } }, { PATH: "/bin" })).toEqual({ PATH: "/bin", X: "1", PI_CODING_AGENT_DIR: "/agent" });
  });

  test("the contract names the size, the read-only rule and the marker", () => {
    const text = askContract(8192);
    expect(text).toContain("at most 8192 bytes");
    expect(text).toContain("You can only read");
    expect(text).toContain(`${NEEDS_SCOUT} <why, in one sentence>`);
  });
});

describe("reading the reply", () => {
  test("assumption: Claude 2.1.314's success is subtype success with result and total_cost_usd", () => {
    expect(readClaudeResult(CLAUDE_SUCCESS)).toEqual({ kind: "reply", text: "`TIMED_OUT` is `124`.", costUsd: 0.00108937 });
  });

  test("assumption: Claude 2.1.314 past --max-budget-usd is subtype error_max_budget_usd, with what it spent", () => {
    expect(readClaudeResult(CLAUDE_OVER_BUDGET)).toEqual({ kind: "over_cap", costUsd: 0.00065673, detail: "Reached maximum budget ($0.0005)" });
  });

  test("any other Claude ending is an error with its reason; output that is not its result says so", () => {
    expect(readClaudeResult(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.2, errors: [] }))).toEqual({ kind: "error", costUsd: 0.2, detail: "Claude ended with error_max_turns" });
    expect(readClaudeResult("Error: not logged in")).toMatchObject({ kind: "error", costUsd: null, detail: "Claude's output was not its JSON result" });
    expect(readClaudeResult("")).toMatchObject({ kind: "error", detail: "Claude printed nothing" });
  });

  test("assumption: Pi 0.87.1 --mode json reports each assistant message's cost at message.usage.cost.total", () => {
    const meter = new PiMeter();
    meter.feed(piStream("The answer.", 0.003));
    expect(meter.outcome()).toEqual({ kind: "reply", text: "The answer.", costUsd: 0.003 });
  });

  test("the Pi meter reads lines split across chunks, sums every message and keeps the last reply", () => {
    const meter = new PiMeter();
    const whole = piStream("First.", 0.01) + piStream("Second.", 0.02);
    let total = 0;
    for (let i = 0; i < whole.length; i += 7) total = meter.feed(new TextEncoder().encode(whole.slice(i, i + 7)));
    expect(total).toBeCloseTo(0.03, 9);
    expect(meter.outcome()).toMatchObject({ kind: "reply", text: "Second." });
  });

  test("a Pi model error is the outcome; no events at all says so", () => {
    const meter = new PiMeter();
    meter.feed(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited", usage: { cost: { total: 0 } } } }) + "\n");
    expect(meter.outcome()).toEqual({ kind: "error", costUsd: 0, detail: "429 rate limited" });
    expect(new PiMeter().outcome()).toEqual({ kind: "error", costUsd: null, detail: "Pi printed no events" });
  });

  test("a scout request is the marker on the first non-blank line only", () => {
    expect(scoutRequest("\n  NEEDS-SCOUT: it needs the tests run\n")).toBe("it needs the tests run");
    expect(scoutRequest("needs-scout:")).toBe("the ask said it needs to write or run something");
    expect(scoutRequest("The answer.\nNEEDS-SCOUT: no")).toBeNull();
  });

  test("the digest line's first sentence skips Markdown and code, and is cut", () => {
    expect(firstSentence("# Answer\n\n- It retries **three** times. Then it fails.")).toBe("Answer It retries **three** times.");
    expect(firstSentence("```ts\nx()\n```\nIt works")).toBe("It works");
    expect(firstSentence("a".repeat(300), 20)).toBe(`${"a".repeat(19)}…`);
  });

  test("an answer is cut on a character boundary", () => {
    expect(capBytes("héllo", 100)).toEqual({ text: "héllo", cut: false });
    expect(capBytes("héllo", 2)).toEqual({ text: "h", cut: true });
    expect(capBytes("héllo", 3)).toEqual({ text: "hé", cut: true });
  });

  test("dollars to four places, the cents always shown", () => {
    expect([usd(1), usd(0.06), usd(0.0123), usd(0.51), usd(null)]).toEqual(["$1.00", "$0.06", "$0.0123", "$0.51", "-"]);
  });
});

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(h.home);
  resetAskRunner();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function newAsk(question = "What is it?", now = 1_000): AskRow {
  return tx(db, () => insertAsk(db, { projectId: "web", title: question.split("\n")[0]!, question, harness: "claude", account: "claude", model: null, effort: null, maxUsd: 1, noPromote: false, by: "leader", now }));
}

function kinds(id: string): string[] {
  return (db.query("SELECT kind FROM events WHERE task_id = ?1 ORDER BY seq").all(id) as { kind: string }[]).map((e) => e.kind);
}

describe("the store", () => {
  test("ids count up; an answer opens one P1 answer item and a cancel closes it; each change is an event", () => {
    const a = newAsk();
    expect([a.id, newAsk().id]).toEqual(["a1", "a2"]);
    expect(tx(db, () => markStarted(db, a.id, 2_000))).toBe(true);
    expect(tx(db, () => markStarted(db, a.id, 2_000))).toBe(false);
    expect(tx(db, () => recordAnswer(db, a.id, { text: "It is a project. Yes.", path: null, costUsd: 0.5 }, 3_000))).toBe(true);
    expect(db.query("SELECT kind, lane, class, line FROM items WHERE task_id = ?1").all(a.id)).toEqual([{ kind: "answer_ready", lane: "P1", class: "actionable", line: "Answer (web): It is a project.; flowryn show a1" }]);
    expect(tx(db, () => recordCancelled(db, a.id, { reason: "late", by: "leader" }, 4_000))).toBe(false);
    expect(tx(db, () => recordCancelled(db, "a2", { reason: "late", by: "leader" }, 4_000))).toBe(true);
    expect(kinds(a.id)).toEqual(["ask.queued", "ask.started", "ask.answered"]);
    expect(kinds("a2")).toEqual(["ask.queued", "ask.cancelled"]);
  });

  test(`a call cut short by a daemon stop runs again until ${MAX_ASK_ATTEMPTS} attempts, then fails with an item`, () => {
    const a = newAsk();
    tx(db, () => markStarted(db, a.id, 2_000));
    expect(tx(db, () => recoverInterrupted(db, getAsk(db, a.id)!, 3_000))).toBe("requeued");
    tx(db, () => markStarted(db, a.id, 4_000));
    expect(tx(db, () => recoverInterrupted(db, getAsk(db, a.id)!, 5_000))).toBe("failed");
    expect(getAsk(db, a.id)).toMatchObject({ state: "failed", attempts: 2 });
    expect((db.query("SELECT line FROM items WHERE kind = 'ask_failed'").get() as { line: string }).line).toContain("the daemon stopped mid-call 2 times");
  });

  test("an ask's id names its project for the scope lens", () => {
    const a = newAsk();
    expect(taskProject(db, a.id)).toBe("web");
    expect(taskProject(db, "a99")).toBeNull();
  });

  test("the return brief's spend line counts the asks that ended in its window, with their cost", () => {
    const a = newAsk();
    tx(db, () => markStarted(db, a.id, 2_000));
    tx(db, () => recordAnswer(db, a.id, { text: "x.", path: null, costUsd: 0.25 }, 3_000));
    const brief = composeReturnBrief(db, { since: 0, until: 10_000, now: 10_000, ageMs: 86_400_000, reason: "back" });
    expect(brief).toContain(", 1 ask ($0.25).");
  });
});

/** The runner's call seam: answers as the fake decides, records what it was given. */
function deps(answer: (argv: string[], opts: BoundedOptions) => Promise<BoundedResult>): AskDeps & { kicks: number } {
  const loaded = loadConfig(h.home).config;
  const out: AskDeps & { kicks: number } = {
    db,
    config: () => loaded,
    now: Date.now,
    log: () => {},
    startDeps: { db, config: () => loaded, runtime: () => null, harnessVersion: async () => null, git: async () => null, now: Date.now } as StartDeps,
    kick: () => {
      out.kicks++;
    },
    root: join(h.stateDir, "asks"),
    env: { PATH: "/bin" },
    call: answer,
    kicks: 0,
  };
  return out;
}

function result(stdout: string, extra: Partial<BoundedResult> = {}): BoundedResult {
  return { code: 0, stdout, stderr: "", timedOut: false, aborted: false, incomplete: null, lingering: false, spawnError: null, leftover: false, ...extra };
}

describe("the runner", () => {
  test("one call per ask in the project's checkout, the question on stdin, the contract written beside it; the answer recorded and a kick", async () => {
    const seen: { argv: string[]; opts: BoundedOptions }[] = [];
    const d = deps(async (argv, opts) => {
      seen.push({ argv, opts });
      return result(CLAUDE_SUCCESS);
    });
    const a = newAsk("Q?");
    expect(drainAsks(d)).toBe(1);
    await settledAsks();
    expect(getAsk(db, a.id)).toMatchObject({ state: "answered", answer: "`TIMED_OUT` is `124`.", cost_usd: 0.00108937 });
    expect(seen[0]!.opts).toMatchObject({ cwd: h.home, stdin: "Q?", timeoutMs: DEFAULT_ASK.timeout_ms, label: "ask a1" });
    expect(readFileSync(join(h.stateDir, "asks", "a1", "contract.md"), "utf8")).toContain("You are a Flowryn ask");
    expect(d.kicks).toBe(1);
  });

  test("at most max_concurrent calls at once; the rest stay queued", async () => {
    const gate = Promise.withResolvers<void>();
    const d = deps(async () => {
      await gate.promise;
      return result(CLAUDE_SUCCESS);
    });
    for (let i = 0; i < 3; i++) newAsk(`Q${i}?`);
    expect(drainAsks(d)).toBe(DEFAULT_ASK.max_concurrent);
    expect(drainAsks(d)).toBe(0);
    expect((db.query("SELECT state FROM asks ORDER BY id").all() as { state: string }[]).map((r) => r.state)).toEqual(["running", "running", "queued"]);
    gate.resolve();
    await settledAsks();
  });

  test("an account paused for its usage limit holds its asks, not the others", async () => {
    const d = deps(async () => result(CLAUDE_SUCCESS));
    tx(db, () => noteUsageLimit(db, "claude", "a worker", "limit reached", Date.now(), { usage_backoff_ms: 3_600_000, usage_backoff_max_ms: 3_600_000 }));
    newAsk();
    db.query("INSERT INTO asks (id, project_id, title, question, harness, account, max_usd, created_by, created_at) VALUES ('a2', 'web', 't', 'q', 'pi', 'pi', 1, 'leader', 2000)").run();
    expect(drainAsks(d)).toBe(1);
    await settledAsks();
    expect(getAsk(db, "a1")!.state).toBe("queued");
    expect(getAsk(db, "a2")!.state).not.toBe("queued");
  });

  test("a drop ends the call through its signal, and the runner leaves the row cancelled", async () => {
    const d = deps(
      (_argv, opts) =>
        new Promise((resolve) => {
          opts.signal!.addEventListener("abort", () => resolve(result("", { code: 143, aborted: true })));
        }),
    );
    const a = newAsk();
    drainAsks(d);
    tx(db, () => recordCancelled(db, a.id, { reason: "no", by: "leader" }, Date.now()));
    expect(abortAsk(a.id)).toBe(true);
    await settledAsks();
    expect(getAsk(db, a.id)).toMatchObject({ state: "cancelled", answer: null });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE task_id = ?1").get(a.id)).toEqual({ n: 0 });
  });

  test("Pi past its cap: the meter aborts the call mid-stream and the ask fails with its spend", async () => {
    const d = deps(async (_argv, opts) => {
      const chunk = new TextEncoder().encode(piStream("step", 0.4));
      for (let i = 0; i < 10 && !opts.signal!.aborted; i++) opts.onStdout!(chunk);
      return result("", { code: 143, aborted: opts.signal!.aborted });
    });
    db.query("INSERT INTO asks (id, project_id, title, question, harness, account, max_usd, created_by, created_at) VALUES ('a1', 'web', 't', 'q', 'pi', 'pi', 1, 'leader', 1)").run();
    drainAsks(d);
    await settledAsks();
    expect(getAsk(db, "a1")).toMatchObject({ state: "failed", reason: "it spent $1.20, over its $1.00 cap" });
  });

  test("a deadline or a failed start is the ask's failure, named", async () => {
    newAsk();
    drainAsks(deps(async () => result("", { code: 124, timedOut: true })));
    await settledAsks();
    expect(getAsk(db, "a1")!.reason).toBe("no answer within 10 min");
    newAsk();
    drainAsks(deps(async () => result("", { code: 127, spawnError: "ENOENT" })));
    await settledAsks();
    expect(getAsk(db, "a2")!.reason).toBe("claude did not start: ENOENT");
  });

  test("a scout request whose scout cannot start (no Herdr here) fails the ask with how to promote it later", async () => {
    newAsk();
    drainAsks(deps(async () => result(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "NEEDS-SCOUT: it must run the tests", total_cost_usd: 0.01 }))));
    await settledAsks();
    const a = getAsk(db, "a1")!;
    expect(a.state).toBe("failed");
    expect(a.reason).toContain("it needs a scout (it must run the tests), which could not start: Herdr is not configured");
    expect((db.query("SELECT line FROM items WHERE task_id = 'a1'").get() as { line: string }).line).toContain("flowryn promote a1 once that is fixed");
  });

  test("startup recovery queues a row left running again", () => {
    const a = newAsk();
    tx(db, () => markStarted(db, a.id, 2_000));
    expect(recoverAsks(db, 3_000)).toEqual({ requeued: ["a1"], failed: [] });
    expect(getAsk(db, a.id)!.state).toBe("queued");
  });
});
