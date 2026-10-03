import { DECISION_KEY } from "./decisions.ts";

/**
 * A scout report's `## Open decisions` (cutover C1): one `### <key>:
 * <question>` entry each, then `Options:`, `Recommendation:`, `Why it
 * matters:` and an optional `Reserved:` line. A malformed entry still becomes
 * a decision, whose question is its raw text, so nothing a scout raised is
 * lost; the warning goes into the landing event.
 */

export interface ReportDecision {
  key: string;
  question: string;
  options: string[];
  recommendation: string | null;
  context: string | null;
  reserved: string | null;
  raw: string;
  warning: string | null;
}

const HEADING = /^###\s+([a-z0-9][a-z0-9-]{0,47}):\s*(.+?)\s*$/;
const FIELD = /^(options|recommendation|why it matters|reserved):\s*(.*)$/i;

function section(report: string): string[] | null {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => /^##\s+open decisions\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

export function parseOpenDecisions(report: string): ReportDecision[] {
  const lines = section(report);
  if (!lines) return [];
  const entries: string[][] = [];
  for (const line of lines) {
    if (/^###\s/.test(line)) entries.push([line]);
    else if (entries.length > 0) entries[entries.length - 1]!.push(line);
  }
  return entries.map((entry, i) => {
    const raw = entry.join("\n").trim();
    const head = HEADING.exec(entry[0]!.trim());
    if (!head || !DECISION_KEY.test(head[1]!)) {
      return { key: `entry-${i + 1}`, question: raw.replace(/^###\s*/, ""), options: [], recommendation: null, context: null, reserved: null, raw, warning: `entry ${i + 1}: the heading is not "### <key>: <question>"` };
    }
    const fields: Record<string, string> = {};
    for (const line of entry.slice(1)) {
      const m = FIELD.exec(line.trim());
      if (m) fields[m[1]!.toLowerCase()] = m[2]!.trim();
    }
    const options = (fields.options ?? "").split(",").map((o) => o.trim()).filter(Boolean);
    return {
      key: head[1]!,
      question: head[2]!,
      options,
      recommendation: fields.recommendation || null,
      context: fields["why it matters"] || null,
      reserved: fields.reserved || null,
      raw,
      warning: null,
    };
  });
}
