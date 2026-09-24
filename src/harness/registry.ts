import { claudeAdapter } from "./claude/adapter.ts";
import { piAdapter } from "./pi/adapter.ts";
import type { HarnessAdapter, HarnessId } from "./types.ts";

export const ADAPTERS: Record<HarnessId, HarnessAdapter> = { claude: claudeAdapter, pi: piAdapter };

export function adapterFor(id: string): HarnessAdapter {
  const adapter = (ADAPTERS as Record<string, HarnessAdapter | undefined>)[id];
  if (!adapter) throw new Error(`no harness adapter for ${id}`);
  return adapter;
}
