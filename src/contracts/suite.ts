import type { HarnessId } from "../harness/types.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import type { MessageRow } from "../lifecycle/steers.ts";

/**
 * The harness contract suite (design section 5, "Contract tests gate every
 * harness version"): launch, capture the session id, observe busy and idle,
 * deliver while busy and while idle, interrupt, exit, resume, then a verified
 * deliver. Every step runs against one real worker in a real Herdr session,
 * dispatched through a scratch flowrynd, so it exercises the same adapter,
 * hooks or extension, and reconciler as production.
 *
 * The steps are the same for both harnesses; only the worker's instructions
 * differ. Claude gets plain instructions (a real model follows them). Pi gets
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
  /** Poll `check` until it returns a truthy value, or fail with `what` after `timeoutMs`. */
  waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false): Promise<T>;
  /** The design's exit: SIGTERM by pid, start time and executable, SIGKILL after the grace period. */
  exitWorker(): Promise<{ ok: boolean; detail: string }>;
  isAlive(pid: number, start: number, exe: string): Promise<boolean>;
  log(line: string): void;
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
      "bash perl -e 'sleep 120'",
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

async function sendSteer(env: ContractEnv, state: ContractState, text: string): Promise<string> {
  const reply = await env.call("steer", { target: state.task, body: text });
  if (!reply.ok) throw new Error(`steer refused: ${reply.error?.code} ${reply.error?.message}`);
  return String(reply.data.steer);
}

async function waitAcked(env: ContractEnv, id: string, timeoutMs: number): Promise<MessageRow> {
  return env.waitFor(`steer ${id} to be acknowledged`, timeoutMs, () => env.steers().find((m) => m.id === id && m.acked_at !== null));
}

/** A scratch daemon's start and teardown around the steps (teardown waits up to 15 s for it to stop). */
const SETUP_SECONDS = 30;

/**
 * A rough wall-clock estimate for one harness's suite, from the live runs'
 * step times (docs/m5-notes.md). A slow model or a busy machine runs longer;
 * each step's own timeout is the real bound.
 */
export function contractEstimateSeconds(harness: HarnessId): number {
  return SETUP_SECONDS + contractSteps(harness).reduce((total, step) => total + step.typicalSeconds, 0);
}

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
      typicalSeconds: harness === "claude" ? 15 : 55,
      async run(env, state) {
        const id = await sendSteer(env, state, "This steer only needs an acknowledgement; then carry on with your current step.");
        await waitAcked(env, id, LONG_MS);
        const paths = rungPaths(env, id);
        const expected = harness === "claude" ? ["post-tool", "stop"] : ["extension"];
        if (!paths.some((p) => expected.includes(p))) throw new Error(`${id} was carried by ${paths.join(",") || "nothing"}, expected ${expected.join(" or ")}`);
        return `${id} acknowledged, carried by ${paths.join(",")}`;
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
        await env.waitFor("idle again", LONG_MS, () => env.run().liveness === "idle");
        return `${id} woke the idle worker (${paths.join(",")})`;
      },
    },
    {
      name: "interrupt",
      typicalSeconds: 10,
      async run(env, state) {
        await sendSteer(env, state, "Run exactly this command now and wait for it: perl -e 'sleep 120'");
        await env.waitFor("the long command to be running", LONG_MS, () => env.run().liveness === "busy" && env.events().filter((e) => e.kind === "steer.rung").length >= 3);
        // Give the tool call a moment to start inside the turn.
        await Bun.sleep(6_000);
        const reply = await env.call("interrupt", { target: state.task });
        if (!reply.ok) throw new Error(`interrupt not verified: ${reply.error?.message}`);
        const run = env.run();
        if (!(await env.isAlive(run.proc_pid!, run.proc_start!, run.proc_exe!))) throw new Error("the worker died on interrupt");
        return `verified by ${String(reply.data.evidence)}; the worker stayed alive`;
      },
    },
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
      typicalSeconds: harness === "claude" ? 15 : 135,
      async run(env, state) {
        if (!(harness === "pi" && env.scripted)) {
          await sendSteer(env, state, 'Write one line, "contract ok", to $FLOWRYN_REPORT_DIR/report.md, then run $FLOWRYN_BIN deliver --report $FLOWRYN_REPORT_DIR/report.md and end your turn.');
        }
        // A scout lands with its verified report, and the daemon then cleans it up (design section 8).
        const run = await env.waitFor("a verified deliver --report", LONG_MS, () => (["landed", "cleaned"].includes(env.run().state) ? env.run() : null));
        return `run ${run.id} ${run.state} with ${String(lastEvent(env, "run.delivered")?.payload.report)}`;
      },
    },
  ];
}
