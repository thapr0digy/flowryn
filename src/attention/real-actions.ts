import type { FileClass, ReservedClass, UnattendedFindingsMode } from "./decisions-policy.ts";
import { RESERVED_PATTERNS } from "./decisions-policy.ts";
import { CREDENTIAL_CATEGORY, INSIDE, LEADER_STEPS, SECURITY_CATEGORY } from "../policy/nomistakes-classes.ts";
import type { NmFinding } from "../policy/nomistakes.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The finding rule of unattended mode (docs/notes/2026-11-10-unattended-mode-decide-8k.md).
 * Under a live grant and `[decisions] unattended_findings`, a question held only because a
 * protected keyword appears in it may be decided on the worker's recommendation when the
 * daemon's own no-mistakes record (`decisions.nm_record`, written by `ask --nomistakes` from
 * no-mistakes' status, never from the question) shows a judged gate step, and nothing names
 * a real action. Plain rules, no model; anything it cannot read parks (fails closed).
 */

type ParkingClass = Exclude<ReservedClass, "merge">;

/** The classes each mode may decide. */
export const MODE_CLASSES: Readonly<Record<UnattendedFindingsMode, readonly ParkingClass[]>> = {
  off: [],
  credential: ["credential"],
  "by-answer": ["irreversible", "destructive", "credential", "security", "outward"],
};

export const MODE_RULE: Readonly<Record<Exclude<UnattendedFindingsMode, "off">, string>> = { credential: "finding-credential", "by-answer": "finding-by-answer" };

const CRED_NOUN = String.raw`(?:api[- ]?keys?|tokens?|secrets?|passwords?|credentials?|private keys?|signing keys?|keys?)`;
/** Up to three words between, within one sentence (a full stop, colon, semicolon or line break ends it). */
const NEAR = String.raw`[^\w.;:!?\n]+(?:\w+[^\w.;:!?\n]+){0,3}`;

/** Phrases that name a real action of each class: any match anywhere parks. A false match only parks. */
export const REAL_ACTIONS: Readonly<Record<ParkingClass, readonly RegExp[]>> = {
  credential: [
    new RegExp(String.raw`\b(?:rotat\w*|revok\w*|regenerat\w*|reissu\w*|re-?key\w*|past\w*|hard-?cod\w*|commit\w*|check(?:s|ed|ing)? in|expos\w*|leak\w*|print\w*|log|logs|logged|logging|shar\w*|send\w*|stor\w*|sav\w*)${NEAR}${CRED_NOUN}\b`, "i"),
    new RegExp(String.raw`\b${CRED_NOUN}${NEAR}(?:leak\w*|exposed|logged|printed|committed|hard-?coded|stored|sent|unset)\b`, "i"),
  ],
  destructive: [/\b(?:drop|truncat\w*|delet\w*|remov\w*|wip\w*|purg\w*|eras\w*|destroy\w*)\W+(?:\w+\W+){0,3}(?:tables?|databases?|db|schemas?|buckets?|rows|volumes?|backups?|all data|(?:user|customer|prod\w*)\s+(?:data|records|accounts?|tables?|rows)|production)\b/i, /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i],
  irreversible: [RESERVED_PATTERNS.irreversible, /\breset\s+--hard\b/i, /\brebas\w*\W+(?:\w+\W+){0,3}(?:pushed|published|remote)\b/i, /\bdelet\w*\W+(?:the\W+)?(?:remote\W+)?(?:branch|tag)s?\b/i],
  security: [
    /\b(?:disabl\w*|bypass\w*|turn(?:s|ed|ing)? off|skip\w*|relax\w*|loosen\w*|weaken\w*)\W+(?:\w+\W+){0,3}(?:auth\w*|tls|ssl|mfa|2fa|sandbox\w*|verification|signatures?|hooks?|guards?|permission\w*|security)\b/i,
    /--no-verify\b/i,
    /\bchmod\s+[67]77\b/i,
    /\ballow[- ]all\b/i,
    /\bpublic(?:ly)?\s+(?:bucket|access)\b/i,
  ],
  outward: [RESERVED_PATTERNS.outward, /\b(?:npm|package)\s+publish\b/i, /\bcreate\s+(?:a\s+)?release\b/i, /\bpush\s+(?:the\s+)?tags?\b/i, /\bsend\s+(?:an?\s+)?(?:email|message)\b/i],
};

/** An approve that touches credentials waives handling them: parks under the credential class. */
const CREDENTIAL_WAIVE = new RegExp(String.raw`\b(?:unset\w*|sets?|setting|read\w*|load\w*|remov\w*|delet\w*|chang\w*)${NEAR}(?:credentials?|secrets?|tokens?|api[- ]?keys?|passwords?)\b`, "i");
/** A finding in a file like these is about secrets, whatever its words. */
const SECRET_FILE = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|secret|credential/i;

export type AnswerKind = "fix" | "approve" | "skip";

/** What the recommended option does, by its label (worker-written, so it only ever narrows). */
export function answerKind(label: string): AnswerKind {
  const words = label.replace(/[-_]+/g, " ");
  if (/\b(skip|ignore|waive|defer|bypass|suppress)\b/i.test(words)) return "skip";
  if (/\b(approve|accept|keep|as is|tolerate|leave)\b/i.test(words)) return "approve";
  return "fix";
}

export interface NmRecordFinding {
  id: string;
  action: string;
  severity: string;
  category: string;
  file: string;
  cls: FileClass;
  description: string;
}

export interface NmRecord {
  v: 1;
  step: string;
  findings: NmRecordFinding[];
  truncated?: boolean;
}

const MAX_FINDINGS = 20;
const MAX_DESCRIPTION = 1000;
const MAX_RECORD_BYTES = 16 * 1024;

/** The stored form of the daemon's no-mistakes read: capped, sanitized; an over-long one keeps only its step and exempts nothing. */
export function nmRecordJson(step: string, findings: readonly (NmFinding & { cls: FileClass })[]): string {
  const record: NmRecord = {
    v: 1,
    step: sanitizeLine(step, 40),
    findings: findings.slice(0, MAX_FINDINGS).map((f) => ({ id: sanitizeLine(f.id, 120), action: sanitizeLine(f.action, 40), severity: sanitizeLine(f.severity, 40), category: sanitizeLine(f.category, 80), file: sanitizeLine(f.file, 300), cls: f.cls, description: sanitizeLine(f.description, MAX_DESCRIPTION) })),
    ...(findings.length > MAX_FINDINGS ? { truncated: true } : {}),
  };
  const json = JSON.stringify(record);
  return json.length <= MAX_RECORD_BYTES && !record.truncated ? json : JSON.stringify({ v: 1, step: record.step, findings: [], truncated: true });
}

/** The stored record, or null when there is none or it does not read as one. */
export function parseNmRecord(raw: string | null | undefined): NmRecord | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const r = value as Partial<NmRecord>;
  if (r.v !== 1 || typeof r.step !== "string" || !Array.isArray(r.findings)) return null;
  const fields = ["id", "action", "severity", "category", "file", "cls", "description"] as const;
  if (r.findings.some((f) => f === null || typeof f !== "object" || fields.some((k) => typeof (f as unknown as Record<string, unknown>)[k] !== "string"))) return null;
  return r as NmRecord;
}

export interface ExemptInput {
  mode: UnattendedFindingsMode;
  /** Every protected class the question has, recorded or by wording. */
  classes: readonly string[];
  /** The decision's nm_record. */
  record: string | null | undefined;
  /** The recommended option, as an answer. */
  choice: string;
  /** The worker's own words: question, context, why. */
  texts: readonly (string | null)[];
}

export type Exemption = { exempt: true; rule: string } | { exempt: false; why: string };

/** Whether the finding rule lets a protected question be decided. Pure. */
export function exemptFinding(input: ExemptInput): Exemption {
  if (input.mode === "off") return { exempt: false, why: "the finding rule is off" };
  const covered = MODE_CLASSES[input.mode];
  const uncovered = input.classes.filter((c) => !(covered as readonly string[]).includes(c));
  if (uncovered.length > 0) return { exempt: false, why: `the finding rule (${input.mode}) does not cover ${uncovered.join(", ")}` };
  if (input.record === null || input.record === undefined || input.record === "") return { exempt: false, why: "no no-mistakes record" };
  const record = parseNmRecord(input.record);
  if (record === null || record.truncated) return { exempt: false, why: "its no-mistakes record could not be read" };
  if (!LEADER_STEPS.includes(record.step)) return { exempt: false, why: `a ${record.step || "unknown"} gate` };
  const asks = record.findings.filter((f) => f.action === "ask-user");
  if (asks.length === 0) return { exempt: false, why: "no ask-user finding in its no-mistakes record" };
  for (const f of asks) {
    const id = f.id || "a finding";
    if (f.severity.trim() === "") return { exempt: false, why: `finding ${id} has no severity` };
    if (f.severity.trim().toLowerCase() === "error") return { exempt: false, why: `finding ${id} is an error` };
    if (f.file.trim() === "" || !INSIDE.includes(f.cls)) return { exempt: false, why: `finding ${id} is outside the branch's diff` };
  }
  const secretFile = record.findings.find((f) => SECRET_FILE.test(f.file));
  if (secretFile) return { exempt: false, why: `finding ${secretFile.id || "a finding"} is in a secrets file` };
  const kind = answerKind(input.choice);
  if (kind === "skip") return { exempt: false, why: "the recommendation skips it" };
  const findingText = record.findings.map((f) => `${f.id}\n${f.category}\n${f.description}`);
  const all = [input.choice, ...input.texts.filter((t): t is string => t !== null), ...findingText].join("\n");
  // Every class's real actions, not only the question's: a real action of any kind parks.
  for (const klass of MODE_CLASSES["by-answer"]) {
    for (const re of REAL_ACTIONS[klass]) {
      const hit = re.exec(all);
      if (hit) return { exempt: false, why: `its wording names a real ${klass} action (${sanitizeLine(hit[0], 60)})` };
    }
  }
  if (kind === "approve") for (const klass of input.classes) {
    if (klass === "credential") {
      if (record.findings.some((f) => CREDENTIAL_CATEGORY.test(f.category))) return { exempt: false, why: "an approve on a secrets finding" };
      const waive = CREDENTIAL_WAIVE.exec(all);
      if (waive) return { exempt: false, why: `an approve on a finding that touches credentials (${sanitizeLine(waive[0], 60)})` };
    }
    if (klass === "security" && record.findings.some((f) => SECURITY_CATEGORY.test(f.category))) return { exempt: false, why: "an approve on a security finding" };
  }
  return { exempt: true, rule: MODE_RULE[input.mode] };
}
