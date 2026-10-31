import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveItems } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { policyMode } from "../config/policy.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { BASELINE_REVISION, CONTRACT_REVISIONS, contractRevision, revisionLabel, storedRevision, type RevisionMap } from "../contracts/revision.ts";
import type { Fact, Unblock } from "../attention/explanations.ts";

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
 *
 * A pass counts only at the running daemon's contract revision
 * (src/contracts/revision.ts): one from another revision is stale, and the
 * refusal, the P1 and its dedup, and the automatic check all carry the
 * revision (docs/notes/2026-10-12-next-steps-md-ez.md).
 */

export type VersionOf = (harness: HarnessId, binary: string) => Promise<string | null>;

export type HarnessCheck =
  | { harness: HarnessId; state: "verified"; version: string; revision: number }
  /** `stale`: the revisions this version passed at, none of them the required one (empty: it never passed). */
  | { harness: HarnessId; state: "unverified"; version: string; revision: number; stale: number[] }
  | { harness: HarnessId; state: "missing"; detail: string; /** A check that threw: its raw message (detail then names only the error's kind). */ error?: string };

/** Has this version passed at this revision? */
export function hasPass(db: Db, harness: string, version: string, revision: number): boolean {
  return db.query("SELECT 1 FROM harness_contracts WHERE harness = ?1 AND version = ?2 AND revision = ?3").get(harness, version, revision) !== null;
}

/** The revisions this version passed at other than `revision`, oldest first. */
export function stalePasses(db: Db, harness: string, version: string, revision: number): number[] {
  const rows = db.query("SELECT revision FROM harness_contracts WHERE harness = ?1 AND version = ?2 AND revision != ?3 ORDER BY revision").all(harness, version, revision) as { revision: number }[];
  return rows.map((r) => r.revision);
}

/** The installed harness's version and whether a contract run passed for it at the daemon's revision (`revisions`: the constants, or a test's bump). */
export async function checkHarness(db: Db, config: FlowrynConfig, harness: HarnessId, versionOf: VersionOf, revisions: RevisionMap = CONTRACT_REVISIONS): Promise<HarnessCheck> {
  const binary = resolveTool(config, harness);
  if (!binary) return { harness, state: "missing", detail: `${harness} is not installed or not in [tools]` };
  const version = await versionOf(harness, binary);
  if (!version) return { harness, state: "missing", detail: `cannot read the ${harness} version from ${binary} --version` };
  const revision = contractRevision(harness, revisions);
  if (hasPass(db, harness, version, revision)) return { harness, state: "verified", version, revision };
  return { harness, state: "unverified", version, revision, stale: stalePasses(db, harness, version, revision) };
}

/** Why an unverified version has no usable pass: "no passing contract run for claude 2.1.300", or which revision its pass is from. */
export function unverifiedReason(harness: HarnessId, version: string, revision: number, stale: number[]): string {
  if (stale.length === 0) return `no passing contract run for ${harness} ${version}`;
  return `${harness} ${version} ${staleNote(revision, stale)}`;
}

export function contractsCommand(harness: HarnessId): string {
  return `flowryn doctor --contracts --harness ${harness}`;
}

/** The harness gate's verdict as facts. */
export function harnessFacts(gate: Exclude<HarnessCheck, { state: "verified" }>, t: number): Fact[] {
  if (gate.state !== "missing") return [{ name: `${gate.harness} version`, value: `${gate.version}: ${staleNote(gate.revision, gate.stale)}`, at: t }];
  return [{ name: `${gate.harness}`, value: gate.detail, at: t }, ...(gate.error ? [{ name: "check error", value: gate.error, at: t, same: "a thrown check" }] : [])];
}

function staleNote(revision: number, stale: number[]): string {
  if (stale.length === 0) return "no passing contract run";
  return `passed only at contract ${stale.map(revisionLabel).join(", ")}, not revision ${revision}`;
}

/** Why a wait on the harness gate holds, naming a stale contract revision when the version passed only at another. */
export function harnessWaitReason(gate: Exclude<HarnessCheck, { state: "verified" }>): string {
  if (gate.state === "missing") return gate.detail;
  return `${gate.harness} ${gate.version} ${gate.stale.length > 0 ? staleNote(gate.revision, gate.stale) : "has no passing contract run"}`;
}

/** Who can end a wait on the harness gate. */
export function harnessUnblock(gate: Exclude<HarnessCheck, { state: "verified" }>, what: string, auto?: string | null): Unblock[] {
  if (gate.state === "missing") return [{ by: "captain", action: `fix it (${gate.detail}): flowryn init` }];
  return [
    { by: "flowryn", action: auto ?? `${what} once ${gate.harness} ${gate.version} passes its contract suite` },
    { by: "captain", action: contractsCommand(gate.harness) },
  ];
}

/** What a dispatch, a resume or a launch gets when the harness is not verified. With the database and config, the help names an automatic check that is queued or running. */
export function harnessRefusal(check: Exclude<HarnessCheck, { state: "verified" }>, db?: Db, config?: FlowrynConfig): FlowrynError {
  if (check.state === "missing") return new FlowrynError("tool_missing", check.detail, "flowryn init");
  const attempt = db && config ? activeAutoAttempt(db, config, check.harness) : null;
  const help =
    attempt?.version === check.version && attemptRevision(attempt) === check.revision && (attempt.state === "running" || attempt.state === "waiting")
      ? `an automatic contract check is ${attempt.state === "running" ? "running" : `queued (${attempt.wait ?? "waiting"})`}; dispatch and resume work once it passes`
      : `run the contract suite: ${contractsCommand(check.harness)}`;
  return new FlowrynError("contract_unverified", unverifiedReason(check.harness, check.version, check.revision, check.stale), help);
}

// ---------------------------------------------------------------------------
// Automatic checks (src/contracts/auto.ts): what the gate needs to know of them

/** Set by a daemon that can run the recording check from its own build (its build id); absent otherwise. */
export const AUTO_BUILD_KEY = "contract_auto_build";

const attemptKey = (harness: HarnessId) => `contract_auto:${harness}`;

/** The daemon's automatic check of one harness version (meta.contract_auto:<harness>). */
export interface AutoAttempt {
  version: string;
  /** The contract revision it checks; absent on attempts from before revisions (read as the baseline, attemptRevision). */
  revision?: number;
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
  /** The run's ownership manifest (src/contracts/owned.ts); absent on attempts from before it existed. */
  manifest?: string;
  /** Whether the run released what it created, apart from `state`: `none` when it recorded nothing it owned. */
  cleanup?: "ok" | "failed" | "none";
  cleanup_detail?: string;
}

export function autoAttempt(db: Db, harness: HarnessId): AutoAttempt | null {
  const raw = getMeta(db, attemptKey(harness));
  return raw ? (JSON.parse(raw) as AutoAttempt) : null;
}

export function attemptRevision(attempt: AutoAttempt): number {
  return storedRevision(attempt.revision);
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
  if (unverifiedVersion(db, harness) !== attempt.version || attemptRevision(attempt) !== contractRevision(harness) || !autoChecksOn(db, config)) return null;
  return attempt;
}

/** The item key: one harness_unverified P1 per harness. */
export function harnessItemKey(harness: HarnessId): string {
  return `harness:${harness}`;
}

const flaggedKey = (harness: HarnessId) => `harness_flagged:${harness}`;

/** The version and revision the last check flagged unverified. */
export interface Flag {
  version: string;
  revision: number;
}

/** The flag: JSON `{version, revision}`; a plain version (written before revisions) is at the baseline revision. */
export function readFlag(db: Db, harness: HarnessId): Flag | null {
  const raw = getMeta(db, flaggedKey(harness));
  if (!raw) return null;
  if (!raw.startsWith("{")) return { version: raw, revision: BASELINE_REVISION };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; revision?: unknown };
    return typeof parsed.version === "string" ? { version: parsed.version, revision: storedRevision(parsed.revision) } : null;
  } catch {
    return null;
  }
}

function setFlag(db: Db, harness: HarnessId, flag: Flag | null): void {
  setMeta(db, flaggedKey(harness), flag ? JSON.stringify(flag) : "");
}

function sameFlag(flag: Flag | null, version: string, revision: number): boolean {
  return flag?.version === version && flag.revision === revision;
}

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
    if (getMeta(db, flaggedKey(check.harness))) setFlag(db, check.harness, null);
    if (resolveItems(db, "harness_unverified", key, `contract passed for ${check.version}`, now) > 0) {
      appendEvent(db, { source, kind: "harness.verified", payload: { harness: check.harness, version: check.version, revision: check.revision, where }, ts: now });
    }
    return null;
  }
  // A harness that is not installed is dispatch's tool_missing refusal, not an untested version.
  if (check.state === "missing") return null;
  if (sameFlag(readFlag(db, check.harness), check.version, check.revision)) return null;
  resolveItems(db, "harness_unverified", key, `superseded by ${check.version} at contract revision ${check.revision}`, now);
  setFlag(db, check.harness, { version: check.version, revision: check.revision });
  const event = appendEvent(db, {
    source,
    kind: "harness.unverified",
    payload: { harness: check.harness, version: check.version, revision: check.revision, ...(check.stale.length > 0 ? { stale: check.stale } : {}), where, ...(auto ? { auto: true } : {}) },
    ts: now,
  });
  if (auto) return null;
  return openUnverifiedItem(db, check.harness, check.version, event.seq, now, unverifiedLine(check.harness, check.version, check.revision, check.stale));
}

function unverifiedLine(harness: HarnessId, version: string, revision: number, stale: number[]): string {
  const why = stale.length === 0 ? `${harness} ${version} has no passing contract run` : unverifiedReason(harness, version, revision, stale);
  return `${why}, so dispatch and resume on ${harness} are refused until it passes: ${contractsCommand(harness)} (outside the sandbox)`;
}

/**
 * The harness_unverified P1 for this version at the daemon's revision. `line`
 * replaces the default (an automatic check's failure names its report). The
 * event at `eventSeq` must carry the version and revision (unverifiedItemOpened
 * dedupes on them). Call inside a transaction.
 */
export function openUnverifiedItem(db: Db, harness: HarnessId, version: string, eventSeq: number, now: number, line?: string): string {
  const revision = contractRevision(harness);
  return openItem(db, { kind: "harness_unverified", eventSeq, taskId: harnessItemKey(harness), line: line ?? unverifiedLine(harness, version, revision, stalePasses(db, harness, version, revision)), now });
}

/** Has a harness_unverified P1 ever opened for this version at this revision (open, resolved or dismissed)? An event from before revisions is at the baseline revision. */
export function unverifiedItemOpened(db: Db, harness: HarnessId, version: string, revision: number): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM items i JOIN events e ON e.seq = i.event_seq
         WHERE i.kind = 'harness_unverified' AND i.task_id = ?1 AND json_extract(e.payload, '$.version') = ?2
           AND COALESCE(json_extract(e.payload, '$.revision'), ${BASELINE_REVISION}) = ?3 LIMIT 1`,
      )
      .get(harnessItemKey(harness), version, revision) !== null
  );
}

/** A contract run just passed for this version at this revision: when that verifies the flagged version (whatever revision the flag recorded), its P1 is settled. Call inside a transaction. */
export function noteContractPassed(db: Db, harness: HarnessId, version: string, revision: number, now: number): void {
  if (revision !== contractRevision(harness) || readFlag(db, harness)?.version !== version) return;
  setFlag(db, harness, null);
  resolveItems(db, "harness_unverified", harnessItemKey(harness), `contract passed for ${version}`, now);
}

/**
 * The untested version the last check found installed, while it still has no
 * passing record at the daemon's revision; a database read only, for the
 * capacity view, the wait alert and the automatic check.
 */
export function unverifiedVersion(db: Db, harness: string): string | null {
  const flag = readFlag(db, harness as HarnessId);
  if (!flag) return null;
  return hasPass(db, harness, flag.version, contractRevision(harness as HarnessId)) ? null : flag.version;
}

/** Check a harness and record the result in its own transaction; resolves the check. */
export async function gateHarness(
  db: Db,
  config: FlowrynConfig,
  harness: HarnessId,
  versionOf: VersionOf,
  source: EventSource,
  where: string,
  now: () => number,
  revisions: RevisionMap = CONTRACT_REVISIONS,
): Promise<HarnessCheck> {
  const check = await checkHarness(db, config, harness, versionOf, revisions);
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
        payload: check.state === "missing" ? { harness, state: check.state, detail: check.detail } : { harness, state: check.state, version: check.version, revision: check.revision },
        ts: now(),
      });
      noteHarnessCheck(db, check, "daemon", "startup", now(), autoChecksOn(db, config));
    });
    checks.push(check);
  }
  return checks;
}
