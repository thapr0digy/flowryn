/**
 * Asks end to end (docs/notes/2026-10-30-ask-a-lightweight-4v.md): `dispatch --kind ask` through
 * the CLI and a real daemon, the print-mode call played by the stand-in harnesses
 * (test/helpers/fake-ask.ts, which logs each call's argv, cwd and stdin), and the answer, scout,
 * cap, drop and restart paths as the leader sees them.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AskRow } from "../../src/ask/store.ts";
import { askCallLog, makeFleetEnv, type FleetEnv, type FleetOptions } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function fleet(options: FleetOptions = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}

function ask(env: FleetEnv, id: string): AskRow {
  const db = env.h.db();
  try {
    return db.query("SELECT * FROM asks WHERE id = ?1").get(id) as AskRow;
  } finally {
    db.close();
  }
}

function rows<T>(env: FleetEnv, sql: string, ...params: (string | number)[]): T[] {
  const db = env.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

interface Call {
  harness: string;
  argv: string[];
  cwd: string;
  stdin: string;
}

function calls(env: FleetEnv): Call[] {
  const path = askCallLog(env.h.home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
}

async function dispatchAsk(env: FleetEnv, question: string, extra: string[] = []): Promise<string> {
  const queued = await env.json(["dispatch", "web", "--kind", "ask", ...extra, "--body-file", "-"], { stdin: question });
  if (queued.code !== 0) throw new Error(`dispatch --kind ask failed (${queued.code}): ${JSON.stringify(queued.reply)}`);
  return String((queued.reply.data as { ask: string }).ask);
}

async function ended(env: FleetEnv, id: string, timeoutMs = 15_000): Promise<AskRow> {
  await waitUntil(() => !["queued", "running"].includes(ask(env, id).state), timeoutMs, `ask ${id} to end`);
  return ask(env, id);
}

test("a Claude ask answers in print mode, read-only and capped, in the project's checkout, and its answer lands as one item the leader's read closes", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "What is this project?\nASK: reply It is a scratch project. It has one README.\\nNothing else.");
  expect(id).toBe("a1");
  const row = await ended(env, id);
  expect(row).toMatchObject({ state: "answered", answer: "It is a scratch project. It has one README.\nNothing else.", cost_usd: 0.0123, attempts: 1, harness: "claude" });

  const [call] = calls(env);
  expect(call!.harness).toBe("claude");
  expect(realpathSync(call!.cwd)).toBe(realpathSync(env.repo));
  expect(call!.stdin).toBe("What is this project?\nASK: reply It is a scratch project. It has one README.\\nNothing else.");
  const argv = call!.argv.join(" ");
  for (const part of ["-p", "--output-format json", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--tools Read,Grep,Glob,WebFetch,WebSearch", "--allowedTools Read,Grep,Glob,WebFetch,WebSearch", "--permission-mode dontAsk", "--max-budget-usd 1"]) {
    expect(argv).toContain(part);
  }
  expect(argv).not.toContain("--session-id");

  const items = rows<{ id: string; kind: string; lane: string; line: string; state: string }>(env, "SELECT id, kind, lane, line, state FROM items WHERE task_id = ?1", id);
  expect(items).toEqual([{ id: items[0]!.id, kind: "answer_ready", lane: "P1", line: "Answer (web): It is a scratch project.; flowryn show a1", state: "open" }]);

  const fleetView = await env.json(["fleet"]);
  expect(JSON.stringify(fleetView.reply)).toContain("Answer (web): It is a scratch project.");

  const shown = await env.json(["show", id]);
  expect(shown.code).toBe(0);
  expect(shown.reply.data).toMatchObject({ ask: id, state: "answered", project: "web", spend: "$0.0123 of a $1.00 cap", answer: "It is a scratch project. It has one README.\nNothing else.", read: `closed ${items[0]!.id}` });
  expect(rows<{ state: string }>(env, "SELECT state FROM items WHERE id = ?1", items[0]!.id)).toEqual([{ state: "resolved" }]);
}, 40_000);

test("assumption: the call carries no Flowryn or parent-session environment, and the account's own login", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "Which login?\nASK: argv");
  const row = await ended(env, id);
  const seen = JSON.parse(row.answer!) as { env: Record<string, string | null> };
  expect(seen.env.FLOWRYN_HOME).toBeNull();
  expect(seen.env.CLAUDECODE).toBeNull();
  // [workers.claude] config_dir pins the login, as a worker pane gets it.
  expect(seen.env.CLAUDE_CONFIG_DIR).toBe(env.claudeStore);
}, 40_000);

test("a Pi ask answers from its JSON stream and records the summed cost", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "Two parts.\nFLOWRYN-SCRIPT: say First part. ;; say The answer is 42.\nASK: cost 0.002", ["--harness", "pi"]);
  const row = await ended(env, id);
  expect(row).toMatchObject({ state: "answered", answer: "The answer is 42.", harness: "pi" });
  expect(row.cost_usd).toBeCloseTo(0.004, 6);
  const argv = calls(env)[0]!.argv.join(" ");
  for (const part of ["-p", "--mode json", "--no-session", "--tools read,grep,find,ls", "--append-system-prompt"]) expect(argv).toContain(part);
}, 40_000);

test("over the cap: Claude's budget error and Pi's metered stream each end the ask failed, with its spend", async () => {
  const env = await fleet();
  const claude = await dispatchAsk(env, "Expensive.\nASK: overcap", ["--max-usd", "0.5"]);
  const pi = await dispatchAsk(env, "Expensive.\nASK: overcap\nASK: cost 0.01", ["--harness", "pi", "--max-usd", "0.05"]);
  const c = await ended(env, claude);
  expect(c.state).toBe("failed");
  expect(c.reason).toContain("reached its $0.50 cap");
  expect(c.cost_usd).toBeCloseTo(0.51, 6);
  const started = Date.now();
  const p = await ended(env, pi);
  // The fake keeps spending for 10 s unless stopped: the meter stops it at the sixth message.
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(p.state).toBe("failed");
  expect(p.reason).toContain("over its $0.05 cap");
  expect(p.cost_usd!).toBeGreaterThan(0.05);
  expect(p.cost_usd!).toBeLessThan(0.1);
  const failedItems = rows<{ task_id: string; line: string }>(env, "SELECT task_id, line FROM items WHERE kind = 'ask_failed' ORDER BY task_id");
  expect(failedItems.map((i) => i.task_id)).toEqual([claude, pi]);
  expect(failedItems[0]!.line).toContain("--max-usd");
}, 40_000);

test("an ask that needs to write becomes a scout on the same question; with --no-promote its reason is the answer", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "Does the build pass?\nASK: scout it needs the test suite run");
  await waitUntil(() => ask(env, id).state === "promoted", 15_000, "the ask promoted");
  const row = ask(env, id);
  expect(row.reason).toBe("it needs the test suite run");
  const [policy] = rows<{ task_id: string; kind: string; project_id: string }>(env, "SELECT task_id, kind, project_id FROM task_policy WHERE task_id = ?1", row.promoted_task!);
  expect(policy).toEqual({ task_id: row.promoted_task!, kind: "scout", project_id: "web" });
  const dispatched = rows<{ payload: string }>(env, "SELECT payload FROM events WHERE kind = 'run.dispatched' AND task_id = ?1", row.promoted_task!);
  expect(JSON.parse(dispatched[0]!.payload).body).toContain(`(Promoted from ask ${id}, which could not answer it read-only: it needs the test suite run)`);
  expect(rows(env, "SELECT 1 FROM items WHERE task_id = ?1 AND state IN ('open','presented')", id)).toEqual([]);

  const kept = await dispatchAsk(env, "Does it deploy?\nASK: scout it needs a deploy", ["--no-promote"]);
  expect(await ended(env, kept)).toMatchObject({ state: "answered", answer: "NEEDS-SCOUT: it needs a deploy", promoted_task: null });
}, 40_000);

test("a failed ask is promoted by hand; a running one is not", async () => {
  const env = await fleet();
  const failed = await dispatchAsk(env, "Broken.\nASK: fail the model refused");
  expect(await ended(env, failed)).toMatchObject({ state: "failed" });
  expect(ask(env, failed).reason).toContain("the model refused");
  const busy = await dispatchAsk(env, "Slow.\nASK: sleep 30000");
  await waitUntil(() => ask(env, busy).state === "running", 10_000, "the slow ask running");
  const refused = await env.json(["promote", busy]);
  expect(refused.code).not.toBe(0);
  expect(JSON.stringify(refused.reply)).toContain("only one that ended");
  const promoted = await env.json(["promote", failed]);
  expect(promoted.code).toBe(0);
  expect(promoted.reply.data).toMatchObject({ ask: failed, kind: "scout" });
  expect(ask(env, failed)).toMatchObject({ state: "promoted", promoted_task: (promoted.reply.data as { task: string }).task });
  await env.json(["drop", busy, "--body-file", "-"], { stdin: "done testing" });
}, 40_000);

test("drop cancels a running ask and ends its call; a second drop is refused", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "Slow.\nASK: sleep 30000\nASK: reply too late");
  await waitUntil(() => calls(env).length === 1 && ask(env, id).state === "running", 10_000, "the call running");
  const dropped = await env.json(["drop", id, "--body-file", "-"], { stdin: "asked the wrong thing" });
  expect(dropped.code).toBe(0);
  expect(dropped.reply.data).toMatchObject({ ask: id, was: "running", state: "cancelled" });
  expect(ask(env, id)).toMatchObject({ state: "cancelled", reason: "dropped: asked the wrong thing", answer: null });
  const again = await env.json(["drop", id, "--body-file", "-"], { stdin: "again" });
  expect(again.code).not.toBe(0);
  // The call was ended: the daemon's owned ledger has nothing left for it.
  await waitUntil(() => rows(env, "SELECT 1 FROM events WHERE kind = 'ask.cancelled'").length === 1, 5_000, "the cancel event");
  await Bun.sleep(500);
  expect(ask(env, id).state).toBe("cancelled");
}, 40_000);

test("[ask] max_concurrent holds the rest queued, oldest first, and fleet lists them", async () => {
  const env = await fleet({ extraConfig: "[ask]\nmax_concurrent = 1" });
  const first = await dispatchAsk(env, "One.\nASK: sleep 1500\nASK: reply one.");
  const second = await dispatchAsk(env, "Two.\nASK: reply two.");
  expect(ask(env, second).state).toBe("queued");
  const listed = await env.json(["fleet"]);
  expect(JSON.stringify((listed.reply.data as { asks: string[] }).asks)).toContain(`${second} queued web`);
  expect((await ended(env, first)).answer).toBe("one.");
  expect((await ended(env, second)).answer).toBe("two.");
  expect(ask(env, second).started_at!).toBeGreaterThanOrEqual(ask(env, first).ended_at!);
}, 40_000);

test("refusals: task flags on an ask, ask flags on a task, a cap out of range", async () => {
  const env = await fleet();
  for (const [args, text] of [
    [["--kind", "ask", "--base", "dev"], "an ask takes no --base"],
    [["--kind", "ask", "--after", "pr:3"], "an ask takes no --after"],
    [["--kind", "ask", "--max-usd", "50"], "--max-usd must be a dollar amount above 0 and at most 20"],
    [["--kind", "ask", "--max-usd", "zero"], "--max-usd must be a dollar amount"],
    [["--kind", "scout", "--max-usd", "1"], "--max-usd and --no-promote go with --kind ask"],
  ] as [string[], string][]) {
    const reply = await env.json(["dispatch", "web", ...args, "--body-file", "-"], { stdin: "A question?" });
    expect(reply.code, JSON.stringify(reply.reply)).not.toBe(0);
    expect(JSON.stringify(reply.reply)).toContain(text);
  }
  expect(rows(env, "SELECT id FROM asks")).toEqual([]);
}, 40_000);

test("a daemon killed mid-call: the next start ends the call's group and runs the ask again, once", async () => {
  const env = await fleet();
  const id = await dispatchAsk(env, "Slow.\nASK: sleep 4000\nASK: reply finally.");
  await waitUntil(() => calls(env).length === 1, 10_000, "the call running");
  await env.daemon.kill9();
  await env.restartDaemon();
  const row = await ended(env, id, 20_000);
  expect(row).toMatchObject({ state: "answered", answer: "finally.", attempts: 2 });
  expect(rows<{ kind: string }>(env, "SELECT kind FROM events WHERE task_id = ?1 ORDER BY seq", id).map((e) => e.kind)).toEqual(["ask.queued", "ask.started", "ask.requeued", "ask.started", "ask.answered"]);
  expect(calls(env)).toHaveLength(2);
}, 60_000);

test("show of an answer item is the ask's view; a cut answer points at its whole text on disk", async () => {
  const env = await fleet({ extraConfig: "[ask]\nmax_answer_bytes = 200" });
  const id = await dispatchAsk(env, "Long.\nASK: big 1000");
  const row = await ended(env, id);
  expect(row.answer_path).toBe(join(env.h.home, "state", "asks", id, "answer.md"));
  expect(readFileSync(row.answer_path!, "utf8")).toHaveLength("Big answer. ".length + 1000);
  expect(row.answer).toContain(`[cut at 200 bytes; the whole answer is in ${row.answer_path}]`);
  const [item] = rows<{ id: string }>(env, "SELECT id FROM items WHERE task_id = ?1", id);
  const shown = await env.json(["show", item!.id]);
  expect(shown.reply.data).toMatchObject({ ask: id, state: "answered", whole_answer: row.answer_path });
}, 40_000);
