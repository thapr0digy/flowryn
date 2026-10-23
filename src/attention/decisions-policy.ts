import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { table } from "../config/config.ts";

/**
 * Which decisions only the user may answer (cutover C1). The leader decides
 * everything else and records why. A source's own reason wins; otherwise
 * the text is matched against the reserved classes, erring toward reserved.
 * The leader may add a reason later but never remove one.
 */

export const RESERVED_CLASSES = ["merge", "destructive", "irreversible", "security", "credential", "outward"] as const;
export type ReservedClass = (typeof RESERVED_CLASSES)[number];

const PATTERNS: Record<Exclude<ReservedClass, "merge">, RegExp> = {
  irreversible: /\b(force[- ]push|rewrite (the )?history|irreversibl\w*|cannot be undone|permanent(ly)?)\b/i,
  destructive: /\b(delete|drop|destroy|wipe|purge|erase|truncate|discard|remove (the )?(data|rows|bucket|database))\b/i,
  credential: /\b(credential|secret|api[- ]?key|token|password|signing key|private key|rotate (the )?key|revoke)\b/i,
  security: /\b(disable (tls|ssl|auth|mfa|2fa|verification)|loosen|weaken|allow ?list|permission(s)? (to|for) all|public(ly)? (bucket|access)|security (exception|risk))\b/i,
  outward: /\b(publish|announce|post (to|on)|email (the )?(client|customer)|tweet|press release|send to (the )?(client|customer))\b/i,
};

/**
 * Where a no-mistakes finding's file sits against the branch's own diff
 * (src/policy/nomistakes-rules.ts): the branch added the file; the finding's
 * line is one the branch added or changed; the file is in the diff but the
 * line is not (or there is no line); the file is not in the diff; no file.
 */
export const FILE_CLASSES = ["added", "diff-line", "touched", "outside", "none"] as const;
export type FileClass = (typeof FILE_CLASSES)[number];
export const RULE_ANSWERS = ["fix", "approve", "skip"] as const;
export type RuleAnswer = (typeof RULE_ANSWERS)[number];

/** One row of `[decisions] nomistakes_rules`: a gate step, a severity and file classes settle an ask-user finding with an answer. */
export interface NmRule {
  id: string;
  step: string;
  severity: string;
  file: FileClass[];
  answer: RuleAnswer;
}

/** The user's ruling (2026-10-22): fix lint warnings in files the branch added, and review warnings inside its own diff. */
export const DEFAULT_NM_RULES: readonly NmRule[] = [
  { id: "lint-warning-added", step: "lint", severity: "warning", file: ["added"], answer: "fix" },
  { id: "review-warning-diff", step: "review", severity: "warning", file: ["added", "diff-line"], answer: "fix" },
];

/** What no rule may settle, whatever the config says: CI gates, errors, and findings outside the branch's diff. */
export const NM_FLOOR = { steps: ["ci"], severities: ["error"], files: ["outside", "none"] as FileClass[] } as const;

const RULE_KEYS = ["id", "step", "severity", "file", "answer"];
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RULE_WORD = /^[a-z][a-z0-9-]{0,31}$/;

export interface DecisionsConfig {
  reserved_classes: string[];
  nomistakes_rules: NmRule[];
}

export function decisionsConfig(config: FlowrynConfig): DecisionsConfig {
  const raw = table(config.extra.decisions, "[decisions]");
  for (const key of Object.keys(raw)) if (key !== "reserved_classes" && key !== "nomistakes_rules") throw new FlowrynError("config_invalid", `[decisions] ${key} is not a known setting`);
  const classes = raw.reserved_classes ?? [...RESERVED_CLASSES];
  if (!Array.isArray(classes) || classes.some((c) => typeof c !== "string")) throw new FlowrynError("config_invalid", "[decisions] reserved_classes must be a list of class names");
  const unknown = (classes as string[]).filter((c) => !(RESERVED_CLASSES as readonly string[]).includes(c));
  if (unknown.length > 0) throw new FlowrynError("config_invalid", `[decisions] reserved_classes: ${unknown.join(", ")} is not one of ${RESERVED_CLASSES.join(", ")}`);
  const rules = raw.nomistakes_rules === undefined ? DEFAULT_NM_RULES.map((r) => ({ ...r, file: [...r.file] })) : nmRules(raw.nomistakes_rules);
  return { reserved_classes: classes as string[], nomistakes_rules: rules };
}

/** `[decisions] nomistakes_rules`, checked whole: a rule the floor forbids is refused, never silently dropped. */
function nmRules(value: unknown): NmRule[] {
  const where = "[decisions] nomistakes_rules";
  if (!Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} must be a list of { id, step, severity, file, answer } tables`);
  const seen = new Set<string>();
  return value.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new FlowrynError("config_invalid", `${where}[${i}] must be a table`);
    const rule = entry as Record<string, unknown>;
    const at = `${where}[${i}]`;
    for (const key of Object.keys(rule)) if (!RULE_KEYS.includes(key)) throw new FlowrynError("config_invalid", `${at}: ${key} is not one of ${RULE_KEYS.join(", ")}`);
    const { id, step, severity, answer } = rule;
    if (typeof id !== "string" || !RULE_ID.test(id)) throw new FlowrynError("config_invalid", `${at}: id must be lowercase letters, digits and dashes`);
    if (seen.has(id)) throw new FlowrynError("config_invalid", `${at}: id ${id} is used twice`);
    seen.add(id);
    if (typeof step !== "string" || !RULE_WORD.test(step)) throw new FlowrynError("config_invalid", `${at} (${id}): step must be a no-mistakes step name, such as lint or review`);
    if ((NM_FLOOR.steps as readonly string[]).includes(step)) throw new FlowrynError("config_invalid", `${at} (${id}): a ${step} gate is always the user's; no rule may settle it`);
    if (typeof severity !== "string" || !RULE_WORD.test(severity)) throw new FlowrynError("config_invalid", `${at} (${id}): severity must be a no-mistakes severity, such as warning`);
    if ((NM_FLOOR.severities as readonly string[]).includes(severity)) throw new FlowrynError("config_invalid", `${at} (${id}): an ${severity} finding is always the user's; no rule may settle it`);
    const files = typeof rule.file === "string" ? [rule.file] : rule.file;
    if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== "string" || !(FILE_CLASSES as readonly string[]).includes(f))) throw new FlowrynError("config_invalid", `${at} (${id}): file must list classes from ${FILE_CLASSES.join(", ")}`);
    const floored = (files as FileClass[]).filter((f) => NM_FLOOR.files.includes(f));
    if (floored.length > 0) throw new FlowrynError("config_invalid", `${at} (${id}): file class ${floored.join(", ")} is outside the branch's diff, always the user's`);
    if (typeof answer !== "string" || !(RULE_ANSWERS as readonly string[]).includes(answer)) throw new FlowrynError("config_invalid", `${at} (${id}): answer must be one of ${RULE_ANSWERS.join(", ")}`);
    return { id, step, severity, file: [...new Set(files as FileClass[])], answer: answer as RuleAnswer };
  });
}

/** The text names a history rewrite or another irreversible step: no rule settles such a finding. */
export function irreversibleText(text: string): boolean {
  return PATTERNS.irreversible.test(text);
}

export interface ReservedInput {
  question: string;
  context: string | null;
  /** The source's own reason (ask --reserved, a report's Reserved: line). */
  sourceReason: string | null;
  /** The decision blocks a task that merges only with a human record (yolo off, or sensitive). */
  blocksYoloOff: boolean;
}

/** The reason only the user may answer, or null when the leader may. */
export function reservedReason(input: ReservedInput, cfg: DecisionsConfig): string | null {
  if (input.sourceReason && input.sourceReason.trim().length > 0) return input.sourceReason.trim().slice(0, 200);
  const enabled = new Set(cfg.reserved_classes);
  if (input.blocksYoloOff && enabled.has("merge")) return "merge";
  const text = `${input.question}\n${input.context ?? ""}`;
  for (const klass of ["irreversible", "destructive", "credential", "security", "outward"] as const) {
    if (enabled.has(klass) && PATTERNS[klass].test(text)) return klass;
  }
  return null;
}
