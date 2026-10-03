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

export interface DecisionsConfig {
  reserved_classes: string[];
}

export function decisionsConfig(config: FlowrynConfig): DecisionsConfig {
  const raw = table(config.extra.decisions, "[decisions]");
  for (const key of Object.keys(raw)) if (key !== "reserved_classes") throw new FlowrynError("config_invalid", `[decisions] ${key} is not a known setting`);
  const classes = raw.reserved_classes ?? [...RESERVED_CLASSES];
  if (!Array.isArray(classes) || classes.some((c) => typeof c !== "string")) throw new FlowrynError("config_invalid", "[decisions] reserved_classes must be a list of class names");
  const unknown = (classes as string[]).filter((c) => !(RESERVED_CLASSES as readonly string[]).includes(c));
  if (unknown.length > 0) throw new FlowrynError("config_invalid", `[decisions] reserved_classes: ${unknown.join(", ")} is not one of ${RESERVED_CLASSES.join(", ")}`);
  return { reserved_classes: classes as string[] };
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
