/**
 * TOML text that defines one table twice (`[a]` … `[a]`), read the way Bun up to
 * 1.3.x read it: the second header's keys join the first table, and a key set
 * twice is still refused. Bun 1.4 follows the TOML spec and refuses the second
 * header ("Cannot redefine table 'a'"), which would turn a config.toml that
 * loaded yesterday into a daemon that will not start, so the config readers
 * parse through `parseTomlText` (docs/notes/2026-11-04-move-ci-and-2d.md).
 */

/** A header line: `[name]` (a table) or `[[name]]` (an element of an array of tables). */
interface Header {
  name: string;
  array: boolean;
}

const BARE = /^[A-Za-z0-9_-]+$/;

/** A table header's dotted name, normalised (`[ a . "b" ]` is `a.b`), or null when the key is not one we can read plainly. */
function headerName(inner: string): string | null {
  const parts: string[] = [];
  let i = 0;
  const s = inner;
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i]!;
      let j = i + 1;
      let part = "";
      while (j < s.length && s[j] !== quote) {
        if (quote === '"' && s[j] === "\\") return null;
        part += s[j];
        j++;
      }
      if (j >= s.length) return null;
      parts.push(part);
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_-]/.test(s[j]!)) j++;
      if (j === i) return null;
      parts.push(s.slice(i, j));
      i = j;
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    if (s[i] !== ".") return null;
    i++;
  }
  return parts.map((p) => (BARE.test(p) ? p : JSON.stringify(p))).join(".");
}

/**
 * Where each line stands: a header (outside any value), or part of the body.
 * Tracks multi-line strings and arrays or inline tables spread over lines, so a
 * `["a", "b"]` line inside a list is never taken for a header.
 */
function scan(lines: string[]): (Header | null)[] {
  const out: (Header | null)[] = [];
  let depth = 0;
  let multi: '"""' | "'''" | null = null;
  for (const line of lines) {
    if (multi === null && depth === 0) {
      const m = /^\s*(\[\[?)(.*?)(\]\]?)\s*(#.*)?$/.exec(line);
      if (m && m[1]!.length === m[3]!.length) {
        const name = headerName(m[2]!);
        if (name !== null) {
          out.push({ name, array: m[1] === "[[" });
          continue;
        }
      }
    }
    out.push(null);
    // Walk the body line for strings, comments and brackets.
    let i = 0;
    let seenEquals = depth > 0;
    while (i < line.length) {
      if (multi !== null) {
        const end = line.indexOf(multi, i);
        if (end < 0) {
          i = line.length;
          break;
        }
        i = end + 3;
        while (line[i] === multi[0]) i++;
        multi = null;
        continue;
      }
      const c = line[i]!;
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === "=") seenEquals = true;
      else if (seenEquals && (c === "[" || c === "{")) depth++;
      else if (seenEquals && (c === "]" || c === "}")) depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return out;
}

/**
 * The same document with each table's repeated headers folded into its first one:
 * the later header's lines move up to the end of the first table's body, so every
 * table is defined once. Array-of-tables elements (`[[x]]`) and the tables under
 * them stay where they are, one per element. Text with no repeated header comes
 * back unchanged.
 */
export function mergeDuplicateTables(text: string): string {
  const lines = text.split("\n");
  const headers = scan(lines);
  interface Section {
    header: string | null;
    body: string[];
  }
  const sections: Section[] = [{ header: null, body: [] }];
  const byName = new Map<string, Section>();
  // Every array of tables seen so far: a table under one belongs to an element, so it is never folded.
  const arrays = new Set<string>();
  let merged = false;
  let sink = sections[0]!;
  for (let i = 0; i < lines.length; i++) {
    const h = headers[i];
    if (!h) {
      sink.body.push(lines[i]!);
      continue;
    }
    if (h.array) arrays.add(h.name);
    const underArray = h.array || [...arrays].some((a) => h.name === a || h.name.startsWith(`${a}.`));
    const first = underArray ? undefined : byName.get(h.name);
    if (first) {
      // A repeated header: its lines, up to the next header, join the first table.
      merged = true;
      sink = first;
      continue;
    }
    sink = { header: lines[i]!, body: [] };
    sections.push(sink);
    if (!underArray) byName.set(h.name, sink);
  }
  if (!merged) return text;
  const out: string[] = [];
  for (const s of sections) {
    if (s.header !== null) out.push(s.header);
    out.push(...s.body);
  }
  return out.join("\n");
}

const REDEFINED_TABLE = /Cannot redefine table/;

/**
 * `Bun.TOML.parse`, except that a table defined twice is read as Bun 1.3 read it
 * (its keys merged; a key set twice is still an error). Any other error is the parser's own.
 */
export function parseTomlText(text: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (!REDEFINED_TABLE.test((error as Error).message)) throw error;
    const merged = mergeDuplicateTables(text);
    if (merged === text) throw error;
    return Bun.TOML.parse(merged) as Record<string, unknown>;
  }
}
