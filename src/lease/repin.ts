import { readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { runCommand } from "../policy/command.ts";
import { claudeProjectSlug, tailLines, TRANSCRIPT_TAIL_BYTES, voidSessionGrants } from "../policy/grants.ts";
import { aliveOrUnknown, type ProcIdentity, type PsRunner } from "../runtime/proc.ts";
import { allLeases, getSession, isHolder } from "./lease.ts";

/**
 * `flowryn leader repin` (docs/notes/2026-10-11-flowryn-leader-repin-xv.md): your terminal moves
 * the leading Claude session's pinned directory (`leader_sessions.cwd`) to the one its transcript
 * really sits under, so chat-answer grants verify again without a new leader. The target comes
 * from the transcript's own `cwd` fields, since Claude's folder name (every character but A-Z,
 * a-z and 0-9 turned into '-') cannot be inverted. A repin voids the session's live grants and
 * sets `pinned_at`; src/policy/grants.ts refuses every grant, question and answer from before it.
 */

export const REPIN_VOID_REASON = "the leader was repinned";

export interface RepinPlan {
  session: string;
  pane: string | null;
  transcript: string;
  claudeSession: string;
  /** The transcript's folder in Claude's projects directory. */
  folder: string;
  oldCwd: string | null;
  newCwd: string;
  /** Where newCwd came from: the transcript's own entries, or the directory you named. */
  from: "transcript" | "argument";
  liveGrants: number;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The directories this Claude session's transcript entries name as their cwd that are existing
 * directories Claude would keep its transcripts in `folder` for. Read from the same tail the
 * grant check reads.
 */
export function repinCandidates(transcript: string, claudeSession: string, folder: string): string[] {
  const seen = new Set<string>();
  for (const line of tailLines(transcript, TRANSCRIPT_TAIL_BYTES)) {
    if (!line.includes('"cwd"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.sessionId === claudeSession && typeof entry.cwd === "string") seen.add(entry.cwd);
  }
  return [...seen].filter((cwd) => isAbsolute(cwd) && claudeProjectSlug(cwd) === folder && isDir(cwd)).toSorted();
}

/** The grants a repin would void: every one neither consumed nor voided, expired or not, as voidSessionGrants voids them. */
function liveGrantCount(db: Db, session: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM captain_grants WHERE session_id = ?1 AND consumed_at IS NULL AND voided_at IS NULL").get(session) as { n: number };
  return row.n;
}

/**
 * The leading Claude session a repin is for: the one you name, else the only lease holder. With a
 * leader per scope (docs/notes/2026-10-24-leader-scoping-and-vj.md) several may lead; you name one.
 */
function repinTarget(db: Db, named: string | null): string {
  const holders = allLeases(db)
    .map((l) => l.session_id)
    .filter((id): id is string => id !== null);
  if (named) {
    if (!holders.includes(named)) throw new FlowrynError("not_found", `leader session ${named} holds no lease`, "flowryn leader status");
    return named;
  }
  if (holders.length === 0) throw new FlowrynError("not_found", "no leader session holds the lease", "flowryn lead");
  if (holders.length > 1) throw new FlowrynError("bad_args", `${holders.length} leader sessions lead (${holders.join(", ")}): name the one to repin`, "flowryn leader repin --session <id> [<dir>]");
  return holders[0]!;
}

/**
 * What a repin of a lease holder would do, or why it would not help. `dir` is the directory you
 * named (absolute, from the CLI); without it the transcript names exactly one. `projectsDir` gives
 * Claude's projects directory of the session's account. Throws FlowrynError.
 */
export function planRepin(db: Db, a: { dir: string | null; session?: string | null; projectsDir: string | ((account: string | null) => string) }): RepinPlan {
  const target = repinTarget(db, a.session ?? null);
  const s = getSession(db, target);
  if (!s || s.ended_at !== null) throw new FlowrynError("not_found", `leader session ${target} has ended`, "flowryn leader status");
  const projectsDir = typeof a.projectsDir === "string" ? a.projectsDir : a.projectsDir(s.account);
  if (s.harness !== "claude") throw new FlowrynError("bad_args", `${s.session_id} is a ${s.harness} leader; chat-answer grants are Claude-only, so there is nothing to repin`);
  if (!s.transcript_path) throw new FlowrynError("not_found", `${s.session_id} has no Claude transcript recorded yet (its SessionStart hook has not run)`);
  const transcript = s.transcript_path;
  if (!isFile(transcript)) throw new FlowrynError("not_found", `${s.session_id}'s transcript ${transcript} cannot be read`);
  const folderPath = dirname(transcript);
  const folder = basename(folderPath);
  const projectsReal = realOrNull(projectsDir);
  if (!projectsReal || realOrNull(dirname(folderPath)) !== projectsReal) {
    throw new FlowrynError("bad_args", `${s.session_id}'s transcript ${transcript} is not in a folder of Claude's projects directory (${projectsDir})`, "set [grants] claude_projects_dir to the projects directory of the leader's Claude, or lead on the account whose login holds it");
  }
  if (s.cwd && claudeProjectSlug(s.cwd) === folder) {
    throw new FlowrynError("no_change", `${s.session_id} is already pinned to ${s.cwd}, the directory of its transcript's folder`, "flowryn show <grant> says why a grant was refused");
  }
  const claudeSession = basename(transcript).replace(/\.jsonl$/, "");
  let newCwd: string;
  let from: RepinPlan["from"];
  if (a.dir !== null) {
    const named = resolve(a.dir);
    if (!isDir(named)) throw new FlowrynError("bad_args", `${named} is not a directory`);
    const match = [named, realOrNull(named)].find((form): form is string => form !== null && claudeProjectSlug(form) === folder);
    if (!match) {
      throw new FlowrynError("bad_args", `${named} would not fix it: Claude keeps its transcripts in ${claudeProjectSlug(named)}, but ${s.session_id}'s transcript is in ${folder}`, "flowryn leader repin (with no directory: it reads the transcript's own)");
    }
    newCwd = match;
    from = "argument";
  } else {
    const found = repinCandidates(transcript, claudeSession, folder);
    if (found.length === 0) throw new FlowrynError("bad_args", `${s.session_id}'s transcript names no existing directory for its folder ${folder}`, "flowryn leader repin <dir>");
    if (found.length > 1) throw new FlowrynError("bad_args", `${s.session_id}'s transcript names several directories for its folder ${folder}: ${found.join(", ")}`, "flowryn leader repin <one of them>");
    newCwd = found[0]!;
    from = "transcript";
  }
  return { session: s.session_id, pane: s.pane_id, transcript, claudeSession, folder, oldCwd: s.cwd, newCwd, from, liveGrants: liveGrantCount(db, s.session_id) };
}

/**
 * Repin, as you were shown it: the session still leads, with the same pin and transcript. Voids
 * its live grants and records who, the old and new directory and when. Call inside a transaction.
 */
export function applyRepin(db: Db, a: { session: string; oldCwd: string | null; newCwd: string; transcript: string; actor: string; now: number }): { voided: number } {
  const s = getSession(db, a.session);
  if (!s || s.ended_at !== null) throw new FlowrynError("challenge_failed", `leader session ${a.session} ended since you were shown it`, "flowryn leader repin");
  if (!isHolder(db, a.session)) throw new FlowrynError("challenge_failed", `${a.session} no longer holds the lease`, "flowryn leader repin");
  if (s.cwd !== a.oldCwd || s.transcript_path !== a.transcript) throw new FlowrynError("challenge_failed", `the pin or transcript of ${a.session} changed since you were shown it`, "flowryn leader repin");
  db.query("UPDATE leader_sessions SET cwd = ?2, pinned_at = ?3 WHERE session_id = ?1").run(a.session, a.newCwd, a.now);
  const voided = voidSessionGrants(db, a.session, REPIN_VOID_REASON, a.now);
  appendEvent(db, {
    source: "cli",
    kind: "leader.repinned",
    payload: { session: a.session, by: a.actor, channel: "cli-tty", old_cwd: a.oldCwd, new_cwd: a.newCwd, transcript: a.transcript, grants_voided: voided },
    ts: a.now,
  });
  return { voided };
}

/** The pin's history for `flowryn show L<n>`: where the session opened, then each repin, oldest first. */
export function pinHistory(db: Db, session: string, opened: { cwd: string | null; startedAt: number | null }): string[] {
  const repins = (db.query("SELECT ts, payload FROM events WHERE kind = 'leader.repinned' AND json_extract(payload, '$.session') = ?1 ORDER BY seq").all(session) as { ts: number; payload: string }[]).map((r) => ({
    ts: r.ts,
    ...(JSON.parse(r.payload) as { by?: string; old_cwd?: string | null; new_cwd?: string; grants_voided?: number }),
  }));
  const openedRow = db.query("SELECT ts, payload FROM events WHERE kind = 'leader.session_opened' AND json_extract(payload, '$.session') = ?1 ORDER BY seq LIMIT 1").get(session) as { ts: number; payload: string } | null;
  const openedCwd = (openedRow ? (JSON.parse(openedRow.payload) as { cwd?: string | null }).cwd : undefined) ?? (repins.length > 0 ? repins[0]!.old_cwd : opened.cwd) ?? "?";
  const openedAt = openedRow?.ts ?? opened.startedAt;
  const lines = [`${openedAt !== null ? new Date(openedAt).toISOString() : "?"} opened at ${openedCwd}`];
  for (const r of repins) {
    const voided = r.grants_voided ?? 0;
    lines.push(`${new Date(r.ts).toISOString()} repinned by ${r.by ?? "?"}: ${r.old_cwd ?? "?"} → ${r.new_cwd ?? "?"} (${voided} grant${voided === 1 ? "" : "s"} voided)`);
  }
  return lines;
}

/**
 * The Claude process's working directory, for you to compare on the prompt; null when it is gone
 * or cannot be read. `lsof` is the daemon's resolved path (launchd's PATH may not reach /usr/sbin).
 */
export async function processCwd(identity: ProcIdentity | null, lsof: string | null, ps?: PsRunner): Promise<string | null> {
  if (!identity || (await aliveOrUnknown(identity, ps)) !== true) return null;
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${identity.pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (!lsof) return null;
  const result = await runCommand([lsof, "-a", "-p", String(identity.pid), "-d", "cwd", "-Fn"], { timeoutMs: 5_000 });
  if (result.code !== 0) return null;
  const line = result.stdout.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}
