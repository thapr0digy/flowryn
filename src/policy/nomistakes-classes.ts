import { RESERVED_PATTERNS, type FileClass } from "../attention/decisions-policy.ts";
import type { NmFinding } from "./nomistakes.ts";

/**
 * Who answers a no-mistakes ask-user finding no rule settled
 * (docs/notes/2026-11-06-prompts-that-keep-47.md). Plain lookup, no model:
 * each finding is judged on its own fields (description, category, file
 * class) and the ask's options, never on the worker's question text. The
 * user's ruling (2026-11-06): the leader decides a finding whose fix plainly
 * follows the approved design or brief; scope growth, open product calls,
 * destructive and security-loosening findings stay the user's. It fails
 * closed: a finding of a kind the table does not know stays reserved.
 */

/** A reserved class: what only the user may answer. */
export type ReservedFindingClass = "irreversible" | "destructive" | "security" | "credential" | "scope" | "product";

/** What the classifier reads for one finding. */
export interface FindingFacts {
  finding: Pick<NmFinding, "id" | "description" | "category" | "severity">;
  /** Where its file sits against the branch's diff. */
  file: FileClass;
  /** The gate's step (the finding's kind when no-mistakes prints no category). */
  step: string;
  /** The ask's options: a harmless-looking finding whose option deletes is still destructive. */
  options: readonly string[];
}

export interface FindingClassRule {
  klass: ReservedFindingClass;
  /** How it is detected, in words (the docs note's table is this). */
  detect: string;
  test(facts: FindingFacts): boolean;
}

const SECURITY_CATEGORY = /\b(security|auth\w*|permission\w*|access|sandbox|crypto\w*|injection|xss|csrf|ssrf|cors|tls|ssl)\b/i;
const SECURITY_LOOSENING = /\b(bypass\w*|disabl\w+|turn(s|ing)? off|relax\w*|allow[- ]all|wildcard|world[- ]writable|chmod (7|6)77|--no-verify|unsafe|insecure|no[- ]?auth|sandbox)\b/i;
const CREDENTIAL_CATEGORY = /\b(secrets?|credentials?|tokens?|keys?|passwords?)\b/i;
const DESTRUCTIVE_CATEGORY = /\b(destructive|data[- ]?loss|irreversible)\b/i;
const SCOPE_TEXT = /\b(out of scope|scope (creep|growth)|new feature|feature request|also (add|support|handle)|follow[- ]?up|separate (task|pr|change)|redesign|re-?architect\w*|rewrite (the|this|all)|refactor (the|all|every)|new (api|endpoint|dependency|module|service|table|verb|flag)|add (a |another )?(dependency|package|library))\b/i;
const SCOPE_CATEGORY = /\b(scope|architecture|design)\b/i;
const PRODUCT_TEXT = /\b(product (call|decision)|user[- ]facing|ux|behaviou?r change|breaking change|public api|default (value|behaviou?r)|deprecat\w*|pricing|licen[cs]e)\b/i;
const PRODUCT_CATEGORY = /\b(product|ux|ui|breaking|api|compat\w*|licen[cs]\w*)\b/i;

/** The finding's own words: its description and category, then the ask's options. */
function words(f: FindingFacts): string {
  return [f.finding.description, f.finding.category, ...f.options].join("\n");
}

/**
 * The one table: a finding any row matches is the user's, under that row's
 * class (the first that matches names the reason). Order: the classes no
 * deadline may ever answer first.
 */
export const FINDING_CLASS_TABLE: readonly FindingClassRule[] = [
  { klass: "irreversible", detect: "its description, category or an option names an irreversible step (force-push, a history rewrite, permanent, cannot be undone)", test: (f) => RESERVED_PATTERNS.irreversible.test(words(f)) },
  {
    klass: "destructive",
    detect: "its description or an option names deleting, dropping, wiping, purging, truncating or discarding; or its category is destructive or data-loss",
    test: (f) => RESERVED_PATTERNS.destructive.test(words(f)) || DESTRUCTIVE_CATEGORY.test(f.finding.category),
  },
  {
    klass: "credential",
    detect: "its description or an option names a credential, secret, API key, token, password or key rotation; or its category is secrets or credentials",
    test: (f) => RESERVED_PATTERNS.credential.test(words(f)) || CREDENTIAL_CATEGORY.test(f.finding.category),
  },
  {
    klass: "security",
    detect: "its category is security, auth, permissions, sandbox, crypto, injection, XSS, CSRF, SSRF, CORS or TLS (any security finding, tightening or not); or its description or an option names loosening (bypass, disable, turn off, relax, allow-all, wildcard, --no-verify, unsafe, sandbox)",
    test: (f) => SECURITY_CATEGORY.test(f.finding.category) || RESERVED_PATTERNS.security.test(words(f)) || SECURITY_LOOSENING.test(words(f)),
  },
  {
    klass: "scope",
    detect: "its file is outside the branch's diff; its category is scope, architecture or design; or its description or an option names new work (a new feature, endpoint, dependency, module, a follow-up, a redesign or a wholesale rewrite or refactor)",
    test: (f) => f.file === "outside" || SCOPE_CATEGORY.test(f.finding.category) || SCOPE_TEXT.test(words(f)),
  },
  {
    klass: "product",
    detect: "its category is product, UX, UI, breaking, API, compatibility or licence; or its description or an option names a product call (user-facing behaviour, a breaking change, a public API, a default, a deprecation, pricing, a licence, publishing)",
    test: (f) => PRODUCT_CATEGORY.test(f.finding.category) || PRODUCT_TEXT.test(words(f)) || RESERVED_PATTERNS.outward.test(words(f)),
  },
];

/**
 * The kinds the leader may decide once no row matched: the finding's category,
 * or when it has none its gate's step. Anything else (ci, rebase, push, an
 * unknown category) is a kind the table cannot judge, so it stays reserved.
 */
export const LEADER_KINDS: readonly string[] = [
  "review", "lint", "test", "tests", "testing", "document", "docs", "documentation", "format", "formatting", "style", "typo",
  "naming", "readability", "maintainability", "complexity", "duplication", "dead-code", "error-handling", "correctness", "bug",
  "performance", "types", "typing", "typecheck",
];

/** The file classes inside the branch's own change: a finding there is about this change. */
const INSIDE: readonly FileClass[] = ["added", "diff-line", "touched"];

export type FindingVerdict = { owner: "user"; klass: ReservedFindingClass | "unknown"; reason: string } | { owner: "leader" };

/** One finding: the user's (with its class and why) or the leader's. */
export function classifyFinding(facts: FindingFacts): FindingVerdict {
  const id = facts.finding.id || "a finding";
  const row = FINDING_CLASS_TABLE.find((r) => r.test(facts));
  if (row) return { owner: "user", klass: row.klass, reason: row.klass === "scope" && facts.file === "outside" ? `${id} is outside the diff` : `${id} is ${row.klass}` };
  const kind = (facts.finding.category.trim() || facts.step.trim()).toLowerCase();
  if (!LEADER_KINDS.includes(kind)) return { owner: "user", klass: "unknown", reason: `${id} is of a kind no table row judges (${kind || "none"})` };
  if (!INSIDE.includes(facts.file)) return { owner: "user", klass: "unknown", reason: `${id} names no file in the diff` };
  return { owner: "leader" };
}

export type AskVerdict = { owner: "user"; klass: ReservedFindingClass | "unknown"; reason: string } | { owner: "leader"; findings: string[] };

/** A whole ask: the leader's only when it has ask-user findings and every one is the leader's. */
export function classifyAsk(input: { step: string; findings: readonly (FindingFacts["finding"] & { action: string; cls: FileClass })[]; options: readonly string[]; sensitive: boolean }): AskVerdict {
  const asks = input.findings.filter((f) => f.action === "ask-user");
  if (asks.length === 0) return { owner: "user", klass: "unknown", reason: `no ask-user finding at the ${input.step || "parked"} gate` };
  if (input.sensitive) return { owner: "user", klass: "unknown", reason: "sensitive task" };
  for (const f of asks) {
    const verdict = classifyFinding({ finding: f, file: f.cls, step: input.step, options: input.options });
    if (verdict.owner === "user") return verdict;
  }
  return { owner: "leader", findings: asks.map((f) => f.id) };
}
