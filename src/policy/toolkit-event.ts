import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { TOOLKIT_RULES, type ToolkitRule } from "./toolkit.ts";

/**
 * The `toolkit.denied` event: the hook process denied a tool call by the
 * toolkit rules (src/policy/toolkit.ts) and told the daemon, best effort. The
 * denial itself never waits on this. It records the rule and the tool name,
 * never the command, which may carry a secret.
 */
export interface ToolkitDenial {
  rule: ToolkitRule;
  tool: string;
}

/** The `toolkit` argument a hook passes along, or null when absent or malformed. */
export function parseToolkitDenial(raw: string | null | undefined): ToolkitDenial | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { rule?: unknown; tool?: unknown };
    if (typeof value.rule !== "string" || !(TOOLKIT_RULES as readonly string[]).includes(value.rule)) return null;
    return { rule: value.rule as ToolkitRule, tool: typeof value.tool === "string" ? value.tool.slice(0, 80) : "" };
  } catch {
    return null;
  }
}

/** Append it; call inside the hook's transaction. */
export function recordToolkitDenied(
  db: Db,
  denial: ToolkitDenial,
  who: { runId?: string | null; taskId?: string | null; session?: string | null; harness: "claude" | "pi"; toolName: string },
  now: number,
): void {
  appendEvent(db, {
    source: "hook",
    kind: "toolkit.denied",
    runId: who.runId ?? null,
    taskId: who.taskId ?? null,
    payload: { rule: denial.rule, use: denial.tool, tool_name: who.toolName.slice(0, 120), harness: who.harness, ...(who.session ? { session: who.session } : {}) },
    ts: now,
  });
}
