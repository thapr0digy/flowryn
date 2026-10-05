// Flowryn M0 scripted provider: a deterministic, offline Pi model for the spikes.
//
// Load it per process next to the probe:
//   pi -e spikes/pi/lib/scripted-provider.ts --model flowryn-scripted/scripted
// It never touches the network and needs no credentials.
//
// API source of truth: Pi 0.87.1 docs/custom-provider.md ("Implement custom streaming")
// and examples/extensions/custom-provider-anthropic; the legacy ProviderConfig form with
// streamSimple matches the previous orchestrator's live offline providers (tests/fm-calm-pi-extension.test.sh,
// tests/fm-sessionstart-hook-live-e2e.test.sh).
//
// A spike scripts the model inside its prompt. The newest user message whose text contains
// "FLOWRYN-SCRIPT:" holds the script; the steps after that token are separated by " ;; ".
// Step N is played for the request that already has N assistant replies after that message,
// so tool results, steers and follow-ups advance the script exactly like a real turn would.
//   say <text>        final text reply; "{markers}" expands to every FLOWRYN-MARK-* marker in
//                     the request, which lets a spike prove what context the model received
//   bash <command>    one bash tool call
//   tool <name> <json-args>
//                     one call to any tool (for example flowryn_merge {"task":"T17"})
//   error <message>   fails the request every time (a retryable message exercises Pi's retry)
//   overflow          fails once with a context-overflow error, then plays the next step
// Prefix a step with "!" to report usage near the context window (threshold compaction).
// With no script, or once the script is exhausted, the reply is "ok".
// Summarization requests (compaction) get a fixed summary with no markers in it.
//
// Every request is logged as one JSON line to $FLOWRYN_PROVIDER_LOG when it is set.
import { appendFileSync } from "node:fs";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "flowryn-scripted";
const MODEL_ID = "scripted";
const CONTEXT_WINDOW = 32768;
const SCRIPT_TOKEN = "FLOWRYN-SCRIPT:";
const STEP_SEPARATOR = " ;; ";
const MARKER_PATTERN = /FLOWRYN-(?:MARK|DRAFT)-[A-Za-z0-9_-]+/g;
const OVERFLOW_ERROR = "context_length_exceeded: prompt is too long for this model's context window (flowryn scripted overflow)";

type Step =
  | { kind: "say"; text: string; fill: boolean }
  | { kind: "tool"; name: string; args: Record<string, unknown>; fill: boolean }
  | { kind: "error"; message: string; fill: boolean }
  | { kind: "overflow"; fill: boolean };

const firedOverflows = new Set<string>();
let requestCount = 0;

function log(fields: Record<string, unknown>): void {
  const file = process.env.FLOWRYN_PROVIDER_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...fields })}\n`);
  } catch (error) {
    console.error(`flowryn scripted provider: cannot write ${file}: ${String(error)}`);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function markersIn(text: string): string[] {
  return [...new Set(text.match(MARKER_PATTERN) ?? [])];
}

function parseStep(raw: string): Step {
  let body = raw.trim();
  const fill = body.startsWith("!");
  if (fill) body = body.slice(1).trim();
  const space = body.indexOf(" ");
  const verb = space === -1 ? body : body.slice(0, space);
  const rest = space === -1 ? "" : body.slice(space + 1).trim();
  switch (verb) {
    case "say":
      return { kind: "say", text: rest || "ok", fill };
    case "bash":
      return { kind: "tool", name: "bash", args: { command: rest }, fill };
    case "tool": {
      const split = rest.indexOf(" ");
      const name = split === -1 ? rest : rest.slice(0, split);
      const json = split === -1 ? "{}" : rest.slice(split + 1);
      try {
        return { kind: "tool", name, args: JSON.parse(json), fill };
      } catch (error) {
        return { kind: "say", text: `scripted provider: bad tool arguments ${json}: ${String(error)}`, fill };
      }
    }
    case "error":
      return { kind: "error", message: rest || "503 Service Unavailable: overloaded (flowryn scripted error)", fill };
    case "overflow":
      return { kind: "overflow", fill };
    default:
      return { kind: "say", text: `scripted provider: unknown step "${raw.trim()}"`, fill };
  }
}

interface Plan {
  step: Step;
  stepIndex: number | null;
  scriptKey: string | null;
  summary: boolean;
}

function isSummarization(messages: any[], tools: unknown[]): boolean {
  if (tools.length > 0) return false;
  const users = messages.filter((m) => m?.role === "user").map((m) => textOf(m.content));
  return users.some((text) => /\[User\]:|summar/i.test(text));
}

function planFor(messages: any[], tools: unknown[]): Plan {
  if (isSummarization(messages, tools)) {
    return { step: { kind: "say", text: "Flowryn scripted summary: earlier turns were short spike prompts.", fill: false }, stepIndex: null, scriptKey: null, summary: true };
  }
  let scriptAt = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && textOf(messages[i].content).includes(SCRIPT_TOKEN)) {
      scriptAt = i;
      break;
    }
  }
  if (scriptAt === -1) return { step: { kind: "say", text: "ok", fill: false }, stepIndex: null, scriptKey: null, summary: false };
  const text = textOf(messages[scriptAt].content);
  const steps = text.slice(text.indexOf(SCRIPT_TOKEN) + SCRIPT_TOKEN.length).split(STEP_SEPARATOR).filter((s) => s.trim() !== "");
  const replies = messages.slice(scriptAt + 1).filter((m) => m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted").length;
  const scriptKey = `${messages[scriptAt].timestamp ?? scriptAt}:${text.length}`;
  let stepIndex = replies;
  let step = stepIndex < steps.length ? parseStep(steps[stepIndex]) : ({ kind: "say", text: "ok", fill: false } as Step);
  if (step.kind === "overflow" && firedOverflows.has(`${scriptKey}:${stepIndex}`)) {
    stepIndex += 1;
    step = stepIndex < steps.length ? parseStep(steps[stepIndex]) : { kind: "say", text: "ok", fill: false };
  }
  return { step, stepIndex, scriptKey, summary: false };
}

export default function flowrynScriptedProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1/flowryn-scripted-unused",
    apiKey: "flowryn-scripted-offline",
    api: "flowryn-scripted-api",
    models: [
      {
        id: MODEL_ID,
        name: "Flowryn scripted (deterministic, offline)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 4096,
      },
    ],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const messages: any[] = Array.isArray(context?.messages) ? context.messages : [];
      // Tool declarations live in transcript system messages (docs/custom-provider.md).
      const tools: unknown[] = getCurrentTools(messages) ?? [];
      const allText = messages.map((m) => textOf(m?.content)).join("\n");
      const plan = planFor(messages, tools);
      requestCount += 1;
      const estimatedInput = Math.ceil(allText.length / 4);
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: plan.step.fill ? CONTEXT_WINDOW - 256 : estimatedInput,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      output.usage.totalTokens = output.usage.input + output.usage.output;
      log({
        ev: "request",
        n: requestCount,
        summary: plan.summary,
        stepIndex: plan.stepIndex,
        step: plan.step,
        roles: messages.map((m) => m?.role ?? null),
        toolCount: tools.length,
        markers: markersIn(allText),
      });

      setTimeout(() => {
        if (options?.signal?.aborted) {
          output.stopReason = "aborted";
          output.errorMessage = "Request was aborted";
          stream.push({ type: "error", reason: "aborted", error: output });
          stream.end();
          return;
        }
        const step = plan.step;
        if (step.kind === "error" || step.kind === "overflow") {
          if (step.kind === "overflow" && plan.scriptKey !== null) firedOverflows.add(`${plan.scriptKey}:${plan.stepIndex}`);
          output.stopReason = "error";
          output.errorMessage = step.kind === "overflow" ? OVERFLOW_ERROR : step.message;
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          return;
        }
        stream.push({ type: "start", partial: output });
        if (step.kind === "tool") {
          const toolCall = { type: "toolCall" as const, id: `flowryn-${requestCount}-${Date.now()}`, name: step.name, arguments: step.args };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
          stream.push({ type: "done", reason: "toolUse", message: output });
        } else {
          const text = step.text.replace("{markers}", markersIn(allText).join(" ") || "none");
          output.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      }, 50);
      return stream;
    },
  } as any);
}
