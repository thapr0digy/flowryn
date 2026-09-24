import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveItems } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
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

/** What a dispatch, a resume or a launch gets when the harness is not verified. */
export function harnessRefusal(check: Exclude<HarnessCheck, { state: "verified" }>): FlowrynError {
  if (check.state === "missing") return new FlowrynError("tool_missing", check.detail, "flowryn init");
  return new FlowrynError("contract_unverified", `no passing contract run for ${check.harness} ${check.version}`, `run the contract suite: ${contractsCommand(check.harness)}`);
}

/** The item key: one harness_unverified P1 per harness. */
export function harnessItemKey(harness: HarnessId): string {
  return `harness:${harness}`;
}

const flaggedKey = (harness: HarnessId) => `harness_flagged:${harness}`;

/**
 * Record what a check found. An unverified version opens its P1 once (a
 * dismissed one is not reopened for the same version); a verified one
 * resolves any open P1 for that harness. Call inside a transaction. Returns
 * the id of an item it opened.
 */
export function noteHarnessCheck(db: Db, check: HarnessCheck, source: EventSource, where: string, now: number): string | null {
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
  const event = appendEvent(db, { source, kind: "harness.unverified", payload: { harness: check.harness, version: check.version, where }, ts: now });
  return openItem(db, {
    kind: "harness_unverified",
    eventSeq: event.seq,
    taskId: key,
    line: `${check.harness} ${check.version} has no passing contract run, so dispatch and resume on ${check.harness} are refused until it passes: ${contractsCommand(check.harness)}`,
    now,
  });
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
  tx(db, () => noteHarnessCheck(db, check, source, where, now()));
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
      noteHarnessCheck(db, check, "daemon", "startup", now());
    });
    checks.push(check);
  }
  return checks;
}
