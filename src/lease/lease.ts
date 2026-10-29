import { hashToken, mintToken } from "../api/auth.ts";
import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { loseCarried } from "../attention/presentations.ts";
import { aliveOrUnknown, type ProcIdentity, type PsRunner } from "../runtime/proc.ts";

/**
 * The lease manager (design section 10): in each scope exactly one leader
 * session receives pushes and may run leader mutations
 * (docs/notes/2026-10-24-leader-scoping-and-vj.md). A session is one `flowryn
 * lead` launch on one account's login, and belongs to that account's scope;
 * its token is the leader token while its scope's lease names it, so moving
 * the lease takes leader rights from the old session at once. The lease
 * grants no approval authority.
 */

export type LeaderHarness = "claude" | "pi";

export interface LeaderSessionRow {
  session_id: string;
  harness: LeaderHarness;
  pane_id: string | null;
  turn_no: number;
  busy: number;
  busy_until: number | null;
  user_inactive_since: number | null;
  waiter_id: string | null;
  triggered_turns_hour: number;
  last_event_at: number | null;
  token_hash: string | null;
  harness_session: string | null;
  transcript_path: string | null;
  cwd: string | null;
  proc_pid: number | null;
  proc_start: number | null;
  proc_exe: string | null;
  continuations: number;
  banner: string | null;
  has_ui: number;
  brief_pending: number;
  started_at: number | null;
  ended_at: number | null;
  /** When you last repinned cwd (`flowryn leader repin`); grants from before it are refused. */
  pinned_at: number | null;
  /** The account whose login the session runs on (null: opened before accounts were recorded). */
  account: string | null;
  /** That account's scope; UNCONFIRMED_SCOPE while its first hook has not confirmed the login. */
  scope: string;
}

/** The scope of a session whose login did not match its account: it sees nothing and claims nothing. */
export const UNCONFIRMED_SCOPE = "";

/** The scope rows from before scopes take: the implicit default scope (src/config/accounts.ts IMPLICIT_SCOPE). */
export const LEGACY_SCOPE = "default";

export interface LeaseRow {
  scope: string;
  session_id: string | null;
  harness: string | null;
  pane_id: string | null;
  epoch: number;
  token_hash: string | null;
  approval_key_hash: string | null;
  claimed_at: number | null;
  heartbeat_at: number | null;
}

function vacant(scope: string): LeaseRow {
  return { scope, session_id: null, harness: null, pane_id: null, epoch: 0, token_hash: null, approval_key_hash: null, claimed_at: null, heartbeat_at: null };
}

const LEASE_COLUMNS = "scope, session_id, harness, pane_id, epoch, token_hash, approval_key_hash, claimed_at, heartbeat_at";

/** One scope's lease; vacant (epoch 0) when nobody ever claimed it. */
export function getLease(db: Db, scope: string): LeaseRow {
  return (db.query(`SELECT ${LEASE_COLUMNS} FROM leader_lease WHERE scope = ?1`).get(scope) as LeaseRow | null) ?? vacant(scope);
}

/** Every scope's lease row, by scope. */
export function allLeases(db: Db): LeaseRow[] {
  return db.query(`SELECT ${LEASE_COLUMNS} FROM leader_lease ORDER BY scope`).all() as LeaseRow[];
}

/** The lease a session holds or would claim: its own scope's. */
export function leaseOfSession(db: Db, sessionId: string): LeaseRow | null {
  const session = getSession(db, sessionId);
  if (!session || session.scope === UNCONFIRMED_SCOPE) return null;
  return getLease(db, session.scope);
}

/** The session holding a scope's lease, or null. */
export function holderOf(db: Db, scope: string): string | null {
  return getLease(db, scope).session_id;
}

export function getSession(db: Db, id: string): LeaderSessionRow | null {
  return db.query("SELECT * FROM leader_sessions WHERE session_id = ?1").get(id) as LeaderSessionRow | null;
}

export function isHolder(db: Db, sessionId: string): boolean {
  return db.query("SELECT 1 FROM leader_lease WHERE session_id = ?1").get(sessionId) !== null;
}

/** "claude in pane w1:p2", for banners and refusals. */
export function describeSession(session: Pick<LeaderSessionRow, "harness" | "pane_id" | "session_id">): string {
  return `${session.harness} ${session.pane_id ? `in pane ${session.pane_id}` : `session ${session.session_id}`}`;
}

function nextSessionId(db: Db): string {
  const next = Number(getMeta(db, "next_leader_no") ?? "1");
  setMeta(db, "next_leader_no", String(next + 1));
  return `L${next}`;
}

/**
 * `flowryn lead` registers a session before it launches the harness, on the
 * account its login matched (src/leader/scope.ts). Without an account (a test,
 * or a home with none recorded) it is in the implicit default scope. Call
 * inside a transaction.
 */
export function openSession(
  db: Db,
  input: { harness: LeaderHarness; pane: string | null; cwd: string | null; now: number; account?: string | null; scope?: string },
): { session: string; token: string } {
  const session = nextSessionId(db);
  const token = mintToken("leader");
  const scope = input.scope ?? LEGACY_SCOPE;
  db.query(
    `INSERT INTO leader_sessions (session_id, harness, pane_id, token_hash, cwd, started_at, last_event_at, account, scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)`,
  ).run(session, input.harness, input.pane, hashToken(token), input.cwd, input.now, input.account ?? null, scope);
  appendEvent(db, { source: "cli", kind: "leader.session_opened", payload: { session, harness: input.harness, pane: input.pane, cwd: input.cwd, account: input.account ?? null, scope }, ts: input.now });
  return { session, token };
}

/** The harness process of a session: the lease is stale only once it is gone. */
export function attachProcess(db: Db, sessionId: string, identity: ProcIdentity, now: number): void {
  db.query("UPDATE leader_sessions SET proc_pid = ?2, proc_start = ?3, proc_exe = ?4, last_event_at = ?5 WHERE session_id = ?1").run(sessionId, identity.pid, identity.start, identity.exe, now);
  appendEvent(db, { source: "cli", kind: "leader.session_attached", payload: { session: sessionId, pid: identity.pid }, ts: now });
}

/** Every hook or extension event from the holder refreshes the lease (design section 10). */
export function heartbeat(db: Db, sessionId: string, now: number): void {
  db.query("UPDATE leader_sessions SET last_event_at = ?2 WHERE session_id = ?1").run(sessionId, now);
  db.query("UPDATE leader_lease SET heartbeat_at = ?2 WHERE session_id = ?1").run(sessionId, now);
}

export type LeaseState = "vacant" | "held" | "stale" | "mine";

/**
 * The lease as a session starting up sees it. Stale needs both: no heartbeat
 * for stale_ms and the holder's process proven gone. A live but silent
 * holder (a sleeping laptop) is never taken over automatically, and a holder
 * whose process was never recorded, or that ps cannot read, cannot be proven gone.
 */
export async function leaseState(db: Db, sessionId: string, now: number, staleMs: number, ps?: PsRunner): Promise<{ state: LeaseState; epoch: number }> {
  const lease = leaseOfSession(db, sessionId);
  if (!lease) return { state: "held", epoch: 0 };
  if (!lease.session_id) return { state: "vacant", epoch: lease.epoch };
  if (lease.session_id === sessionId) return { state: "mine", epoch: lease.epoch };
  const holder = getSession(db, lease.session_id);
  if (!holder || holder.ended_at !== null) return { state: "vacant", epoch: lease.epoch };
  const silent = lease.heartbeat_at === null || now - lease.heartbeat_at >= staleMs;
  if (!silent) return { state: "held", epoch: lease.epoch };
  if (holder.proc_pid === null || holder.proc_start === null || holder.proc_exe === null) return { state: "held", epoch: lease.epoch };
  const alive = await aliveOrUnknown({ pid: holder.proc_pid, start: holder.proc_start, exe: holder.proc_exe }, ps);
  return { state: alive === false ? "stale" : "held", epoch: lease.epoch };
}

export interface Claimed {
  epoch: number;
  previous: string | null;
  /** The approval key for this lease (design section 7): handed only to a Pi extension, never put in any environment. */
  approvalKey: string;
}

/**
 * Claim the session's scope's lease. Call inside a transaction. Epoch + 1, the
 * session's token becomes the leader token and a new approval key is issued;
 * the old holder gets a one-line banner, and whatever was carried to it but
 * not presented is re-queued (actionable items need nothing: the new briefing
 * lists them). The caller tells the old holder's waiter to exit after commit.
 */
export function claim(db: Db, sessionId: string, reason: string, now: number): Claimed {
  const session = getSession(db, sessionId);
  if (!session || session.ended_at !== null) throw new Error(`leader session ${sessionId} is not open`);
  if (session.scope === UNCONFIRMED_SCOPE) throw new FlowrynError("scope_refused", `leader session ${sessionId}'s login is not confirmed, so it leads no scope`, "start the leader again with flowryn lead");
  const scope = session.scope;
  const lease = getLease(db, scope);
  const previous = lease.session_id && lease.session_id !== sessionId ? lease.session_id : null;
  const approvalKey = mintToken("key");
  db.query("INSERT OR IGNORE INTO leader_lease (scope, epoch) VALUES (?1, 0)").run(scope);
  db.query(
    `UPDATE leader_lease SET session_id = ?1, harness = ?2, pane_id = ?3, epoch = epoch + 1, token_hash = ?4,
       approval_key_hash = ?5, claimed_at = ?6, heartbeat_at = ?6 WHERE scope = ?7`,
  ).run(sessionId, session.harness, session.pane_id, session.token_hash, hashToken(approvalKey), now, scope);
  const epoch = getLease(db, scope).epoch;
  // A session that takes over mid-conversation has had no briefing as holder: its next prompt carries one.
  db.query("UPDATE leader_sessions SET banner = NULL, brief_pending = 1, last_event_at = ?2 WHERE session_id = ?1").run(sessionId, now);
  if (previous) {
    db.query("UPDATE leader_sessions SET banner = ?2, continuations = 0 WHERE session_id = ?1").run(previous, `Flowryn: leadership moved to ${describeSession(session)}; this session is read-only.`);
    loseCarried(db, previous, null, now);
  }
  appendEvent(db, { source: "daemon", kind: "leader.claimed", payload: { session: sessionId, harness: session.harness, pane: session.pane_id, scope, epoch, from: previous, reason }, ts: now });
  return { epoch, previous, approvalKey };
}

/** Release the lease if this session holds it. Call inside a transaction. */
export function release(db: Db, sessionId: string, reason: string, now: number): boolean {
  const changed = db
    .query("UPDATE leader_lease SET session_id = NULL, harness = NULL, pane_id = NULL, token_hash = NULL, approval_key_hash = NULL, heartbeat_at = ?2 WHERE session_id = ?1")
    .run(sessionId, now).changes;
  if (changed > 0) appendEvent(db, { source: "daemon", kind: "leader.released", payload: { session: sessionId, reason }, ts: now });
  return changed > 0;
}

/** The session is over: its token stops working and the lease, if it held it, is vacant. Call inside a transaction. */
export function closeSession(db: Db, sessionId: string, reason: string, now: number): { released: boolean } {
  const session = getSession(db, sessionId);
  if (!session || session.ended_at !== null) return { released: false };
  const released = release(db, sessionId, reason, now);
  db.query("UPDATE leader_sessions SET ended_at = ?2, busy = 0, busy_until = NULL WHERE session_id = ?1").run(sessionId, now);
  // Its rewake state (src/leader/wake-state.ts) dies with it.
  db.query("DELETE FROM meta WHERE key = ?1").run(`leader_rewake:${sessionId}`);
  loseCarried(db, sessionId, null, now);
  appendEvent(db, { source: "daemon", kind: "leader.session_closed", payload: { session: sessionId, reason, released }, ts: now });
  return { released };
}

export function openSessions(db: Db): LeaderSessionRow[] {
  return db.query("SELECT * FROM leader_sessions WHERE ended_at IS NULL ORDER BY started_at").all() as LeaderSessionRow[];
}
