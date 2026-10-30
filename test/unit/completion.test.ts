import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbSpec } from "../../src/api/verbs.ts";
import { completionTree, allNodes } from "../../src/cli/completion/model.ts";
import { zshQuote, zshScript } from "../../src/cli/completion/zsh.ts";
import { CLI_VERBS } from "../../src/cli/registry.ts";
import { HARNESS_IDS } from "../../src/harness/types.ts";

/** zsh completion from the registry (docs/notes/2026-10-29-zsh-completions-for-49.md). */

const script = zshScript(CLI_VERBS, "0.0.0-test");

/** The `(<name>) specs+=( ... ) ;;` block of one verb in `_flowryn_verb_args`, or null when it has no arguments. */
function argsBlock(text: string, name: string): string | null {
  const start = text.indexOf(`    (${zshQuote(name)}) specs+=(\n`, text.indexOf("_flowryn_verb_args() {"));
  if (start === -1) return null;
  return text.slice(start, text.indexOf("\n    ) ;;", start));
}

/** The `(<prefix>) reply=( ... ) ;;` block of `_flowryn_children`. */
function childrenBlock(text: string, prefix: string): string {
  const start = text.indexOf(`    (${zshQuote(prefix)}) reply=(\n`);
  if (start === -1) return "";
  return text.slice(start, text.indexOf("\n    ) ;;", start));
}

function isVerbCase(text: string): string {
  const start = text.indexOf("_flowryn_is_verb() {");
  return text.slice(start, text.indexOf("}", start));
}

describe("the zsh script covers the registry", () => {
  test("every verb's words are offered under their parent, and every verb is known as one", () => {
    const missing: string[] = [];
    const verbs = isVerbCase(script);
    for (const spec of CLI_VERBS) {
      const words = spec.name.split(" ");
      words.forEach((word, i) => {
        const parent = words.slice(0, i).join(" ");
        if (!childrenBlock(script, parent).includes(`'${word}:`)) missing.push(`${spec.name}: word ${word} under "${parent}"`);
      });
      if (!verbs.includes(zshQuote(spec.name))) missing.push(`${spec.name}: not a verb`);
    }
    expect(missing).toEqual([]);
  });

  test("every flag and positional of every verb is in that verb's own block", () => {
    const missing: string[] = [];
    for (const spec of CLI_VERBS) {
      const block = argsBlock(script, spec.name);
      const flags = Object.keys(spec.flags);
      if (flags.length + spec.positionals.length === 0) continue;
      if (block === null) {
        missing.push(`${spec.name}: no block`);
        continue;
      }
      for (const flag of flags) if (!new RegExp(`'\\*?--${flag}[=[]`).test(block)) missing.push(`${spec.name} --${flag}`);
      spec.positionals.forEach((p, i) => {
        if (!block.includes(`'${i + 1}:${p.required ? "" : ":"}`)) missing.push(`${spec.name} <${p.name}>`);
      });
    }
    expect(missing).toEqual([]);
  });

  test("every fixed value is offered, and every id source is looked up, where its flag or positional is", () => {
    const missing: string[] = [];
    for (const spec of CLI_VERBS) {
      const block = argsBlock(script, spec.name) ?? "";
      const hints = [
        ...Object.entries(spec.flags).map(([name, f]) => ({ what: `--${name}`, at: new RegExp(`^\\s*'\\*?--${name}[=[]`), ...f })),
        ...spec.positionals.map((p, i) => ({ what: `<${p.name}>`, at: new RegExp(`^\\s*'${i + 1}:`), ...p })),
      ];
      for (const hint of hints) {
        const line = block.split("\n").find((l) => hint.at.test(l)) ?? "";
        for (const v of hint.values ?? []) if (!new RegExp(`[({ ]${v.replace(/[-]/g, "\\-")}[) }]`).test(line)) missing.push(`${spec.name} ${hint.what}: ${v}`);
        if (hint.complete && !line.includes(`{_flowryn_ids ${hint.complete}`)) missing.push(`${spec.name} ${hint.what}: source ${hint.complete}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("dispatch offers ship, scout and ask for --kind, and every --harness offers claude and pi", () => {
    expect(argsBlock(script, "dispatch")).toContain("'--kind=[ship, scout or ask]:kind:(ship scout ask)'");
    const bare = CLI_VERBS.flatMap((v) => (v.flags.harness && v.flags.harness.values?.join() !== HARNESS_IDS.join() ? [v.name] : []));
    expect(bare).toEqual([]);
  });

  test("verify is both a verb and the parent of verify show; capacity of capacity resume", () => {
    const tree = completionTree(CLI_VERBS);
    for (const name of ["verify", "capacity", "completion"]) {
      const node = allNodes(tree).find((n) => n.path === name)!;
      expect(node.verb?.name).toBe(name);
      expect(node.children.length).toBeGreaterThan(0);
    }
  });

  test("the script is regenerated from the registry, not kept: a new verb and flag appear at once", () => {
    const extra: VerbSpec = { name: "zz new", summary: "a verb added later", positionals: [], flags: { brand: { type: "boolean", help: "a new flag" } }, kind: "local", roles: ["human"] };
    const text = zshScript([...CLI_VERBS, extra], "0.0.0-test");
    expect(childrenBlock(text, "")).toContain("'zz:new'");
    expect(argsBlock(text, "zz new")).toContain("'--brand[a new flag]'");
  });
});

describe("text that would break zsh's syntax is quoted", () => {
  const odd: VerbSpec = {
    name: "odd",
    summary: "it's [weird]: a\\b",
    positionals: [{ name: "x", required: false, help: "a: b's [c]", values: ["a:b", "c d"] }],
    flags: { "say-it": { type: "string", help: "quote ' colon : brackets [x] backslash \\ dollar $HOME", placeholder: "a:b" } },
    kind: "local",
    roles: ["human"],
  };
  const text = zshScript([odd], "0.0.0-test");

  test("quotes, colons, brackets and backslashes are escaped for single quotes and _arguments", () => {
    expect(text).toContain(`'--say-it=[quote '\\'' colon : brackets \\[x\\] backslash \\\\ dollar $HOME]:a\\:b: '`);
    expect(text).toContain(`'1::a\\: b'\\''s [c]:(a\\:b c\\ d)'`);
    expect(text).toContain(`'odd:it'\\''s [weird]: a\\b'`);
  });

  // CI's ubuntu-latest image has no zsh; the Mac run, where zsh is the login shell, covers this.
  test.skipIf(!Bun.which("zsh"))("zsh parses the script, the real registry's and an awkward one", () => {
    const dir = mkdtempSync(join(tmpdir(), "fl-zsh-"));
    try {
      for (const [name, body] of [["real", script], ["odd", text]] as const) {
        const file = join(dir, name);
        writeFileSync(file, body);
        const checked = Bun.spawnSync(["zsh", "-n", file], { stdout: "pipe", stderr: "pipe" });
        expect({ name, code: checked.exitCode, stderr: checked.stderr.toString() }).toEqual({ name, code: 0, stderr: "" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

