import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "./config.ts";

/**
 * `[briefs]` (docs/notes/2026-11-05-workers-get-rich-hx.md): whether Flowryn
 * enforces structured briefs, design build specs and build handoffs. On by
 * default; test homes turn it off unless a test asks for it, so the rest of
 * the suite keeps its one-line fake bodies.
 */
export interface BriefsConfig {
  enforce: boolean;
}

export const DEFAULT_BRIEFS: BriefsConfig = { enforce: true };

export function briefsConfig(config: Pick<FlowrynConfig, "extra">): BriefsConfig {
  const raw = config.extra.briefs;
  if (raw === undefined) return { ...DEFAULT_BRIEFS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FlowrynError("config_invalid", "[briefs] must be a table");
  const table = raw as Record<string, unknown>;
  for (const key of Object.keys(table)) if (!(key in DEFAULT_BRIEFS)) throw new FlowrynError("config_invalid", `[briefs] ${key} is not a known setting`);
  if (table.enforce !== undefined && typeof table.enforce !== "boolean") throw new FlowrynError("config_invalid", "[briefs] enforce must be true or false");
  return { enforce: table.enforce === undefined ? DEFAULT_BRIEFS.enforce : (table.enforce as boolean) };
}
