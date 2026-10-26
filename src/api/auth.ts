import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { sha256Hex } from "../util/hash.ts";
import { FlowrynError } from "./errors.ts";
import type { Caller, VerbSpec } from "./verbs.ts";

/** Tokens are stored only as hashes (design section 12). */
export function hashToken(token: string): string {
  return sha256Hex(`flowryn-token:${token}`);
}

/** A new random capability token; `kind` is a readable prefix, not a secret. */
export function mintToken(kind: "leader" | "run" | "key"): string {
  const prefix = kind === "leader" ? "l" : kind === "run" ? "r" : "k";
  return `fw${prefix}_${randomBytes(32).toString("base64url")}`;
}

interface LeaseRow {
  scope: string;
  session_id: string | null;
  token_hash: string | null;
  harness: string | null;
  pane_id: string | null;
}

/**
 * Resolve the caller. A leader session's token is the leader of its scope
 * while that scope's lease names the session, and a read-only `reader` of its
 * scope otherwise; a token matching a lease itself (a lease seeded without a
 * session) is that scope's leader too. Either sees only its scope
 * (src/leader/scope.ts). One matching a run is that run's worker. No token:
 * `human` when the CLI verified your own terminal, else `anonymous`. An
 * unknown token is refused outright rather than downgraded, so a stale token
 * cannot act as a human.
 */
export function resolveCaller(db: Db, token: string | null | undefined, channel: "tty" | null | undefined): Caller {
  if (!token) return { role: channel === "tty" ? "human" : "anonymous", runId: null, taskId: null };
  const hash = hashToken(token);
  const lease = db.query("SELECT scope, session_id, token_hash, harness, pane_id FROM leader_lease WHERE token_hash = ?1").get(hash) as LeaseRow | null;
  const session = db.query("SELECT session_id, scope FROM leader_sessions WHERE token_hash = ?1 AND ended_at IS NULL").get(hash) as { session_id: string; scope: string } | null;
  if (lease) return { role: "leader", runId: null, taskId: null, session: session?.session_id ?? lease.session_id, scope: session?.scope ?? lease.scope };
  if (session) return { role: "reader", runId: null, taskId: null, session: session.session_id, scope: session.scope };
  const run = db.query("SELECT id, task_id FROM runs WHERE token_hash = ?1").get(hash) as { id: string; task_id: string } | null;
  if (run) return { role: "worker", runId: run.id, taskId: run.task_id };
  throw new FlowrynError("bad_token", "FLOWRYN_TOKEN is not a current leader session or run token", "a leader session's token ends with its session; a run token ends with its run");
}

/** Where a scope's lease is, for a read-only session's refusal and banner. */
export function leaderWhere(db: Db, scope: string | undefined): string {
  if (scope === "") return "this session's login is not confirmed, so it leads no scope";
  const lease = db.query("SELECT scope, session_id, harness, pane_id FROM leader_lease WHERE scope = ?1").get(scope ?? "default") as LeaseRow | null;
  if (!lease?.session_id) return "no session holds the lease";
  return `the leader is ${lease.harness ?? "unknown"} ${lease.pane_id ? `in pane ${lease.pane_id}` : `session ${lease.session_id}`}`;
}

/** Refuse a caller whose role the verb does not accept, with the code section 12 names for it. */
export function authorize(spec: VerbSpec, caller: Caller, db?: Db): void {
  if (spec.roles.includes(caller.role)) return;
  // A leader session's hooks and extension call hook verbs with the session token.
  if (spec.roles.includes("hook") && caller.session) return;
  const who = spec.roles.join(" or ");
  if (caller.role === "worker") {
    throw new FlowrynError("worker_token", `a worker token cannot run ${spec.name}`, "report, ask or fail instead; the leader decides");
  }
  if (caller.role === "reader" && spec.roles.includes("leader")) {
    throw new FlowrynError("not_leader", `this session is read-only: ${db ? leaderWhere(db, caller.scope) : "another session holds the lease"}`, "flowryn leader claim");
  }
  if (spec.roles.length === 1 && spec.roles[0] === "human") {
    throw new FlowrynError("human_only", `${spec.name} runs only in your own terminal`, "run it in a shell with no FLOWRYN_* variables");
  }
  if (caller.role === "anonymous") {
    throw new FlowrynError("role_refused", `${spec.name} needs a ${who}`, "run it in your own terminal, or ask the leader");
  }
  throw new FlowrynError("role_refused", `${spec.name} needs a ${who}; this caller is ${caller.role}`);
}
