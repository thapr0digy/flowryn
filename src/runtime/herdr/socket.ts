import { resolveTool, type FlowrynConfig } from "../../config/config.ts";
import { herdrConfig } from "../../config/workers.ts";

export interface SocketResolution {
  socket: string | null;
  /** Why no socket was found, for doctor and the daemon log. */
  reason: string | null;
}

interface SessionRow {
  name?: string;
  default?: boolean;
  running?: boolean;
  socket_path?: string;
}

export type HerdrLister = (herdr: string) => Promise<{ exitCode: number; stdout: string }>;

const listSessions: HerdrLister = async (herdr) => {
  const proc = Bun.spawn([herdr, "session", "list", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout };
};

/**
 * Which Herdr API socket flowrynd drives. An explicit `[herdr] socket` wins and
 * runs no Herdr command at all (the lab and the tests use it). Otherwise the
 * named `[herdr] session`, or the default session, is looked up with the
 * read-only `herdr session list --json`.
 */
export async function resolveHerdrSocket(config: FlowrynConfig, lister: HerdrLister = listSessions): Promise<SocketResolution> {
  const herdr = herdrConfig(config);
  if (herdr.socket) return { socket: herdr.socket, reason: null };
  const binary = resolveTool(config, "herdr");
  if (!binary) return { socket: null, reason: "herdr is not installed or not in [tools]" };
  let rows: SessionRow[];
  try {
    const listed = await lister(binary);
    if (listed.exitCode !== 0) return { socket: null, reason: `herdr session list exited ${listed.exitCode}` };
    rows = ((JSON.parse(listed.stdout) as { sessions?: SessionRow[] }).sessions ?? []) as SessionRow[];
  } catch (error) {
    return { socket: null, reason: `cannot read herdr session list: ${(error as Error).message}` };
  }
  const wanted = herdr.session;
  const row = wanted ? rows.find((r) => r.name === wanted) : rows.find((r) => r.default === true);
  if (!row) return { socket: null, reason: wanted ? `no Herdr session named ${wanted}` : "Herdr has no default session" };
  if (row.running === false) return { socket: null, reason: `Herdr session ${row.name ?? "?"} is not running` };
  if (!row.socket_path) return { socket: null, reason: `Herdr session ${row.name ?? "?"} reports no socket` };
  return { socket: row.socket_path, reason: null };
}
