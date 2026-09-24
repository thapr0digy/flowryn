import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { sha256Hex } from "../util/hash.ts";
import { FlowrynError } from "./errors.ts";
import type { Caller, Role, VerbSpec } from "./verbs.ts";

/** Tokens are stored only as hashes (design section 12). */
export function hashToken(token: string): string {
  return sha256Hex(`flowryn-token:${token}`);
}

/** A new random capability token; `kind` is a readable prefix, not a secret. */
export function mintToken(kind: "leader" | "run"): string {
  return `fw${kind === "leader" ? "l" : "r"}_${randomBytes(32).toString("base64url")}`;
}

/**
 * Resolve the caller. A token matching the current lease is the leader; one
 * matching a run is that run's worker. No token: `human` when the CLI verified
 * your own terminal, else `anonymous`. An unknown token is refused outright
 * rather than downgraded, so a stale leader token cannot act as a human.
 */
export function resolveCaller(db: Db, token: string | null | undefined, channel: "tty" | null | undefined): Caller {
  if (!token) return { role: channel === "tty" ? "human" : "anonymous", runId: null, taskId: null };
  const hash = hashToken(token);
  const lease = db.query("SELECT 1 FROM leader_lease WHERE id = 1 AND token_hash = ?1").get(hash);
  if (lease) return { role: "leader", runId: null, taskId: null };
  const run = db.query("SELECT id, task_id FROM runs WHERE token_hash = ?1").get(hash) as { id: string; task_id: string } | null;
  if (run) return { role: "worker", runId: run.id, taskId: run.task_id };
  throw new FlowrynError("bad_token", "FLOWRYN_TOKEN is not a current leader or run token", "a leader token changes on every lease claim; a run token ends with its run");
}

/** Refuse a caller whose role the verb does not accept, with the code section 12 names for it. */
export function authorize(spec: VerbSpec, caller: Caller): void {
  if (spec.roles.includes(caller.role)) return;
  const who = spec.roles.join(" or ");
  if (caller.role === "worker") {
    throw new FlowrynError("worker_token", `a worker token cannot run ${spec.name}`, "report, ask or fail instead; the leader decides");
  }
  if (spec.roles.length === 1 && spec.roles[0] === "human") {
    throw new FlowrynError("human_only", `${spec.name} runs only in your own terminal`, "run it in a shell with no FLOWRYN_* variables");
  }
  if (caller.role === "anonymous") {
    throw new FlowrynError("role_refused", `${spec.name} needs a ${who}`, "run it in your own terminal, or ask the leader");
  }
  throw new FlowrynError("role_refused", `${spec.name} needs a ${who}; this caller is ${caller.role}`);
}

/** Roles a verb accepts, for help text. */
export function describeRoles(roles: Role[]): string {
  return roles.join(", ");
}
