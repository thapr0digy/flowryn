import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveItems } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { policyMode } from "../config/policy.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";

/**
 * The harness version gate (design section 5): contract tests gate every
 * harness version, and the daemon checks the installed version at startup,
 * at dispatch and before each launch or resume. A version with no passing
 * record refuses (contract_unverified) and opens one P1 with the doctor
 * command (section 16, "harness updated to an untested version"), once per
 * harness version; it resolves when that harness's installed version passes.
 * Under `[policy] mode = "relaxed"`, on a daemon that can run the check from
 * its own build, the P1 waits: the daemon runs the recording check itself
 * (src/contracts/auto.ts) and opens the P1 only if it cannot pass.
 */

export type VersionOf = (harness: HarnessId, binary: string) => Promise<string | null>;

export type HarnessCheck =
  | { harness: HarnessId; state: "verified" | "unverified"; version: string }
  | { harness: HarnessId; state: "missing"; detail: string };

/** The installed harness's version and whether a contract run passed for it. */
export async function checkHarness(db: Db, config: FlowrynConfig, harness: HarnessId, versionOf: VersionOf): Promise<HarnessCheck> {
  const binary = resolveTool(config, harness);
  if (!binary) return { harness, state: "missing", detail: `${harness} is not installed or not in [tools]` };
  const version = await versionOf(harness, binary);
  if (!version) return { harness, state: "missing", detail: `cannot read the ${harness} version from ${binary} --version` };
  const passed = db.query("SELECT 1 FROM harness_contracts WHERE harness = ?1 AND version = ?2").get(harness, version);
  return { harness, state: passed ? "verified" : "unverified", version };
}

export function contractsCommand(harness: HarnessId): string {
  return `flowryn doctor --contracts --harness ${harness}`;
}

/** What a dispatch, a resume or a launch gets when the harness is not verified. With the database and config, the help names an automatic check that is queued or running. */
export function harnessRefusal(check: Exclude<HarnessCheck, { state: "verified" }>, db?: Db, config?: FlowrynConfig): FlowrynError {
  if (check.state === "missing") return new FlowrynError("tool_missing", check.detail, "flowryn init");
  const attempt = db && config ? activeAutoAttempt(db, config, check.harness) : null;
  const help =
    attempt?.version === check.version && (attempt.state === "running" || attempt.state === "waiting")
      ? `an automatic contract check is ${attempt.state === "running" ? "running" : `queued (${attempt.wait ?? "waiting"})`}; dispatch and resume work once it passes`
      : `run the contract suite: ${contractsCommand(check.harness)}`;
  return new FlowrynError("contract_unverified", `no passing contract run for ${check.harness} ${check.version}`, help);
}

// ---------------------------------------------------------------------------
// Automatic checks (src/contracts/auto.ts): what the gate needs to know of them

/** Set by a daemon that can run the recording check from its own build (its build id); absent otherwise. */
export const AUTO_BUILD_KEY = "contract_auto_build";

const attemptKey = (harness: HarnessId) => `contract_auto:${harness}`;

/** The daemon's automatic check of one harness version (meta.contract_auto:<harness>). */
export interface AutoAttempt {
  version: string;
  /** `unrecorded`: it passed after a reload to strict, so nothing was recorded; a reload to relaxed runs it again. */
  state: "waiting" | "running" | "passed" | "failed" | "unrecorded";
  /** While waiting: what it waits for. */
  wait?: string;
  started_at?: number;
  ended_at?: number;
  build?: string;
  report?: string | null;
  log?: string | null;
  detail?: string;
}

export function autoAttempt(db: Db, harness: HarnessId): AutoAttempt | null {
  const raw = getMeta(db, attemptKey(harness));
  return raw ? (JSON.parse(raw) as AutoAttempt) : null;
}

/** Call inside the transaction that appends the event for the change. */
export function saveAutoAttempt(db: Db, harness: HarnessId, attempt: AutoAttempt): void {
  setMeta(db, attemptKey(harness), JSON.stringify(attempt));
}

/** Does the daemon run the recording check itself: relaxed mode, on a daemon that can (AUTO_BUILD_KEY)? */
export function autoChecksOn(db: Db, config: FlowrynConfig): boolean {
  let relaxed = false;
  try {
    relaxed = policyMode(config) === "relaxed";
  } catch {
    // An invalid [policy] never loosens anything.
  }
  return relaxed && Boolean(getMeta(db, AUTO_BUILD_KEY));
}

/** The attempt queued or running for the flagged untested version, while automatic checks are on; null otherwise (strict, or a daemon that cannot run one, shows the doctor command instead). */
export function activeAutoAttempt(db: Db, config: FlowrynConfig, harness: HarnessId): AutoAttempt | null {
  const attempt = autoAttempt(db, harness);
  if (!attempt || (attempt.state !== "waiting" && attempt.state !== "running")) return null;
  if (unverifiedVersion(db, harness) !== attempt.version || !autoChecksOn(db, config)) return null;
  return attempt;
}

/** The item key: one harness_unverified P1 per harness. */
export function harnessItemKey(harness: HarnessId): string {
  return `harness:${harness}`;
}

const flaggedKey = (harness: HarnessId) => `harness_flagged:${harness}`;

/**
 * Record what a check found. An unverified version opens its P1 once (a
 * dismissed one is not reopened for the same version); a verified one
 * resolves any open P1 for that harness. With `auto` (autoChecksOn), the
 * version is flagged without a P1: the daemon's automatic check decides
 * whether one opens. Call inside a transaction. Returns the id of an item it
 * opened.
 */
export function noteHarnessCheck(db: Db, check: HarnessCheck, source: EventSource, where: string, now: number, auto = false): string | null {
  const key = harnessItemKey(check.harness);
  if (check.state === "verified") {
    if (getMeta(db, flaggedKey(check.harness))) setMeta(db, flaggedKey(check.harness), "");
    if (resolveItems(db, "harness_unverified", key, `contract passed for ${check.version}`, now) > 0) {
      appendEvent(db, { source, kind: "harness.verified", payload: { harness: check.harness, version: check.version, where }, ts: now });
    }
    return null;
  }
  // A harness that is not installed is dispatch's tool_missing refusal, not an untested version.
  if (check.state === "missing") return null;
  if (getMeta(db, flaggedKey(check.harness)) === check.version) return null;
  resolveItems(db, "harness_unverified", key, `superseded by ${check.version}`, now);
  setMeta(db, flaggedKey(check.harness), check.version);
  const event = appendEvent(db, { source, kind: "harness.unverified", payload: { harness: check.harness, version: check.version, where, ...(auto ? { auto: true } : {}) }, ts: now });
  if (auto) return null;
  return openUnverifiedItem(db, check.harness, check.version, event.seq, now);
}

function unverifiedLine(harness: HarnessId, version: string): string {
  return `${harness} ${version} has no passing contract run, so dispatch and resume on ${harness} are refused until it passes: ${contractsCommand(harness)}`;
}

/** The harness_unverified P1. `line` replaces the default (an automatic check's failure names its report). Call inside a transaction. */
export function openUnverifiedItem(db: Db, harness: HarnessId, version: string, eventSeq: number, now: number, line?: string): string {
  return openItem(db, { kind: "harness_unverified", eventSeq, taskId: harnessItemKey(harness), line: line ?? unverifiedLine(harness, version), now });
}

/** Has a harness_unverified P1 ever opened for this version (open, resolved or dismissed)? */
export function unverifiedItemOpened(db: Db, harness: HarnessId, version: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM items i JOIN events e ON e.seq = i.event_seq
         WHERE i.kind = 'harness_unverified' AND i.task_id = ?1 AND json_extract(e.payload, '$.version') = ?2 LIMIT 1`,
      )
      .get(harnessItemKey(harness), version) !== null
  );
}

/** A contract run just passed for this version: the P1 about it is settled. Call inside a transaction. */
export function noteContractPassed(db: Db, harness: HarnessId, version: string, now: number): void {
  if (getMeta(db, flaggedKey(harness)) !== version) return;
  setMeta(db, flaggedKey(harness), "");
  resolveItems(db, "harness_unverified", harnessItemKey(harness), `contract passed for ${version}`, now);
}

/**
 * The untested version the last check found installed, while it still has no
 * passing record; a database read only, for the capacity view and the wait alert.
 */
export function unverifiedVersion(db: Db, harness: string): string | null {
  const version = getMeta(db, flaggedKey(harness as HarnessId));
  if (!version) return null;
  return db.query("SELECT 1 FROM harness_contracts WHERE harness = ?1 AND version = ?2").get(harness, version) ? null : version;
}

/** Check a harness and record the result in its own transaction; resolves the check. */
export async function gateHarness(db: Db, config: FlowrynConfig, harness: HarnessId, versionOf: VersionOf, source: EventSource, where: string, now: () => number): Promise<HarnessCheck> {
  const check = await checkHarness(db, config, harness, versionOf);
  tx(db, () => noteHarnessCheck(db, check, source, where, now(), autoChecksOn(db, config)));
  return check;
}

/** The harnesses in use: named by a project, an open run or a queued plan phase. */
function harnessesInUse(db: Db): HarnessId[] {
  const rows = db
    .query(
      `SELECT harness FROM projects
       UNION SELECT harness FROM runs WHERE state NOT IN ('cleaned','failed','cancelled')
       UNION SELECT harness FROM plan_phases WHERE harness IS NOT NULL`,
    )
    .all() as { harness: string }[];
  return HARNESS_IDS.filter((h) => rows.some((r) => r.harness === h));
}

/**
 * The startup check (design section 5): every harness in use, its installed
 * version against the passing contract records. One event per harness, and
 * the P1 for an untested version.
 */
export async function checkHarnessesAtStartup(db: Db, config: FlowrynConfig, versionOf: VersionOf, now: () => number): Promise<HarnessCheck[]> {
  const checks: HarnessCheck[] = [];
  for (const harness of harnessesInUse(db)) {
    const check = await checkHarness(db, config, harness, versionOf);
    tx(db, () => {
      appendEvent(db, {
        source: "daemon",
        kind: "harness.checked",
        payload: check.state === "missing" ? { harness, state: check.state, detail: check.detail } : { harness, state: check.state, version: check.version },
        ts: now(),
      });
      noteHarnessCheck(db, check, "daemon", "startup", now(), autoChecksOn(db, config));
    });
    checks.push(check);
  }
  return checks;
}
