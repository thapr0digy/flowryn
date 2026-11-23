import type { DecisionsConfig } from "./decisions-policy.ts";
import type { GateFacts } from "./gate-validator.ts";
import { isTerminal } from "../lifecycle/runs.ts";
import { DESIGN_GAP_REVISE_VERDICT, DESIGN_GAP_VERDICTS } from "../skills/design-gap-check.ts";
import { gapCheckOf } from "../skills/design-template.ts";
import { qaNothingVisible, qaSeverities, qaVerdictOf } from "../skills/qa-template.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The evidence gate's rules (docs/notes/2026-11-23-phase-gates-pass-8f.md): on a project with
 * `[projects.<id>] gate_pass = "evidence"` a design or QA review gate passes, on channel
 * `evidence`, when its objective evidence is green, and its page goes into the briefing after the
 * fact with the undo. Pure: the pass (src/attention/evidence-pass.ts) reads the files first.
 *
 * - QA: the card's verdict is works, no finding is a blocker or a major, every probe file is clean,
 *   and the project's verify passed at the gate's head. Plain code: no model.
 * - Design: the gap check's verdict is ready (with or without fixes), its "Simplest secure option"
 *   check records nothing (a design that adds infrastructure stays the user's), and an independent
 *   fresh validator round (src/attention/gate-validator.ts, basis `evidence`) says pass. The model
 *   judges only whether the design holds up against its brief; everything else is plain code.
 *
 * A sensitive task, a gate carrying a phase plan, and a stage that was once reopened by the user
 * stay the user's.
 */

export const EVIDENCE_CHANNEL = "evidence";

/** The QA stage's probe files, beside the evidence page: `qa/probe-<screen>-<WxH>-<theme>-<state>.json`. */
export const PROBE_FILE = /^probe-[\w.-]+\.json$/;
/** At most this many probe files are read; a QA run with more holds for the user. */
export const MAX_PROBE_FILES = 200;
/** A probe file over this size holds for the user: the probe caps its lists at 50 entries. */
export const MAX_PROBE_BYTES = 1024 * 1024;

/**
 * The probe's lists in which any entry is a measured defect. Left out on purpose, as the QA method
 * says they need judgement: `clipped` with an ellipsis (truncation the design may intend),
 * `contrastUnknown` (text over an image), `offToken` (browser defaults on untouched elements) and
 * `errors` (nodes the probe could not read).
 */
const PROBE_DEFECTS = ["overflow", "overlaps", "contrast", "names", "images"] as const;

/** Why a gate's evidence is not green: `wait` while it may still turn green by itself. */
export interface EvidenceRefusal {
  why: string;
  wait: boolean;
}

const hold = (why: string): EvidenceRefusal => ({ why, wait: false });
const wait = (why: string): EvidenceRefusal => ({ why, wait: true });

/** What one probe file measured that is a defect; empty when clean. */
export function probeProblems(name: string, text: string): string[] {
  let probe: unknown;
  try {
    probe = JSON.parse(text);
  } catch {
    return [`${name} is not JSON`];
  }
  if (probe === null || typeof probe !== "object" || Array.isArray(probe)) return [`${name} is not a probe result`];
  const p = probe as Record<string, unknown>;
  if (typeof p.error === "string") return [`${name}: the probe failed (${sanitizeLine(p.error, 80)})`];
  const problems: string[] = [];
  if (p.pageOverflow !== null && p.pageOverflow !== undefined) problems.push(`${name}: the page scrolls sideways`);
  for (const list of PROBE_DEFECTS) {
    const value = p[list];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return [`${name}: ${list} is not a list`];
    if (value.length > 0) problems.push(`${name}: ${value.length} ${list}`);
  }
  const clipped = p.clipped;
  if (Array.isArray(clipped)) {
    const cut = clipped.filter((c) => !(c !== null && typeof c === "object" && (c as Record<string, unknown>).ellipsis === true)).length;
    if (cut > 0) problems.push(`${name}: ${cut} clipped without an ellipsis`);
  }
  return problems;
}

export interface QaEvidence {
  verdict: string;
  probes: number;
  nothingVisible: boolean;
}

/**
 * The QA page's own evidence: works, no blocker or major, and every probe clean (a change with
 * nothing to see needs no probe). The verify at the head is the pass's to read. Pure.
 */
export function qaEvidence(input: { html: string; probes: readonly { name: string; text: string }[] }): { ok: true; evidence: QaEvidence } | { ok: false; why: string } {
  const verdict = qaVerdictOf(input.html);
  if (verdict !== "works") return { ok: false, why: `the QA verdict is ${verdict ?? "missing"}, not works` };
  const severities = qaSeverities(input.html);
  const serious = ["blocker", "major"].filter((s) => severities.includes(s));
  if (serious.length > 0) return { ok: false, why: `the QA page has ${serious.join(" and ")} findings` };
  const nothingVisible = qaNothingVisible(input.html);
  if (!nothingVisible && input.probes.length === 0) return { ok: false, why: "no probe was run: qa/probe-*.json is missing" };
  const problems = input.probes.flatMap((p) => probeProblems(p.name, p.text));
  if (problems.length > 0) return { ok: false, why: `the probe is not clean: ${sanitizeLine(problems.slice(0, 3).join("; "), 200)}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}` };
  return { ok: true, evidence: { verdict, probes: input.probes.length, nothingVisible } };
}

/** The design page's own evidence: a ready gap check whose "Simplest secure option" check records nothing. Pure. */
export function designEvidence(html: string): { ok: true; gap: string } | { ok: false; why: string } {
  const gap = gapCheckOf(html);
  const ready = DESIGN_GAP_VERDICTS.filter((v) => v !== DESIGN_GAP_REVISE_VERDICT) as readonly string[];
  if (gap.verdict === null || !ready.includes(gap.verdict)) return { ok: false, why: `the gap check's verdict is ${gap.verdict ?? "missing"}` };
  if (gap.simplest === null) return { ok: false, why: "the gap check does not record its Simplest secure option check" };
  if (!/^none\b/i.test(gap.simplest)) return { ok: false, why: `the design may add infrastructure: its Simplest secure option check records ${sanitizeLine(gap.simplest, 80)}` };
  return { ok: true, gap: gap.verdict };
}

/**
 * Why the evidence gate may not judge this gate now, or null when it may. The facts are the
 * validator's (gateFacts with basis `evidence`: rounds, holds and reopenings of this task's stage
 * at any time). Pure.
 */
export function evidenceRefusal(f: GateFacts, cfg: Pick<DecisionsConfig, "validator_rounds">): EvidenceRefusal | null {
  if (f.gate.kind !== "review" || f.gate.state !== "open") return hold("the gate is not an open review");
  if (!f.run || isTerminal(f.run.state)) return hold("its run is over");
  if (f.run.sensitive === 1) return hold("sensitive task: its reviews are the user's");
  if (f.pendingPlan) return hold("it carries a phase plan, which only the user approves");
  if (!f.gate.page_path) return hold("no review page");
  if (!f.pinned) return hold("its page or spec changed since it was pinned");
  if (f.heldUnderAway) return hold("an earlier evidence round held this stage for the user");
  if (f.reopenedUnderAway) return hold("the user reopened an evidence pass of this stage: its reviews are theirs");
  if (f.roundsUsed >= cfg.validator_rounds) return hold(`${f.roundsUsed} evidence rounds used on this stage`);
  if (f.autonomyCovered) return wait("unattended mode covers its run");
  if (f.running) return wait("a validation is already running");
  if (f.questions.length > 0) return wait("its questions are the user's to answer first");
  return null;
}
