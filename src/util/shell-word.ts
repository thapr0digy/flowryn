/**
 * Shell words, strictly: enough to read one flag's value out of a command
 * line exactly as the shell will pass it, and to write a value back so the
 * shell passes it unchanged. Anything the reader cannot be sure of (an
 * expansion, a glob, an escape outside double quotes, an unclosed quote) is
 * marked inexact rather than guessed at.
 */

/** Characters a bare word may hold and mean only themselves (in bash and zsh; a leading `=` is zsh's command expansion). */
const BARE = /[A-Za-z0-9._:/@+=,%-]/;
const BLANK = /[ \t]/;
/** Unquoted characters that end a simple command. */
const END = /[;&|\n()]/;
/** After a backslash inside double quotes, these stand for themselves. */
const DQ_ESCAPABLE = /["\\$`]/;

export interface ShellWord {
  /** The word after quote removal. */
  text: string;
  /** True only when the shell is certain to pass exactly `text`. */
  exact: boolean;
}

/** The words of the simple command starting at `from`, up to the first unquoted `; & | ( )` or newline. */
export function readShellWords(line: string, from = 0): ShellWord[] {
  const words: ShellWord[] = [];
  let i = from;
  let text = "";
  let exact = true;
  let inWord = false;
  const finish = () => {
    if (inWord) words.push({ text, exact });
    text = "";
    exact = true;
    inWord = false;
  };
  while (i < line.length) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === "\n") {
      // A line continuation is a blank between words.
      finish();
      i += 2;
      continue;
    }
    if (END.test(c)) break;
    if (BLANK.test(c)) {
      finish();
      i++;
      continue;
    }
    if (!inWord && c === "=") exact = false;
    inWord = true;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) {
        exact = false;
        text += line.slice(i + 1);
        i = line.length;
        break;
      }
      text += line.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < line.length) {
        const d = line[i]!;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\") {
          const next = line[i + 1];
          if (next !== undefined && DQ_ESCAPABLE.test(next)) {
            text += next;
            i += 2;
            continue;
          }
          exact = false;
          // Expansions are inexact; `!` is not one here, since history expansion is off in a
          // non-interactive shell, which is how Claude's Bash tool runs.
        } else if (d === "$" || d === "`") {
          exact = false;
        }
        text += d;
        i++;
      }
      if (!closed) {
        exact = false;
        break;
      }
      continue;
    }
    if (!BARE.test(c)) exact = false;
    text += c;
    i++;
  }
  finish();
  return words;
}

/**
 * `text` as one shell word that `readShellWords` reads back exactly: bare
 * when that is safe, else single-quoted, or double-quoted (backslash, double
 * quote, dollar and backtick escaped) when it holds a single quote.
 */
export function shellWord(text: string): string {
  if (text.length > 0 && !text.startsWith("-") && !text.startsWith("=") && [...text].every((c) => BARE.test(c))) return text;
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/["\\$`]/g, (c) => `\\${c}`)}"`;
}
