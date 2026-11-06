import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../db/db.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import { scrubTokens } from "../lifecycle/diag.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { redactSecrets } from "../util/redact.ts";

/**
 * What a failed contract step leaves behind (docs/notes/2026-11-06-live-contract-check-bf.md):
 * the scratch run's events, the worker transcript's tail and the pane's last
 * screen, read before cleanup removes the scratch home, so a failure can be
 * explained afterwards. Every string is redacted the way `flowryn diag export`
 * redacts every string (URL credentials, token-looking runs) plus the screen
 * redaction Flowryn applies to captured pane text. The free text itself is
 * kept: a contract run's steers and replies are the suite's own fixed words,
 * and they are the evidence.
 */
export interface StepEvidence {
  step: string;
  error: string;
  failed_at: string;
  run: Record<string, unknown> | null;
  events: { seq: number; ts: number; source: string; kind: string; payload: unknown }[];
  steers: Record<string, unknown>[];
  transcript: { path: string | null; lines: string[]; error?: string };
  screen: { pane: string | null; text: string | null; error?: string };
}

export const TRANSCRIPT_TAIL_LINES = 80;
export const SCREEN_LINES = 60;
/** A transcript line longer than this is cut: one tool result can hold a whole file. */
export const MAX_LINE_CHARS = 4_000;
const MAX_EVENTS = 1_000;

/** Run columns that hold a credential or a stored definition, never copied out. */
const SECRET_COLUMNS = ["token_hash", "workflow_def"];

export interface EvidenceSources {
  db: Db;
  runId: string;
  /** The Herdr session's socket, for the pane's last screen; null skips it. */
  herdrSocket: string | null;
  /** Read the pane (a seam for tests); defaults to Herdr pane.read on `herdrSocket`. */
  readPane?: (pane: string, lines: number) => Promise<string | null>;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactScreenSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactScreenSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactScreenSecrets(v)]));
  return value;
}

/** Every string redacted as diag export does, then with the screen redaction. */
export function redactEvidence<T>(value: T): T {
  return redactScreenSecrets(scrubTokens(value)) as T;
}

export function transcriptTail(path: string | null): StepEvidence["transcript"] {
  if (!path) return { path: null, lines: [], error: "the run recorded no transcript" };
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    return { path, lines: lines.slice(-TRANSCRIPT_TAIL_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}... <cut: ${l.length} chars>` : l)) };
  } catch (error) {
    return { path, lines: [], error: `unreadable: ${(error as Error).message}` };
  }
}

async function lastScreen(run: RunRow | null, sources: EvidenceSources): Promise<StepEvidence["screen"]> {
  const pane = run?.pane_id ?? null;
  if (!pane) return { pane: null, text: null, error: "the run has no pane" };
  const read = sources.readPane ?? (sources.herdrSocket ? (p: string, n: number) => new HerdrRuntime(new HerdrClient(sources.herdrSocket!)).readPane(p, n) : null);
  if (!read) return { pane, text: null, error: "no Herdr socket to read it from" };
  try {
    const text = await read(pane, SCREEN_LINES);
    return text === null ? { pane, text: null, error: "the pane is gone" } : { pane, text };
  } catch (error) {
    return { pane, text: null, error: `pane.read failed: ${(error as Error).message}` };
  }
}

/** Gather a failed step's evidence from the scratch run, redacted. Never throws: what cannot be read says why. */
export async function collectEvidence(step: string, error: string, sources: EvidenceSources, now = Date.now()): Promise<StepEvidence> {
  const { db, runId } = sources;
  let run: RunRow | null = null;
  let events: StepEvidence["events"] = [];
  let steers: Record<string, unknown>[] = [];
  let dbError: string | undefined;
  try {
    run = db.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow | null;
    events = (db.query("SELECT seq, ts, source, kind, payload FROM events WHERE run_id = ?1 ORDER BY seq DESC LIMIT ?2").all(runId, MAX_EVENTS) as {
      seq: number;
      ts: number;
      source: string;
      kind: string;
      payload: string;
    }[])
      .toReversed()
      .map((e) => ({ ...e, payload: parsed(e.payload) }));
    steers = db.query("SELECT * FROM messages WHERE run_id = ?1 ORDER BY created_at, id").all(runId) as Record<string, unknown>[];
  } catch (caught) {
    dbError = (caught as Error).message;
  }
  const runRow = run ? { ...(run as unknown as Record<string, unknown>) } : null;
  if (runRow) for (const column of SECRET_COLUMNS) delete runRow[column];
  const evidence: StepEvidence = {
    step,
    error: dbError ? `${error} (scratch database unreadable: ${dbError})` : error,
    failed_at: new Date(now).toISOString(),
    run: runRow,
    events,
    steers,
    transcript: transcriptTail(run?.transcript_path ?? null),
    screen: await lastScreen(run, sources),
  };
  return redactEvidence(evidence);
}

/** The evidence file beside a report: `<report>.evidence.json`. */
export function evidencePathFor(report: string): string {
  return report.replace(/\.json$/, "") + ".evidence.json";
}

/** Write the evidence at mode 0600 and return its path. */
export function writeEvidence(path: string, evidence: StepEvidence): string {
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
