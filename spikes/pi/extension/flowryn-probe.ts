// Flowryn M0 probe: one Pi extension shared by every spikes/pi/pNN-*.sh spike.
//
// Load it only per process: `pi -e spikes/pi/extension/flowryn-probe.ts`.
// Never copy it into ~/.pi/agent/extensions or a project .pi/extensions.
//
// API source of truth: @earendil-works/pi-coding-agent 0.87.1 (npm, 2026-09-22),
// dist/core/extensions/types.d.ts and docs/extensions.md from that tarball, plus
// Firstmate's live extensions (/Users/pr0digy/projects/firstmate/.pi/extensions,
// verified by Firstmate against Pi 0.80.5 - 0.84.4). Each call cites where it was
// seen; "types.d.ts" means the 0.87.1 declaration file.
//
// Output: JSON lines appended to $FLOWRYN_PROBE_LOG, one per observation:
//   {"ts": ISO, "t": epoch-ms, "pid", "instance", "ev": <kind>, ...fields}
//
// Controls:
//   Environment (read once at load):
//     FLOWRYN_PROBE_LOG                 JSONL output path (probe is inert without it)
//     FLOWRYN_PROBE_CTL                 JSONL command file polled every 250 ms
//     FLOWRYN_PROBE_INSTANCE            label copied into every line
//     FLOWRYN_PROBE_BRIEFING            text attached at session_start
//     FLOWRYN_PROBE_BRIEF_DELIVER       deliverAs for the briefing (default nextTurn)
//     FLOWRYN_PROBE_REBRIEFING          text attached after session_compact; "{n}" becomes
//                                       the compaction count (1, 2, ...)
//     FLOWRYN_PROBE_REBRIEF_DELIVER     deliverAs for the re-brief (default nextTurn); "auto"
//                                       steers when willRetry is set or the agent is busy,
//                                       else nextTurn
//     FLOWRYN_PROBE_BLOCK_SHELL         "0" disables the flowryn merge/approve shell block
//     FLOWRYN_PROBE_CONFIRM_TIMEOUT_MS  optional ctx.ui.confirm timeout
//     FLOWRYN_PROBE_SYSPROMPT_MARKERS   comma list looked for in the system prompt
//     FLOWRYN_PROBE_TRUST               project_trust answer: yes | no | undecided (default)
//     FLOWRYN_PROBE_EDITOR_WATCH        "1" logs every composer text change (poll)
//   Command file ($FLOWRYN_PROBE_CTL), one JSON object per line, executed once each:
//     {"id":"c1","op":"send","api":"message"|"user","text":"...",
//      "deliverAs":"nextTurn"|"followUp"|"steer"(optional),"triggerTurn":true(optional),
//      "when":"now"|"idle"|"agent_start"|"tool_execution_start"|"tool_call"|
//             "turn_end"|"agent_settled"|"session_compact"}
//     {"id":"c2","op":"abort","when":...}
//     {"id":"c3","op":"compact","when":...,"instructions":"..."}
//     {"id":"c4","op":"read_editor"}      logs composer text
//     {"id":"c5","op":"set_editor","text":""}
//     {"id":"c6","op":"activity"}         idle-ms since last terminal input + composer empty
//     {"id":"c7","op":"status"}           isIdle, pending messages, session id/file, usage
//     {"id":"c8","op":"system_prompt"}    marker check on ctx.getSystemPrompt()
//     {"id":"c9","op":"shutdown"}         ctx.shutdown()
//     {"id":"c10","op":"block_tools","reason":"..."}  block every later tool_call with that reason
//                                         (an urgent steer's block, p15); "reason":null stops it
//   "when" defaults to "now". Event-bound commands run inside the next matching event
//   handler, with that handler's ctx.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
// Pi aliases "typebox" to its bundled copy for extensions
// (dist/core/extensions/virtual-modules.js in 0.87.1; Firstmate imports it the same way).
import { Type } from "typebox";
// Namespace import so a missing export (VERSION) degrades instead of failing to load.
// Seen in Firstmate lib/fm-calm-assistant-layout.ts; VERSION is exported by 0.87.1 index.d.ts.
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;
type When =
  | "now"
  | "idle"
  | "agent_start"
  | "tool_execution_start"
  | "tool_call"
  | "turn_end"
  | "agent_settled"
  | "session_compact";
type Command = Json & { id?: string; op?: string; when?: When };

const env = process.env;
const LOG = env.FLOWRYN_PROBE_LOG ?? "";
const CTL = env.FLOWRYN_PROBE_CTL ?? "";
const INSTANCE = env.FLOWRYN_PROBE_INSTANCE ?? "pi";
const MARKER_PATTERN = /FLOWRYN-(?:MARK|DRAFT)-[A-Za-z0-9_-]+/g;
const SHELL_GATE_PATTERN = /\bflowryn\s+(merge|approve)\b/;
/** Set by the block_tools control: every tool_call is blocked with this reason. */
let blockAllReason: string | null = null;
const EVENT_WHENS: When[] = [
  "agent_start",
  "tool_execution_start",
  "tool_call",
  "turn_end",
  "agent_settled",
  "session_compact",
];

function log(ev: string, fields: Json = {}): void {
  if (!LOG) return;
  const line = { ts: new Date().toISOString(), t: Date.now(), pid: process.pid, instance: INSTANCE, ev, ...fields };
  try {
    appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  } catch (error) {
    console.error(`flowryn-probe: cannot write ${LOG}: ${String(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...[+${text.length - max}]` : text;
}

function markersIn(value: unknown): string[] {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  return [...new Set(text.match(MARKER_PATTERN) ?? [])];
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function toolCallCount(message: any): number {
  const content = message?.content;
  return Array.isArray(content) ? content.filter((part: any) => part?.type === "toolCall").length : 0;
}

function sysPromptMarkers(prompt: string): Json {
  const wanted = (env.FLOWRYN_PROBE_SYSPROMPT_MARKERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    systemPromptLength: prompt.length,
    systemPromptMarkersWanted: wanted,
    systemPromptMarkersFound: wanted.filter((marker) => prompt.includes(marker)),
  };
}

// Safe wrappers: every ctx call is guarded so a missing API is logged, not fatal.
function safe<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    log("probe_error", { where: label, error: errorText(error) });
    return undefined;
  }
}

function sessionFacts(ctx: ExtensionContext): Json {
  // ReadonlySessionManager exposes getSessionId/getSessionFile/getSessionDir/getHeader/getEntries
  // (0.87.1 core/session-manager.d.ts; Firstmate fm-primary-turnend-guard.ts uses getSessionId/getHeader).
  const sm: any = (ctx as any).sessionManager;
  return {
    sessionId: safe("getSessionId", () => sm?.getSessionId?.()) ?? null,
    sessionFile: safe("getSessionFile", () => sm?.getSessionFile?.()) ?? null,
    sessionDir: safe("getSessionDir", () => sm?.getSessionDir?.()) ?? null,
    headerTimestamp: safe("getHeader", () => sm?.getHeader?.()?.timestamp) ?? null,
    entryCount: safe("getEntries", () => sm?.getEntries?.()?.length) ?? null,
  };
}

function editorText(ctx: ExtensionContext): string | null {
  // ExtensionUIContext.getEditorText(): types.d.ts line "Get the current text from the core
  // input editor"; Firstmate fm-calm.ts reads it inside onTerminalInput.
  const ui: any = (ctx as any).ui;
  if (typeof ui?.getEditorText !== "function") {
    log("editor_api_missing", { hasUI: (ctx as any).hasUI, mode: (ctx as any).mode });
    return null;
  }
  return safe("getEditorText", () => String(ui.getEditorText())) ?? null;
}

export default function flowrynProbe(pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let processedLines = 0;
  let lastTerminalInputAt = 0;
  let terminalInputCount = 0;
  let removeInputListener: (() => void) | undefined;
  let lastEditorSeen: string | null = null;
  const pending: Record<string, Command[]> = {};
  const idleQueue: Command[] = [];
  const counters = { agentStart: 0, agentSettled: 0, turnStart: 0, contextCalls: 0, compactions: 0 };

  log("probe_loaded", {
    piVersion: (PiCodingAgent as any).VERSION ?? null,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ctl: CTL || null,
  });

  function remember(ctx: ExtensionContext | undefined): void {
    if (ctx) lastCtx = ctx;
  }

  async function execute(command: Command, ctx: ExtensionContext | undefined, trigger: string): Promise<void> {
    const c = ctx ?? lastCtx;
    const base = {
      id: command.id ?? null,
      op: command.op ?? null,
      trigger,
      isIdle: c ? safe("isIdle", () => c.isIdle()) ?? null : null,
    };
    try {
      switch (command.op) {
        case "send": {
          const text = String(command.text ?? "");
          const deliverAs = command.deliverAs as "nextTurn" | "followUp" | "steer" | undefined;
          if (command.api === "user") {
            // sendUserMessage(content, {deliverAs: "steer"|"followUp"}): types.d.ts; Firstmate
            // fm-primary-pi-watch.ts sends followUp this way. A busy call without deliverAs is
            // rejected inside AgentSession.prompt() and reported through the runner's error
            // channel, not thrown here (agent-session.js bindCore -> runner.emitError).
            const options = deliverAs ? { deliverAs: deliverAs as "steer" | "followUp" } : undefined;
            await Promise.resolve((pi as any).sendUserMessage(text, options));
          } else {
            // sendMessage(message, {triggerTurn, deliverAs: "steer"|"followUp"|"nextTurn"}):
            // types.d.ts; Firstmate fm-branch-supervision.ts uses nextTurn and
            // {triggerTurn: true, deliverAs: "followUp"}.
            const options: Json = {};
            if (deliverAs) options.deliverAs = deliverAs;
            if (command.triggerTurn !== undefined) options.triggerTurn = Boolean(command.triggerTurn);
            pi.sendMessage(
              {
                customType: String(command.customType ?? "flowryn-probe"),
                content: text,
                display: command.display !== false,
                details: { ctlId: command.id ?? null },
              },
              options as any,
            );
          }
          log("ctl_exec", { ...base, ok: true, api: command.api ?? "message", deliverAs: deliverAs ?? null, triggerTurn: command.triggerTurn ?? null, markers: markersIn(text) });
          return;
        }
        case "abort":
          // ExtensionContext.abort(): types.d.ts "Abort the current agent operation";
          // Firstmate fm-branch-supervision.ts calls ctx.abort() from the context event.
          if (!c) throw new Error("no extension context captured yet");
          c.abort();
          log("ctl_exec", { ...base, ok: true, signalPresent: Boolean((c as any).signal) });
          return;
        case "compact":
          // ExtensionContext.compact(options): types.d.ts; examples/extensions/trigger-compact.ts.
          if (!c) throw new Error("no extension context captured yet");
          c.compact({
            customInstructions: command.instructions ? String(command.instructions) : undefined,
            onComplete: () => log("compact_complete", { id: command.id ?? null }),
            onError: (error: Error) => log("compact_error", { id: command.id ?? null, error: errorText(error) }),
          });
          log("ctl_exec", { ...base, ok: true });
          return;
        case "read_editor": {
          if (!c) throw new Error("no extension context captured yet");
          const text = editorText(c);
          log("ctl_exec", { ...base, ok: text !== null, editorText: text, editorLength: text?.length ?? null, hasUI: (c as any).hasUI, mode: (c as any).mode });
          return;
        }
        case "set_editor":
          // setEditorText(text): types.d.ts ExtensionUIContext. Used only for spike cleanup.
          if (!c) throw new Error("no extension context captured yet");
          (c as any).ui.setEditorText(String(command.text ?? ""));
          log("ctl_exec", { ...base, ok: true });
          return;
        case "activity": {
          if (!c) throw new Error("no extension context captured yet");
          const text = editorText(c);
          const idleMs = lastTerminalInputAt ? Date.now() - lastTerminalInputAt : null;
          const threshold = Number(command.thresholdMs ?? 60000);
          log("ctl_exec", {
            ...base,
            ok: text !== null,
            editorEmpty: text === null ? null : text.trim() === "",
            editorLength: text?.length ?? null,
            terminalInputCount,
            msSinceTerminalInput: idleMs,
            inputListener: Boolean(removeInputListener),
            inactive: text !== null && text.trim() === "" && idleMs !== null && idleMs >= threshold && base.isIdle === true,
          });
          return;
        }
        case "status":
          if (!c) throw new Error("no extension context captured yet");
          log("ctl_exec", {
            ...base,
            ok: true,
            hasPendingMessages: safe("hasPendingMessages", () => c.hasPendingMessages()) ?? null,
            contextUsage: safe("getContextUsage", () => c.getContextUsage()) ?? null,
            projectTrusted: safe("isProjectTrusted", () => (c as any).isProjectTrusted?.()) ?? null,
            ...sessionFacts(c),
            counters,
          });
          return;
        case "system_prompt": {
          if (!c) throw new Error("no extension context captured yet");
          const prompt = safe("getSystemPrompt", () => String((c as any).getSystemPrompt())) ?? "";
          log("ctl_exec", { ...base, ok: true, ...sysPromptMarkers(prompt), systemPromptTail: truncate(prompt.slice(-400), 400) });
          return;
        }
        case "block_tools":
          blockAllReason = command.reason === null || command.reason === undefined ? null : String(command.reason);
          log("ctl_exec", { ...base, ok: true, blocking: blockAllReason !== null });
          return;
        case "shutdown":
          // ExtensionContext.shutdown(): types.d.ts; deferred until idle in interactive mode (CHANGELOG).
          if (!c) throw new Error("no extension context captured yet");
          log("ctl_exec", { ...base, ok: true });
          c.shutdown();
          return;
        default:
          throw new Error(`unknown op ${String(command.op)}`);
      }
    } catch (error) {
      log("ctl_exec", { ...base, ok: false, error: errorText(error) });
    }
  }

  async function runPending(when: When, ctx: ExtensionContext): Promise<void> {
    const queue = pending[when];
    if (!queue || queue.length === 0) return;
    pending[when] = [];
    for (const command of queue) await execute(command, ctx, when);
  }

  function schedule(command: Command): void {
    const when = (command.when ?? "now") as When;
    if (when === "now") {
      void execute(command, undefined, "now");
    } else if (when === "idle") {
      idleQueue.push(command);
    } else if (EVENT_WHENS.includes(when)) {
      (pending[when] ??= []).push(command);
      log("ctl_scheduled", { id: command.id ?? null, op: command.op ?? null, when });
    } else {
      log("ctl_exec", { id: command.id ?? null, op: command.op ?? null, ok: false, error: `unknown when ${String(when)}` });
    }
  }

  function pollControl(): void {
    if (CTL && existsSync(CTL)) {
      let lines: string[] = [];
      try {
        lines = readFileSync(CTL, "utf8").split("\n").filter((line) => line.trim() !== "");
      } catch (error) {
        log("probe_error", { where: "read ctl", error: errorText(error) });
      }
      for (; processedLines < lines.length; processedLines += 1) {
        try {
          schedule(JSON.parse(lines[processedLines]) as Command);
        } catch (error) {
          log("ctl_exec", { ok: false, line: processedLines, error: `bad json: ${errorText(error)}` });
        }
      }
    }
    if (idleQueue.length > 0 && lastCtx && safe("isIdle", () => lastCtx!.isIdle()) === true) {
      for (const command of idleQueue.splice(0)) void execute(command, lastCtx, "idle");
    }
    if (env.FLOWRYN_PROBE_EDITOR_WATCH === "1" && lastCtx && (lastCtx as any).hasUI) {
      const text = editorText(lastCtx);
      if (text !== null && text !== lastEditorSeen) {
        log("editor_change", { editorText: truncate(text), editorLength: text.length, isIdle: safe("isIdle", () => lastCtx!.isIdle()) ?? null });
        lastEditorSeen = text;
      }
    }
  }

  function startSessionResources(ctx: ExtensionContext): void {
    // Docs (extensions.md "Respect the runtime lifecycle"): start timers from session_start,
    // never in the factory; close them in session_shutdown.
    if (!poller) {
      poller = setInterval(pollControl, 250);
      (poller as any).unref?.();
    }
    removeInputListener?.();
    removeInputListener = undefined;
    // onTerminalInput(handler) -> unsubscribe: types.d.ts; Firstmate fm-calm.ts. Returning
    // undefined leaves the keystroke to Pi.
    const ui: any = (ctx as any).ui;
    if ((ctx as any).hasUI && typeof ui?.onTerminalInput === "function") {
      removeInputListener = safe("onTerminalInput", () =>
        ui.onTerminalInput((data: string) => {
          lastTerminalInputAt = Date.now();
          terminalInputCount += 1;
          log("terminal_input", { length: data.length, sample: JSON.stringify(data.slice(0, 40)) });
          return undefined;
        }),
      );
    } else {
      log("terminal_input_unavailable", { hasUI: (ctx as any).hasUI, mode: (ctx as any).mode });
    }
  }

  function stopSessionResources(): void {
    if (poller) clearInterval(poller);
    poller = undefined;
    removeInputListener?.();
    removeInputListener = undefined;
  }

  function deliver(kind: "briefing" | "rebriefing", text: string, deliverAs: string, source: string): void {
    // Briefing path from design section 5 (Pi leader): sendMessage(..., {deliverAs: "nextTurn"}).
    safe(`send ${kind}`, () =>
      pi.sendMessage(
        { customType: `flowryn-${kind}`, content: text, display: true, details: { source } },
        { deliverAs: deliverAs as "nextTurn" | "followUp" | "steer" },
      ),
    );
    log(`${kind}_sent`, { deliverAs, source, markers: markersIn(text) });
  }

  // --- trust -------------------------------------------------------------------------
  // project_trust: types.d.ts ProjectTrustEvent/Result; docs/security.md "How Pi chooses a
  // trust decision": only user-level and command-line (-e) extensions participate. The probe
  // never sets remember, so it cannot write <agent-dir>/trust.json.
  pi.on("project_trust" as any, (event: any, ctx: any) => {
    const decision = (env.FLOWRYN_PROBE_TRUST ?? "undecided") as "yes" | "no" | "undecided";
    log("project_trust", { cwd: event?.cwd ?? null, mode: ctx?.mode ?? null, hasUI: ctx?.hasUI ?? null, decision });
    return { trusted: decision };
  });

  // --- session lifecycle ---------------------------------------------------------------
  // session_start reasons startup|reload|new|resume|fork (types.d.ts; Firstmate
  // fm-primary-turnend-guard.ts). A CLI --session resume arrives as reason "startup".
  pi.on("session_start", async (event: any, ctx) => {
    remember(ctx);
    const prompt = safe("getSystemPrompt", () => String((ctx as any).getSystemPrompt())) ?? "";
    log("session_start", {
      reason: event?.reason ?? null,
      previousSessionFile: event?.previousSessionFile ?? null,
      cwd: (ctx as any).cwd ?? null,
      mode: (ctx as any).mode ?? null,
      hasUI: (ctx as any).hasUI ?? null,
      projectTrusted: safe("isProjectTrusted", () => (ctx as any).isProjectTrusted?.()) ?? null,
      model: (ctx as any).model ? { provider: (ctx as any).model.provider, id: (ctx as any).model.id, contextWindow: (ctx as any).model.contextWindow ?? null } : null,
      isIdle: safe("isIdle", () => ctx.isIdle()) ?? null,
      ...sessionFacts(ctx),
      ...sysPromptMarkers(prompt),
    });
    startSessionResources(ctx);
    if (env.FLOWRYN_PROBE_BRIEFING) {
      deliver("briefing", env.FLOWRYN_PROBE_BRIEFING, env.FLOWRYN_PROBE_BRIEF_DELIVER ?? "nextTurn", String(event?.reason ?? "startup"));
    }
  });

  pi.on("session_shutdown", async (event: any) => {
    log("session_shutdown", { reason: event?.reason ?? null, targetSessionFile: event?.targetSessionFile ?? null, counters });
    stopSessionResources();
  });

  pi.on("session_before_compact", async (event: any, ctx) => {
    remember(ctx);
    log("session_before_compact", { reason: event?.reason ?? null, willRetry: event?.willRetry ?? null, isIdle: safe("isIdle", () => ctx.isIdle()) ?? null });
  });

  pi.on("session_compact", async (event: any, ctx) => {
    remember(ctx);
    counters.compactions += 1;
    const isIdle = safe("isIdle", () => ctx.isIdle()) ?? null;
    log("session_compact", { n: counters.compactions, reason: event?.reason ?? null, willRetry: event?.willRetry ?? null, fromExtension: event?.fromExtension ?? null, isIdle });
    if (env.FLOWRYN_PROBE_REBRIEFING) {
      const configured = env.FLOWRYN_PROBE_REBRIEF_DELIVER ?? "nextTurn";
      const deliverAs = configured === "auto" ? (event?.willRetry === true || isIdle === false ? "steer" : "nextTurn") : configured;
      const text = env.FLOWRYN_PROBE_REBRIEFING.replaceAll("{n}", String(counters.compactions));
      deliver("rebriefing", text, deliverAs, `compact:${event?.reason ?? "unknown"}`);
    }
    await runPending("session_compact", ctx);
  });

  pi.on("session_compact_failed" as any, async (event: any) => {
    log("session_compact_failed", { reason: event?.reason ?? null, aborted: event?.aborted ?? null, errorMessage: event?.errorMessage ?? null, willRetry: event?.willRetry ?? null });
  });

  // --- agent lifecycle -------------------------------------------------------------------
  pi.on("input", async (event: any, ctx) => {
    remember(ctx);
    log("input", { source: event?.source ?? null, streamingBehavior: event?.streamingBehavior ?? null, text: truncate(String(event?.text ?? "")), markers: markersIn(event?.text) });
    return { action: "continue" } as any;
  });

  pi.on("before_agent_start", async (event: any, ctx) => {
    remember(ctx);
    log("before_agent_start", { prompt: truncate(String(event?.prompt ?? "")), markers: markersIn(event?.prompt), ...sysPromptMarkers(String(event?.systemPrompt ?? "")) });
  });

  pi.on("agent_start", async (_event, ctx) => {
    remember(ctx);
    counters.agentStart += 1;
    log("agent_start", { n: counters.agentStart, editorText: (ctx as any).hasUI ? editorText(ctx) : null });
    await runPending("agent_start", ctx);
  });

  pi.on("turn_start", async (event: any, ctx) => {
    remember(ctx);
    counters.turnStart += 1;
    log("turn_start", { turnIndex: event?.turnIndex ?? null });
  });

  // context fires before each LLM call with the messages the model will see: the probe's
  // delivery evidence ("markers" present in the request).
  pi.on("context", async (event: any, ctx) => {
    remember(ctx);
    counters.contextCalls += 1;
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    log("context", {
      n: counters.contextCalls,
      messageCount: messages.length,
      customTypes: messages.filter((m) => m?.role === "custom").map((m) => m.customType),
      markers: markersIn(messages),
    });
    return undefined;
  });

  pi.on("message_start", async (event: any, ctx) => {
    remember(ctx);
    const message = event?.message;
    log("message_start", { role: message?.role ?? null, customType: message?.customType ?? null, markers: markersIn(message?.content) });
  });

  pi.on("message_end", async (event: any, ctx) => {
    remember(ctx);
    const message = event?.message;
    log("message_end", {
      role: message?.role ?? null,
      customType: message?.customType ?? null,
      provider: message?.provider ?? null,
      model: message?.model ?? null,
      responseModel: message?.responseModel ?? null,
      stopReason: message?.stopReason ?? null,
      toolCalls: toolCallCount(message),
      text: truncate(messageText(message)),
      errorMessage: message?.errorMessage ?? null,
      markers: markersIn(message?.content),
    });
    return undefined;
  });

  pi.on("turn_end", async (event: any, ctx) => {
    remember(ctx);
    log("turn_end", { turnIndex: event?.turnIndex ?? null, stopReason: event?.message?.stopReason ?? null, toolResults: event?.toolResults?.length ?? 0 });
    await runPending("turn_end", ctx);
    return undefined;
  });

  pi.on("agent_end", async (event: any, ctx) => {
    remember(ctx);
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const last = messages[messages.length - 1];
    log("agent_end", { messageCount: messages.length, lastRole: last?.role ?? null, lastStopReason: last?.stopReason ?? null });
  });

  // agent_before_settle carries outcome completed|aborted|error (types.d.ts BoundaryState).
  pi.on("agent_before_settle" as any, async (event: any, ctx: any) => {
    remember(ctx);
    log("agent_before_settle", { outcome: event?.outcome ?? null });
    return undefined;
  });

  // agent_settled: "fully settled and no automatic retry, compaction, or queued continuation
  // will run" (types.d.ts); emitted from AgentSession._runAgentPrompt's finally block.
  pi.on("agent_settled", async (_event, ctx) => {
    remember(ctx);
    counters.agentSettled += 1;
    log("agent_settled", {
      n: counters.agentSettled,
      isIdle: safe("isIdle", () => ctx.isIdle()) ?? null,
      hasPendingMessages: safe("hasPendingMessages", () => ctx.hasPendingMessages()) ?? null,
      editorText: (ctx as any).hasUI ? editorText(ctx) : null,
    });
    await runPending("agent_settled", ctx);
  });

  pi.on("ui_prompt_start" as any, async (event: any) => {
    log("ui_prompt_start", { kind: event?.kind ?? null, title: truncate(String(event?.title ?? ""), 120) });
  });

  pi.on("ui_prompt_end" as any, async (event: any) => {
    log("ui_prompt_end", { kind: event?.kind ?? null });
  });

  // --- tools ---------------------------------------------------------------------------
  // tool_call can block with {block: true, reason} (types.d.ts ToolCallEventResult; Firstmate
  // fm-primary-turnend-guard.ts, verified there against pi 0.80.5).
  pi.on("tool_call", async (event: any, ctx) => {
    remember(ctx);
    const toolName = String(event?.toolName ?? "");
    const command = toolName === "bash" || toolName === "powershell" ? String(event?.input?.command ?? "") : "";
    const gated = command !== "" && SHELL_GATE_PATTERN.test(command) && env.FLOWRYN_PROBE_BLOCK_SHELL !== "0";
    log("tool_call", { toolCallId: event?.toolCallId ?? null, toolName, command: truncate(command), blocked: gated || blockAllReason !== null });
    await runPending("tool_call", ctx);
    if (blockAllReason !== null) return { block: true, reason: blockAllReason };
    if (gated) {
      return { block: true, reason: "flowryn: shell merge/approve is blocked; use the flowryn_merge tool" };
    }
    return undefined;
  });

  pi.on("tool_execution_start", async (event: any, ctx) => {
    remember(ctx);
    log("tool_execution_start", { toolCallId: event?.toolCallId ?? null, toolName: event?.toolName ?? null });
    await runPending("tool_execution_start", ctx);
  });

  pi.on("tool_execution_end", async (event: any, ctx) => {
    remember(ctx);
    log("tool_execution_end", { toolCallId: event?.toolCallId ?? null, toolName: event?.toolName ?? null, isError: event?.isError ?? null });
  });

  pi.on("tool_result", async (event: any, ctx) => {
    remember(ctx);
    const text = Array.isArray(event?.content)
      ? event.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")
      : "";
    log("tool_result", { toolCallId: event?.toolCallId ?? null, toolName: event?.toolName ?? null, isError: event?.isError ?? null, text: truncate(text, 200) });
    return undefined;
  });

  // flowryn_merge: the Pi leader's human-confirmation channel (design section 7).
  // registerTool shape (name/label/description/parameters/execute) per types.d.ts
  // ToolDefinition and examples/extensions/hello.ts; ctx.ui.confirm(title, message, opts)
  // per types.d.ts ExtensionUIContext (interactive mode renders it as a Yes/No selector).
  pi.registerTool({
    name: "flowryn_merge",
    label: "Flowryn merge",
    description: "Ask the human to approve merging a Flowryn task's pull request. Returns whether the human approved.",
    promptSnippet: "flowryn_merge: ask the human to approve merging a task's pull request.",
    parameters: Type.Object({
      task: Type.String({ description: "Flowryn task id, for example T17" }),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
      remember(ctx);
      const task = String(params?.task ?? "");
      const timeoutMs = Number(env.FLOWRYN_PROBE_CONFIRM_TIMEOUT_MS ?? 0);
      log("merge_confirm_request", { task, hasUI: (ctx as any).hasUI ?? null, mode: (ctx as any).mode ?? null, timeoutMs: timeoutMs || null });
      const startedAt = Date.now();
      let answer: boolean | null = null;
      let failure: string | null = null;
      try {
        answer = await ctx.ui.confirm(
          `Flowryn merge ${task}?`,
          `PR: https://example.invalid/pr/${task}  head: 0000000 (spike)  checks: green (spike)`,
          timeoutMs > 0 ? { timeout: timeoutMs } : undefined,
        );
      } catch (error) {
        failure = errorText(error);
      }
      log("merge_confirm_answer", { task, answer, error: failure, waitedMs: Date.now() - startedAt });
      return {
        content: [{ type: "text", text: answer ? `Merge of ${task} approved by the human (spike: nothing merged).` : `Merge of ${task} declined.` }],
        details: { task, answer },
      };
    },
  } as any);
}
