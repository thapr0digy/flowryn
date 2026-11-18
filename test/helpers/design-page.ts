import { DESIGN_GAP_CHECKS } from "../../src/skills/design-gap-check.ts";
import { DESIGN_PLACEHOLDERS, DESIGN_TEMPLATE } from "../../src/skills/design-template.ts";

const WIDGET = '<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>';

/** A gaps part's content for a clean gap check: the verdict and every check, each "none". */
export function cleanGapCheck(verdict = "ready"): string {
  const rows = DESIGN_GAP_CHECKS.map((c, i) => `<tr><td>${i + 1}</td><td>${c.name}</td><td>none</td></tr>`).join("");
  return `<p>Verdict: ${verdict}</p><table>${rows}</table>`;
}

/**
 * A design page that passes the design stage's check: the template with
 * every slot filled in plain words and a clean gap check, on one line so a
 * FAKE: write step can carry it. `widget` mounts the question widget in
 * "What I need from you".
 */
export function filledDesignPage(opts: { widget?: boolean } = {}): string {
  let page = DESIGN_TEMPLATE.replace("{{ASK}}", opts.widget ? `Answer the questions below. ${WIDGET}` : "Approve, or send changes.").replace("{{GAPS}}", cleanGapCheck());
  for (const slot of DESIGN_PLACEHOLDERS) page = page.replaceAll(slot, "Filled by the fake worker.");
  return page.replace(/\s*\n\s*/g, " ");
}
