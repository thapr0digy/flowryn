import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { DOC_SECTIONS, type DocKind } from "./brief.ts";
import { DOC_TEMPLATES } from "./brief-templates.ts";

const KINDS = Object.keys(DOC_TEMPLATES) as DocKind[];

/**
 * `flowryn template <ship|scout|handoff|spec>`: the shape Flowryn checks a
 * brief, a stage handoff or a design build spec against
 * (docs/notes/2026-11-05-workers-get-rich-hx.md). Read-only; fill every {{slot}}.
 */
const templateVerb: VerbSpec = {
  name: "template",
  summary: "Print the shape of a ship or scout brief, a stage handoff, or a design build spec",
  positionals: [{ name: "kind", required: true, help: KINDS.join(", ") }],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human", "worker"],
  scope: { kind: "none" },
  read(_ctx, args) {
    const kind = stringArg(args, "kind") as DocKind;
    if (!KINDS.includes(kind)) throw new FlowrynError("bad_args", `template takes ${KINDS.join(", ")}`);
    return { data: { kind, required: DOC_SECTIONS[kind].map((s) => s.title), template: DOC_TEMPLATES[kind] } };
  },
};

export const BRIEF_VERBS: VerbSpec[] = [templateVerb];
