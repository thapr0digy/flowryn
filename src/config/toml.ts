import type { FlowrynConfig } from "./config.ts";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function key(name: string): string {
  return BARE_KEY.test(name) ? name : JSON.stringify(name);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write non-finite number ${value} to TOML`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(inlineValue).join(", ")}]`;
  if (isTable(value)) {
    const parts = Object.entries(value).map(([k, v]) => `${key(k)} = ${inlineValue(v)}`);
    return `{ ${parts.join(", ")} }`;
  }
  throw new Error(`cannot write ${typeof value} to TOML`);
}

function writeTable(lines: string[], path: string[], table: Record<string, unknown>): void {
  const scalars = Object.entries(table).filter(([, v]) => !isTable(v));
  const tables = Object.entries(table).filter(([, v]) => isTable(v)) as [string, Record<string, unknown>][];
  if (path.length > 0 && (scalars.length > 0 || tables.length === 0)) {
    lines.push("", `[${path.map(key).join(".")}]`);
  }
  for (const [k, v] of scalars) lines.push(`${key(k)} = ${inlineValue(v)}`);
  for (const [k, v] of tables) writeTable(lines, [...path, k], v);
}

/** Render a TOML document from plain data (tables, scalars, arrays, inline tables in arrays). */
export function renderToml(data: Record<string, unknown>, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(...header.split("\n").map((l) => `# ${l}`.trimEnd()));
  writeTable(lines, [], data);
  return lines.join("\n").replace(/^\n+/, "") + "\n";
}

/** The config.toml text init writes: the M1 keys first, then every later-milestone section verbatim. */
export function renderConfig(config: FlowrynConfig): string {
  const data: Record<string, unknown> = {
    data_dir: config.data_dir,
    state_dir: config.state_dir,
    morning_hour: config.morning_hour,
    tasks: { backlog: config.tasks.backlog, todos: config.tasks.todos },
    tools: { ...config.tools },
    ...config.extra,
  };
  return renderToml(data, "Flowryn configuration, written by `flowryn init`. Editable; the daemon reloads it on SIGHUP.");
}
