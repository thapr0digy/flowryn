import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runBounded } from "./bounded.ts";

/**
 * Flowryn's treehouse pool (docs/notes/2026-11-04-use-treehouse-for-2b.md):
 * run worktrees are leased from a pool of reusable, pre-warmed worktrees
 * and returned at cleanup. Every call goes through `runBounded` with stdin
 * at EOF (a return that would prompt refuses instead: exit 3) and the update
 * check off (it would reach the network). The pool is Flowryn's own, under
 * `<worktree_root>/<project>/.pool`, never the one a user or an agent uses by
 * hand: `treehouse return --all` there takes leased slots too.
 *
 * Read from treehouse 3.1.8's help and tried in a scratch repository:
 * `get --lease --json` is the one non-interactive acquire that resets a slot
 * (`lease <name>` only marks one), a plain `return` refuses a slot with
 * changes, a `return` detaches and resets the slot but keeps its ignored
 * files, and `--if-lease-id` refuses a slot another lease now holds.
 */

export const GET_TIMEOUT_MS = 300_000;
export const RETURN_TIMEOUT_MS = 120_000;
export const STATUS_TIMEOUT_MS = 30_000;

/** The pool's directory under a project's worktree folder; a task id never starts with a dot. */
export function poolRoot(worktreeRoot: string, projectId: string): string {
  return join(worktreeRoot, projectId, ".pool");
}

/** The holder a run's lease names, so a launch after a crash finds a slot it leased but never recorded. */
export function leaseHolder(runId: string): string {
  return `flowryn:${runId}`;
}

export interface TreehouseCall {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SlotLease {
  path: string;
  lease_id: string;
  lease_holder: string;
}

export interface SlotStatus {
  name: string;
  path: string;
  status: string;
  branch: string;
  detached: boolean;
  lease_id: string;
  lease_holder: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; detail: string };

export async function treehouse(bin: string, root: string, args: string[], cwd: string, timeoutMs: number): Promise<TreehouseCall> {
  if (!existsSync(cwd)) return { code: 128, stdout: "", stderr: `no such directory: ${cwd}` };
  const result = await runBounded([bin, "--root", root, ...args], {
    label: `treehouse ${args[0] ?? ""}`.trim(),
    cwd,
    stdin: "",
    timeoutMs,
    env: { ...process.env, TREEHOUSE_NO_UPDATE_CHECK: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function said(call: TreehouseCall): string {
  const text = (call.stderr.trim() || call.stdout.trim()).split("\n").filter(Boolean).slice(-3).join(" ");
  return `exit ${call.code}${text ? `: ${text}` : ""}`;
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

/** `get --lease --json`'s object; anything else is a failed call, never a guess. */
export function parseLease(stdout: string): SlotLease | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!str(v.path) || !v.path.startsWith("/") || !str(v.lease_id) || v.lease_id === "") return null;
  return { path: v.path, lease_id: v.lease_id, lease_holder: str(v.lease_holder) ? v.lease_holder : "" };
}

/** `status --json`'s list; null when it is not one. */
export function parseStatus(stdout: string): SlotStatus[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim() || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: SlotStatus[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (!str(e.path)) return null;
    out.push({
      name: str(e.name) ? e.name : "",
      path: e.path,
      status: str(e.status) ? e.status : "",
      branch: str(e.branch) ? e.branch : "",
      detached: e.detached === true,
      lease_id: str(e.lease_id) ? e.lease_id : "",
      lease_holder: str(e.lease_holder) ? e.lease_holder : "",
    });
  }
  return out;
}

/**
 * Lease a slot for `holder`, cut from the repository's base without a fetch (the run's base commit is already local).
 * Call it only when `holder` holds no slot: a get that fails or times out after treehouse marked a slot leased hands
 * that slot back forced (nothing of the run's is in it), so the run's fallback to git leaves no lease behind.
 */
export async function acquireSlot(bin: string, root: string, repo: string, holder: string): Promise<Outcome<SlotLease>> {
  const call = await treehouse(bin, root, ["get", "--lease", "--json", "--no-fetch", "--unique-leaf", "--lease-holder", holder], repo, GET_TIMEOUT_MS);
  const lease = call.code === 0 ? parseLease(call.stdout) : null;
  if (lease) return { ok: true, value: lease };
  const detail = call.code !== 0 ? `treehouse get failed (${said(call)})` : `treehouse get printed no lease: ${call.stdout.trim().slice(0, 200) || "(nothing)"}`;
  const stray = await adoptSlot(bin, root, repo, holder);
  if (!stray.ok) return { ok: false, detail: `${detail}; ${stray.detail}` };
  if (!stray.value) return { ok: false, detail };
  const back = await returnSlot(bin, root, stray.value.path, stray.value.lease_id, true);
  return { ok: false, detail: `${detail}; the slot it leased ${back.ok ? "was returned" : `was not returned: ${back.detail}`}` };
}

export async function poolStatus(bin: string, root: string, repo: string): Promise<Outcome<SlotStatus[]>> {
  const call = await treehouse(bin, root, ["status", "--json"], repo, STATUS_TIMEOUT_MS);
  if (call.code !== 0) return { ok: false, detail: `treehouse status failed (${said(call)})` };
  const slots = parseStatus(call.stdout);
  if (!slots) return { ok: false, detail: `treehouse status printed no list: ${call.stdout.trim().slice(0, 200) || "(nothing)"}` };
  return { ok: true, value: slots };
}

/**
 * The slot a lease of `holder` still holds (a launch that leased one and stopped before recording it), or null.
 * A slot treehouse still lists but whose folder is gone (destroyed by hand) is never adopted.
 */
export async function adoptSlot(bin: string, root: string, repo: string, holder: string): Promise<Outcome<SlotLease | null>> {
  const status = await poolStatus(bin, root, repo);
  if (!status.ok) return status;
  const held = status.value.find((s) => s.lease_holder === holder && s.lease_id !== "" && existsSync(s.path));
  return { ok: true, value: held ? { path: held.path, lease_id: held.lease_id, lease_holder: held.lease_holder } : null };
}

/**
 * Return a slot to the pool, only while `leaseId` still holds it. Without
 * `force` a slot with uncommitted or untracked files is refused and left as it
 * was (treehouse cannot ask: stdin is at EOF); `force` cleans it first.
 */
export async function returnSlot(bin: string, root: string, path: string, leaseId: string, force: boolean): Promise<{ ok: boolean; detail: string }> {
  const args = ["return", ...(force ? ["--force"] : []), "--if-lease-id", leaseId, path];
  // From the pool root, not the slot: treehouse finds the pool from the path itself, and the slot may be the thing being reset.
  const call = await treehouse(bin, root, args, existsSync(root) ? root : "/", RETURN_TIMEOUT_MS);
  return call.code === 0 ? { ok: true, detail: "returned" } : { ok: false, detail: `treehouse return failed (${said(call)})` };
}

export async function treehouseVersion(bin: string): Promise<string | null> {
  const result = await runBounded([bin, "--version"], { label: "treehouse --version", timeoutMs: 10_000, stdin: "", env: { ...process.env, TREEHOUSE_NO_UPDATE_CHECK: "1" } });
  if (result.code !== 0) return null;
  return result.stdout.trim().split("\n")[0]?.replace(/^treehouse\s+(version\s+)?/i, "").replace(/^v(?=\d)/, "") || null;
}

function dirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * The worktrees in a pool, from the disk alone (no treehouse: relink and the
 * doctor run it with the daemon down): `<root>/.treehouse/<pool>/<slot>/<leaf>`
 * with a `.git` file.
 */
export function poolSlots(root: string): string[] {
  const base = join(root, ".treehouse");
  const out: string[] = [];
  for (const pool of dirs(base)) {
    for (const slot of dirs(pool)) {
      for (const leaf of dirs(slot)) {
        try {
          if (statSync(join(leaf, ".git")).isFile()) out.push(leaf);
        } catch {
          // not a worktree
        }
      }
    }
  }
  return out.toSorted();
}
