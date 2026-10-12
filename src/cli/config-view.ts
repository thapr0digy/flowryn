import { FlowrynError } from "../api/errors.ts";
import { closestName, TOP_LEVEL_SETTINGS, type FlowrynConfig } from "../config/config.ts";
import { configOverrides, differingSections, effectiveConfig, redactConfig, RESOLVE_ENV_KEYS, SNAPSHOT_KEYS } from "../config/effective.ts";

/**
 * What `flowryn config` prints (docs/notes/2026-10-12-next-steps-md-it.md):
 * the file on disk, the running daemon's accepted configuration, which
 * values the file sets, and every section's effective values, redacted.
 */

export interface FileState {
  path: string;
  exists: boolean;
  /** The file's text, for its overrides; null when there is no file. */
  text: string | null;
  /** The parsed config (defaults when there is no file); null when it does not load. */
  config: FlowrynConfig | null;
  /** Why the file does not load. */
  error: string | null;
}

export type DaemonState =
  | { state: "not_running" }
  | { state: "error"; message: string }
  | {
      state: "answered";
      loaded_at: string | null;
      reload: { at: string; outcome: "accepted" | "rejected"; error: string | null } | null;
      problems: string[];
      sections: Record<string, unknown>;
      /** The daemon's values of the environment variables the resolvers read. */
      resolve_env: Record<string, string>;
    };

function sectionLabel(key: string): string {
  return key === "core" ? "the top-level settings" : `[${key}]`;
}

/** The section `--section` names; bad_args, with the closest name, for anything else. */
export function checkSection(name: string): string {
  if ((SNAPSHOT_KEYS as readonly string[]).includes(name)) return name;
  const guess = closestName(name, SNAPSHOT_KEYS);
  throw new FlowrynError("bad_args", `--section ${name} is not a section${guess ? `; did you mean ${guess}?` : ""}`, `sections: ${SNAPSHOT_KEYS.join(", ")}`);
}

function inSection(path: string, section: string): boolean {
  if (section === "core") return (TOP_LEVEL_SETTINGS as readonly string[]).includes(path);
  return path === section || path.startsWith(`${section}.`);
}

function only(sections: Record<string, unknown>, section: string | null): Record<string, unknown> {
  return section === null ? sections : { [section]: sections[section] ?? null };
}

function daemonLine(daemon: DaemonState, differs: string[] | null): string {
  if (daemon.state === "not_running") return "not running";
  if (daemon.state === "error") return `did not show its configuration: ${daemon.message}`;
  if (differs === null) return "running; the file does not load, so the effective values below are the daemon's";
  if (differs.length === 0) return "running; its accepted configuration matches the file";
  return `running; its accepted configuration differs from the file in ${differs.map(sectionLabel).join(", ")} (it reads the file again on SIGHUP or a restart)`;
}

function reloadLine(daemon: DaemonState): string | null {
  if (daemon.state !== "answered" || !daemon.reload) return null;
  const { at, outcome, error } = daemon.reload;
  return outcome === "accepted" ? `accepted at ${at}` : `rejected at ${at}: ${error ?? "no reason recorded"}; the daemon keeps its last valid configuration`;
}

/** The reply data of `flowryn config`, optionally narrowed to one section. */
export function configReport(file: FileState, daemon: DaemonState, env: NodeJS.ProcessEnv, section: string | null = null): Record<string, unknown> {
  const resolveWith = daemon.state === "answered" ? { ...env, ...Object.fromEntries(RESOLVE_ENV_KEYS.map((key) => [key, daemon.resolve_env[key]])) } : env;
  const fromFile = file.config ? effectiveConfig(file.config, resolveWith) : null;
  const fileSections = fromFile ? redactConfig(fromFile.sections) : null;
  const fileProblems = file.error ? [file.error] : (fromFile?.problems ?? []);
  const daemonSections = daemon.state === "answered" ? daemon.sections : null;
  const differs = daemonSections && fileSections ? differingSections(fileSections, daemonSections) : null;
  const shown = differs === null || section === null ? differs : differs.filter((key) => key === section);

  const overrides = (file.text === null ? [] : configOverrides(file.text)).filter((path) => section === null || inSection(path, section));
  const data: Record<string, unknown> = {
    path: file.path,
    exists: file.exists ? "yes" : "no (defaults)",
    file: fileProblems.length === 0 ? "valid" : `invalid: ${fileProblems.join("; ")}`,
    daemon: daemonLine(daemon, shown),
  };
  if (daemon.state === "answered" && daemon.loaded_at) data.daemon_loaded = daemon.loaded_at;
  const reload = reloadLine(daemon);
  if (reload) data.daemon_reload = reload;
  data.overrides = overrides.length > 0 ? overrides : "none: every value shown is a default";

  const effective = fileSections ?? daemonSections;
  if (effective) {
    data.effective_from = fileSections ? "the file" : "the running daemon";
    data.effective = only(effective, section);
  }
  if (daemonSections && shown && shown.length > 0) data.daemon_values = Object.fromEntries(shown.map((key) => [key, daemonSections[key] ?? null]));
  return data;
}
