import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId } from "../harness/types.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import { formatMs, steerStatus, type MessageRow } from "../lifecycle/steers.ts";

/**
 * The harness contract suite (design section 5, "Contract tests gate every
 * harness version"): launch, capture the session id, observe busy and idle,
 * deliver while busy and while idle, interrupt, (Claude only) the toolkit's
 * live check, the worker's own temp dir, exit, resume, then a verified deliver. Every step runs against one real worker in a real Herdr session,
 * dispatched through a scratch flowrynd, so it exercises the same adapter,
 * hooks or extension, and reconciler as production.
 *
 * The steps are the same for both harnesses, except Claude's toolkit step;
 * only the worker's instructions differ. Each steer step reports the steer's own carried, seen and acked
 * times from the scratch database beside the step's seconds, so the numbers
 * measure the steer rather than the step's other waits or the runner's
 * polling. Every steer is acknowledged before the worker exits, so the
 * resumed worker has nothing left over to re-run. Claude gets plain instructions (a real model follows them). Pi gets
 * the same plus, with the offline scripted provider (spikes/pi/lib), a script
 * that plays the model's side deterministically.
 */

export interface ContractEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export interface ContractEnv {
  harness: HarnessId;
  /** The scripted Pi provider plays the model: its steps are fixed, so each steer is acknowledged by script. */
  scripted: boolean;
  /** Call the scratch daemon as its leader. */
  call(verb: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } }>;
  run(): RunRow;
  events(): ContractEvent[];
  steers(): MessageRow[];
  /** The latest worker hook as the run's hook evidence records it, or null. */
  lastHook(): { hook: string | null; signal: string; at: number } | null;
  /**
   * Poll `check` until it returns a truthy value, or fail with `what` after
   * `timeoutMs`; `explain`, when given, adds what it says to the timeout's message.
   * A `check` that throws fails the wait at once with its error.
   */
  waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, explain?: () => string): Promise<T>;
  /** Is a process under the worker's harness process running this command line (its argv joined by spaces, as ps shows it)? */
  commandRunning(command: string): Promise<boolean>;
  /** The design's exit: SIGTERM by pid, start time and executable, SIGKILL after the grace period. */
  exitWorker(): Promise<{ ok: boolean; detail: string }>;
  isAlive(pid: number, start: number, exe: string): Promise<boolean>;
  log(line: string): void;
  /** The directory holding the Claude worker's `.claude.json` ([workers.claude] config_dir, CLAUDE_CONFIG_DIR or HOME); null for Pi. */
  claudeStore: string | null;
  /** The run's FLOWRYN_REPORT_DIR. */
  reportDir(): string;
  /** The TMPDIR the run's worker must see, in and out of its sandbox (src/lifecycle/run-tmp.ts). */
  workerTmpDir(): string;
}

export interface ContractStep {
  name: string;
  /** Roughly how long the step takes on a healthy machine, in seconds, for doctor's up-front estimate. */
  typicalSeconds: number;
  run(env: ContractEnv, state: ContractState): Promise<string>;
}

export interface ContractState {
  task: string;
  run: string;
  session: string;
  pid: number;
}

const LONG_MS = 240_000;
const MID_MS = 120_000;

/** What the worker is told. Steer ids are predictable (m1, m2, ...) because the scratch daemon is fresh. */
export function contractBody(harness: HarnessId, scripted: boolean): string {
  const lines = [
    "Flowryn contract test for the worker adapter. Work one step at a time with your shell tool.",
    "1. Run exactly this command and wait for it to finish: perl -e 'sleep 25'",
    "2. Then reply with the single word ONE and end your turn.",
    "Steers from your leader may arrive while you work or wait. Do what each one says, then acknowledge it with $FLOWRYN_BIN ack <id>.",
  ];
  if (harness === "pi" && scripted) {
    const script = [
      "bash perl -e 'sleep 25'",
      "bash $FLOWRYN_BIN ack m1",
      "say ONE",
      "bash $FLOWRYN_BIN ack m2",
      "say TWO",
      "bash $FLOWRYN_BIN ack m3",
      "bash perl -e 'sleep 60'",
      "bash $FLOWRYN_BIN ack m4",
      "say FIVE",
      "bash $FLOWRYN_BIN ack m5",
      "bash perl -e 'sleep 120'",
      "bash $FLOWRYN_BIN ack m6",
      "say FOUR",
      "bash $FLOWRYN_BIN ack m7",
      `bash ${TMPDIR_COMMAND}`,
      "say SEVEN",
      `bash mkdir -p "$FLOWRYN_REPORT_DIR" && echo 'contract ok' > "$FLOWRYN_REPORT_DIR/report.md" && $FLOWRYN_BIN deliver --report "$FLOWRYN_REPORT_DIR/report.md"`,
      "say DONE",
    ];
    lines.push(`FLOWRYN-SCRIPT: ${script.join(" ;; ")}`);
  }
  return lines.join("\n");
}

function lastEvent(env: ContractEnv, kind: string): ContractEvent | undefined {
  return env.events().filter((e) => e.kind === kind).at(-1);
}

function rungPaths(env: ContractEnv, steer: string): string[] {
  return env
    .events()
    .filter((e) => e.kind === "steer.rung" && e.payload.steer === steer)
    .map((e) => String(e.payload.path));
}

async function sendSteer(env: ContractEnv, state: ContractState, text: string, urgent = false): Promise<string> {
  const reply = await env.call("steer", { target: state.task, body: text, ...(urgent ? { urgent: true } : {}) });
  if (!reply.ok) throw new Error(`steer refused: ${reply.error?.code} ${reply.error?.message}`);
  return String(reply.data.steer);
}

/**
 * How long a turn must have stayed ended after a steer was seen, unacknowledged,
 * before the wait calls it ignored: it absorbs any hook-ordering flap between a
 * turn end and a continuation. Nothing else acknowledges a seen steer within a
 * step's window (it re-rings only on the contract's 600 s ring interval).
 */
export const IGNORED_GRACE_MS = 5_000;

/**
 * Why steer `steer` can no longer be acknowledged, or null while it still can
 * (it is acknowledged, or the wait should go on). Plain rules on the run and the
 * steer, in order: the run delivered (landed or cleaned) or ended (failed or
 * cancelled) first; or the steer was seen and the turn then ended (a turn-end
 * hook set `idle_since` after `seen_at`) without an acknowledgement, and has
 * stayed ended for IGNORED_GRACE_MS. `idle_since`, not `liveness`, since a
 * lapsed busy lease mid-tool turns liveness idle with the turn still running.
 */
export function ackBlocker(run: RunRow, steer: MessageRow | undefined, now: number): string | null {
  if (steer?.acked_at != null) return null;
  const id = steer?.id ?? "the steer";
  const status = steer ? `; ${id} ${steerStatus(steer, now)}` : "";
  if (run.state === "landed" || run.state === "cleaned") return `the worker delivered before ${id} (run ${run.state})${status}`;
  if (run.state === "failed" || run.state === "cancelled") return `the run ${run.state} before ${id} was acknowledged${status}`;
  if (!steer || steer.seen_at === null) return null;
  if (run.idle_since === null || run.idle_since <= steer.seen_at || now - run.idle_since < IGNORED_GRACE_MS) return null;
  return `${id} seen +${formatMs(steer.seen_at - steer.created_at)}, turn ended without ack (model ignored the steer)${status}`;
}

/** Wait for steer `id`'s acknowledgement; fail at once with the named cause when it can no longer come, and with its timings on a timeout. */
export async function waitAcked(env: ContractEnv, id: string, timeoutMs: number): Promise<MessageRow> {
  return env.waitFor(
    `steer ${id} to be acknowledged`,
    timeoutMs,
    () => {
      const steer = env.steers().find((m) => m.id === id);
      if (steer?.acked_at != null) return steer;
      const blocker = ackBlocker(env.run(), steer, Date.now());
      if (blocker) throw new Error(blocker);
      return null;
    },
    () => timings(env, id),
  );
}

/** A scratch daemon's start and teardown around the steps (teardown waits up to 15 s for it to stop). */
const SETUP_SECONDS = 30;

/**
 * A rough wall-clock estimate for one harness's suite, from the live runs'
 * step times (docs/m5-notes.md; Pi's from its scripted gate,
 * docs/notes/2026-10-11-make-the-pi-rv.md). A slow model or a busy machine runs longer;
 * each step's own timeout is the real bound.
 */
export function contractEstimateSeconds(harness: HarnessId): number {
  return SETUP_SECONDS + contractSteps(harness).reduce((total, step) => total + step.typicalSeconds, 0);
}

/** "m1 carried +2ms, seen +2.7s, acked +8.8s": the steer's own timings, after its creation. */
function timings(env: ContractEnv, id: string): string {
  const m = env.steers().find((x) => x.id === id);
  return m ? `${id} ${steerStatus(m, Date.now())}` : `${id} not found`;
}

/**
 * Wait until the worker's long command is running, so a steer sent then
 * meets a running tool. Claude's pre-tool hook says so for every tool. Pi's
 * extension pings a tool start at most once a minute, so for Pi the process
 * table says it: until the command runs, an urgent steer meets the model's
 * inference instead and blocks the tool call rather than cutting it (a real
 * model can take half a minute to call it after the acknowledgement).
 */
async function waitLongCommand(env: ContractEnv, command: string, since: number): Promise<void> {
  const what = `\`${command}\` to start`;
  if (env.harness === "claude") await waitToolStart(env, what, since, MID_MS);
  else await env.waitFor(what, MID_MS, () => env.commandRunning(command));
}

/** Wait until the worker starts a tool call after `since`: a steer sent then waits only for that tool. */
async function waitToolStart(env: ContractEnv, what: string, since: number, timeoutMs: number): Promise<void> {
  await env.waitFor(what, timeoutMs, () => {
    const last = env.lastHook();
    return last !== null && last.hook === "pre-tool" && last.at >= since;
  });
}

/** The MCP server the toolkit's static layer must hide from a Claude worker (src/policy/static.ts). */
const HIDDEN_PREFIX = "mcp__claude-in-chrome__";

/** Whether the user's Claude offers claude-in-chrome at all: only then can the step show it hidden. */
export function chromeEnabled(store: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(store, ".claude.json"), "utf8")) as { claudeInChromeDefaultEnabled?: unknown }).claudeInChromeDefaultEnabled === true;
  } catch {
    return false;
  }
}

/**
 * The tools a Claude session was offered, from its transcript: Claude records
 * its deferred tools as `deferred_tools_delta` attachments (seen on 2.1.295),
 * which include the built-in deferred tools, so a session always has one.
 */
export function offeredTools(transcript: string): string[] {
  const names = new Set<string>();
  for (const line of transcript.split("\n")) {
    if (!line.includes("deferred_tools_delta")) continue;
    try {
      const record = JSON.parse(line) as { attachment?: { type?: string; addedNames?: unknown; readdedNames?: unknown } };
      if (record.attachment?.type !== "deferred_tools_delta") continue;
      for (const list of [record.attachment.addedNames, record.attachment.readdedNames]) {
        if (Array.isArray(list)) for (const name of list) if (typeof name === "string") names.add(name);
      }
    } catch {
      // A torn last line while Claude writes: the records before it still count.
    }
  }
  return [...names];
}

/** The hidden-tools verdict: an error message, or null with a detail for the step's line. */
export function hiddenToolsVerdict(offered: string[], enabled: boolean): { error: string | null; detail: string } {
  const shown = offered.filter((name) => name.startsWith(HIDDEN_PREFIX));
  if (shown.length > 0) return { error: `the worker was offered ${shown.length} claude-in-chrome tools (${shown[0]}, ...)`, detail: "" };
  if (!enabled) return { error: null, detail: "claude-in-chrome is not enabled in this Claude config, so hiding it is not shown" };
  // A check that cannot see the tool list must not pass: Claude may have changed how it records it.
  if (offered.length === 0) return { error: "the transcript lists no deferred tools, so hiding claude-in-chrome cannot be shown", detail: "" };
  return { error: null, detail: `none of its ${offered.length} deferred tools is claude-in-chrome` };
}

/** What the temp dir step has the worker run with its own shell tool: inside Claude's sandbox, when the user runs it. */
const TMPDIR_COMMAND = 'echo "$TMPDIR" > "$FLOWRYN_REPORT_DIR/tmpdir.txt"';

function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The worker's shell sees its run's own TMPDIR
 * (docs/notes/2026-10-22-give-every-worker-73.md): for Claude, the per-uid
 * dir its sandbox derives from CLAUDE_CODE_TMPDIR, the same path an
 * unsandboxed command inherits; never the shared /tmp/claude-<uid> or the
 * user's own temp dir.
 */
const tmpDirStep: ContractStep = {
  name: "temp dir",
  typicalSeconds: 15,
  async run(env, state) {
    const id = await sendSteer(env, state, `Acknowledge this steer. Then run exactly this command with your shell tool: ${TMPDIR_COMMAND}. Then reply with the single word SEVEN and end your turn.`);
    await waitAcked(env, id, LONG_MS);
    const file = join(env.reportDir(), "tmpdir.txt");
    const seen = await env.waitFor("the worker to write its $TMPDIR", LONG_MS, () => {
      try {
        return readFileSync(file, "utf8").trim() || null;
      } catch {
        return null;
      }
    });
    await env.waitFor("idle again", LONG_MS, () => env.run().liveness === "idle");
    const expected = env.workerTmpDir();
    if (!sameDir(seen, expected)) throw new Error(`the worker's shell has TMPDIR ${seen}, not its run's own ${expected}`);
    return `TMPDIR ${seen}${seen === expected ? "" : ` (${expected})`}; ${timings(env, id)}`;
  },
};

/**
 * Claude only: the toolkit's live check (ship 2). A raw `gh` is denied by the
 * PreToolUse hook in bypassPermissions, and the bare-name `permissions.deny`
 * keeps claude-in-chrome out of the tools the model is offered.
 */
const toolkitStep: ContractStep = {
  name: "toolkit",
  typicalSeconds: 15,
  async run(env, state) {
    const id = await sendSteer(
      env,
      state,
      "Acknowledge this steer. Then run exactly this command once: gh --version. Flowryn's toolkit refuses it on purpose and that refusal is the test: do not retry it or run anything else. Then reply with the single word SIX and end your turn.",
    );
    await waitAcked(env, id, LONG_MS);
    const denied = await env.waitFor("the toolkit to deny gh", LONG_MS, () =>
      env.events().find((e) => e.kind === "toolkit.denied" && e.payload.rule === "github" && e.payload.harness === "claude"),
    );
    await env.waitFor("idle again", LONG_MS, () => env.run().liveness === "idle");
    const transcriptPath = env.run().transcript_path;
    let transcript = "";
    try {
      transcript = transcriptPath ? readFileSync(transcriptPath, "utf8") : "";
    } catch {
      transcript = "";
    }
    const hidden = hiddenToolsVerdict(offeredTools(transcript), env.claudeStore !== null && chromeEnabled(env.claudeStore));
    if (hidden.error) throw new Error(hidden.error);
    return `gh denied (${String(denied.payload.rule)} rule); ${hidden.detail}; ${timings(env, id)}`;
  },
};

export function contractSteps(harness: HarnessId): ContractStep[] {
  return [
    {
      name: "launch",
      typicalSeconds: 5,
      async run(env, state) {
        const run = await env.waitFor("the worker's launch and worker-start", MID_MS, () => {
          const r = env.run();
          if (r.state === "failed") throw new Error(`the run failed: ${JSON.stringify(lastEvent(env, "run.failed")?.payload)}`);
          return r.proc_pid !== null && r.worker_started_at !== null ? r : null;
        });
        state.pid = run.proc_pid!;
        const started = lastEvent(env, "run.worker_started")!;
        if (started.payload.isolation !== "ok") throw new Error("the isolation assertion did not pass");
        return `pane ${run.pane_id}, pid ${run.proc_pid} (${run.proc_exe}), isolation ok`;
      },
    },
    {
      name: "session id",
      typicalSeconds: 1,
      async run(env, state) {
        const started = lastEvent(env, "run.worker_started")!;
        const reported = String(started.payload.session ?? "");
        if (reported !== state.session) throw new Error(`worker-start reported session ${reported}, launched with ${state.session}`);
        return `${reported} (chosen by Flowryn at launch)`;
      },
    },
    {
      name: "busy",
      typicalSeconds: 2,
      async run(env) {
        await env.waitFor("liveness busy", MID_MS, () => env.run().liveness === "busy");
        return "busy from the harness's own turn start";
      },
    },
    {
      name: "deliver while busy",
      typicalSeconds: harness === "claude" ? 15 : 30,
      async run(env, state) {
        // Sent once the sleep is running, so the expected delivery is the rest of that tool call.
        await waitToolStart(env, "the worker to start its first tool call", env.run().launched_at ?? 0, MID_MS);
        const id = await sendSteer(env, state, "This steer only needs an acknowledgement; then carry on with your current step.");
        await waitAcked(env, id, LONG_MS);
        const paths = rungPaths(env, id);
        const expected = harness === "claude" ? ["post-tool", "stop"] : ["extension"];
        if (!paths.some((p) => expected.includes(p))) throw new Error(`${id} was carried by ${paths.join(",") || "nothing"}, expected ${expected.join(" or ")}`);
        return `${timings(env, id)}; carried by ${paths.join(",")}`;
      },
    },
    {
      name: "idle",
      typicalSeconds: harness === "claude" ? 30 : 5,
      async run(env) {
        await env.waitFor("liveness idle after the turn", LONG_MS, () => env.run().liveness === "idle");
        return "idle from the harness's own turn end";
      },
    },
    {
      name: "deliver while idle",
      typicalSeconds: 10,
      async run(env, state) {
        const id = await sendSteer(env, state, "Acknowledge this steer, then reply with the single word TWO and end your turn.");
        await waitAcked(env, id, LONG_MS);
        const paths = rungPaths(env, id);
        const expected = harness === "claude" ? "waiter" : "extension";
        if (!paths.includes(expected)) throw new Error(`${id} was carried by ${paths.join(",") || "nothing"}, expected ${expected}`);
        const woke = timings(env, id);
        await env.waitFor("idle again", LONG_MS, () => env.run().liveness === "idle");
        return `${woke}; woke the idle worker (${paths.join(",")})`;
      },
    },
    {
      name: "urgent while busy",
      typicalSeconds: harness === "claude" ? 20 : 5,
      async run(env, state) {
        // A long tool, then an urgent steer a second into it: the tool is cut at the threshold, never run to its end.
        const long = await sendSteer(env, state, "First acknowledge this steer. Then run exactly this command and wait for it: perl -e 'sleep 60'");
        const acked = await waitAcked(env, long, LONG_MS);
        await waitLongCommand(env, "perl -e sleep 60", acked.acked_at!);
        await Bun.sleep(1_000);
        const id = await sendSteer(
          env,
          state,
          "Urgent: the 60-second command is cancelled; do not run it again. Acknowledge this steer, then reply with the single word FIVE and end your turn.",
          true,
        );
        const steer = await waitAcked(env, id, MID_MS);
        if (steer.preempted_at === null) throw new Error(`${id} was acknowledged without cutting the running tool`);
        const run = env.run();
        if (!(await env.isAlive(run.proc_pid!, run.proc_start!, run.proc_exe!))) throw new Error("the worker died on the cut");
        await env.waitFor("idle again", LONG_MS, () => env.run().liveness === "idle");
        return `${timings(env, id)}; carried by ${rungPaths(env, id).join(",")}`;
      },
    },
    {
      name: "interrupt",
      typicalSeconds: 10,
      async run(env, state) {
        // Acknowledged first, so the interrupted command leaves no open steer for the resumed worker to re-run.
        const long = await sendSteer(env, state, "First acknowledge this steer. Then run exactly this command and wait for it: perl -e 'sleep 120'");
        const acked = await waitAcked(env, long, LONG_MS);
        await waitLongCommand(env, "perl -e sleep 120", acked.acked_at!);
        const reply = await env.call("interrupt", { target: state.task });
        if (!reply.ok) throw new Error(`interrupt not verified: ${reply.error?.message}`);
        const run = env.run();
        if (!(await env.isAlive(run.proc_pid!, run.proc_start!, run.proc_exe!))) throw new Error("the worker died on interrupt");
        // An interrupted worker is idle: a steer now must reach it at once, through the waiter armed at its turn start.
        const after = await sendSteer(env, state, "The 120-second command was only a test of the interrupt and is cancelled; do not run it again. Acknowledge this steer, then reply with the single word FOUR and end your turn.");
        await waitAcked(env, after, MID_MS);
        return `verified by ${String(reply.data.evidence)}; the worker stayed alive; then ${timings(env, after)}`;
      },
    },
    ...(harness === "claude" ? [toolkitStep] : []),
    tmpDirStep,
    {
      name: "exit",
      typicalSeconds: 2,
      async run(env, state) {
        const before = env.run();
        const exited = await env.exitWorker();
        if (!exited.ok) throw new Error(`exit not verified: ${exited.detail}`);
        if (await env.isAlive(before.proc_pid!, before.proc_start!, before.proc_exe!)) throw new Error("the harness process survived exit");
        state.pid = before.proc_pid!;
        return `pid ${before.proc_pid} gone (${exited.detail})`;
      },
    },
    {
      name: "resume",
      typicalSeconds: 5,
      async run(env, state) {
        const run = await env.waitFor("the reconciler to resume the worker from its session", LONG_MS, () => {
          const r = env.run();
          return r.resume_count === 1 && r.proc_pid !== null && r.proc_pid !== state.pid && r.worker_started_at !== null && r.worker_started_at >= (r.launched_at ?? 0) ? r : null;
        });
        const started = lastEvent(env, "run.worker_started")!;
        if (String(started.payload.session) !== state.session) throw new Error(`the resumed worker reported session ${String(started.payload.session)}`);
        return `resumed as pid ${run.proc_pid} in the same session`;
      },
    },
    {
      name: "deliver",
      typicalSeconds: harness === "claude" ? 15 : 2,
      async run(env, state) {
        let id: string | null = null;
        if (!(harness === "pi" && env.scripted)) {
          id = await sendSteer(env, state, 'Write one line, "contract ok", to $FLOWRYN_REPORT_DIR/report.md, then run $FLOWRYN_BIN deliver --report $FLOWRYN_REPORT_DIR/report.md and end your turn.');
        }
        // A scout lands with its verified report, and the daemon then cleans it up (design section 8).
        const run = await env.waitFor("a verified deliver --report", LONG_MS, () => (["landed", "cleaned"].includes(env.run().state) ? env.run() : null));
        return `run ${run.id} ${run.state} with ${String(lastEvent(env, "run.delivered")?.payload.report)}${id ? `; ${timings(env, id)}` : ""}`;
      },
    },
  ];
}
