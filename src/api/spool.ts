import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { isUlid } from "../util/ulid.ts";
import type { Envelope } from "./envelope.ts";
import type { Gateway } from "./gateway.ts";

const SPOOL_FILE = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/;
const REJECTED = "rejected";
const RUN_DIR = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Write one spooled call: `<data>/spool/<run>/<ulid>.json`, atomically, one
 * writer per file (design section 12). Returns the path.
 */
export function writeSpoolFile(spoolRoot: string, runId: string, envelope: Envelope): string {
  if (!RUN_DIR.test(runId)) throw new Error(`FLOWRYN_RUN is not a usable run id: ${runId}`);
  if (!isUlid(envelope.ulid)) throw new Error("a spooled call needs a ULID");
  const dir = join(spoolRoot, runId);
  ensureDir(spoolRoot, 0o700);
  ensureDir(dir, 0o700);
  const path = join(dir, `${envelope.ulid}.json`);
  writeFileAtomic(path, JSON.stringify({ ...envelope, spooled_at: Date.now() }), 0o600);
  return path;
}

export interface IngestResult {
  ingested: number;
  duplicates: number;
  rejected: number;
  deferred: number;
}

function moveToRejected(spoolRoot: string, runDir: string, file: string): void {
  const dir = join(spoolRoot, REJECTED, runDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  renameSync(join(spoolRoot, runDir, file), join(dir, file));
}

/**
 * Ingest every spooled call, oldest first per run, deduplicated by ULID. A
 * call is deleted only after its effect (or its rejection) is committed, so a
 * crash mid-ingest re-reads the file and the ULID check drops the repeat.
 * Refused calls move to spool/rejected/ rather than being deleted.
 */
export async function ingestSpool(spoolRoot: string, gateway: Gateway, isIngested: (ulid: string) => boolean, log: (m: string) => void): Promise<IngestResult> {
  const result: IngestResult = { ingested: 0, duplicates: 0, rejected: 0, deferred: 0 };
  if (!existsSync(spoolRoot)) return result;
  for (const runDir of readdirSync(spoolRoot).toSorted()) {
    if (runDir === REJECTED || !RUN_DIR.test(runDir)) continue;
    let files: string[];
    try {
      files = readdirSync(join(spoolRoot, runDir)).filter((f) => SPOOL_FILE.test(f)).toSorted();
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(spoolRoot, runDir, file);
      const ulid = SPOOL_FILE.exec(file)![1]!;
      if (isIngested(ulid)) {
        unlinkSync(path);
        result.duplicates++;
        continue;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        gateway.recordSpoolRejection(ulid, runDir, `unreadable spool file: ${(error as Error).message}`);
        moveToRejected(spoolRoot, runDir, file);
        result.rejected++;
        continue;
      }
      if ((envelope as { ulid?: unknown }).ulid !== ulid) {
        gateway.recordSpoolRejection(ulid, runDir, "file name and envelope ULID differ");
        moveToRejected(spoolRoot, runDir, file);
        result.rejected++;
        continue;
      }
      const reply = await gateway.handle(envelope, "spool");
      if (reply.ok) {
        unlinkSync(path);
        result.ingested++;
      } else if (reply.error?.code === "internal") {
        log(`spool: ${path} hit an internal error; will retry: ${reply.error.message}`);
        result.deferred++;
      } else {
        if (!isIngested(ulid)) gateway.recordSpoolRejection(ulid, runDir, reply.error ?? "refused");
        moveToRejected(spoolRoot, runDir, file);
        result.rejected++;
      }
    }
  }
  return result;
}
