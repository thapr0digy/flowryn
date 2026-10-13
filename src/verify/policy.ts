import { createHash } from "node:crypto";
import type { VerifyConfig } from "./config.ts";

/**
 * A verify policy's identity (docs/notes/2026-10-13-next-steps-md-y4.md): a
 * hash of the ordered steps and the required artifact, recorded with each
 * verification, so a result counts only for the policy it ran under.
 * Formatting noise in a step does not change it; a changed, added, removed
 * or reordered step, or a changed artifact, does. The time limit is not part
 * of it: it does not change what a pass proved.
 */

const TAG = "flowryn-verify-policy";
const ENCODING = 1;

/**
 * A step with its formatting noise removed: trimmed, and each run of spaces
 * and tabs outside quotes collapsed to one space. Whitespace inside quotes or
 * after a backslash is part of an argument and kept; so are newlines, which
 * separate commands in /bin/sh.
 */
export function normalizeStep(step: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let pendingSpace = false;
  const text = step.trim();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
    if (ch === "\\" && quote !== "'" && i + 1 < text.length) {
      out += text[++i]!;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    else if (quote !== null && ch === quote) quote = null;
  }
  return out;
}

/** "vp1:<sha256 hex>" of the normalized steps, in order, and the artifact. */
export function verifyPolicyId(config: Pick<VerifyConfig, "steps" | "binary">): string {
  const canonical = JSON.stringify([TAG, ENCODING, config.steps.map(normalizeStep), config.binary]);
  return `vp${ENCODING}:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The first hex digits, for messages. */
export function shortPolicy(id: string | null): string {
  return id === null ? "none recorded" : id.slice(0, 16);
}
