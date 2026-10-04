/**
 * Remove secrets from text captured off a worker's screen before it is stored
 * or shown (cutover C2). Errs toward removing: a false positive costs a word
 * in a P1 line; a miss leaks a credential into the database and notifications.
 *
 * Every pattern below matches at most once per run of identifier-ish
 * characters, anchored with a negative lookbehind instead of `\b`: `\b`
 * re-triggers inside a hyphenated or dotted run, and combined with a
 * variable-length prefix, suffix or value capture that can fail to find its
 * required separator, that is what made earlier drafts of this file
 * quadratic on adversarial input such as `"a-token-".repeat(n)`. This runs
 * synchronously inside the daemon's hook transaction, so it must stay linear
 * in the input length regardless of what the screen contains.
 */

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;

type Span = { start: number; end: number };

function findFrom(pattern: RegExp, text: string, from: number): Span | null {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * A private key block (PEM, or an armored `PGP PRIVATE KEY BLOCK`), whole
 * when both BEGIN and END are present. A lone BEGIN (the END fell off a
 * tailed screen capture) redacts from BEGIN to the end of the text; a lone
 * END (the BEGIN scrolled off) redacts from the start to END. A lone END
 * followed later by an unrelated lone BEGIN (two different keys, both cut, in
 * either order) must not leak either body.
 *
 * One forward scan pairing each BEGIN with the next END, remembering the
 * next match of each marker so no stretch of text is searched more than a
 * constant number of times: a lazy `BEGIN[\s\S]*?END` regex is quadratic on
 * repeated BEGIN markers with no END.
 */
function redactPem(text: string): string {
  let out = "";
  let pos = 0;
  let nextBegin: Span | null | undefined;
  let nextEnd: Span | null | undefined;
  while (pos < text.length) {
    if (nextBegin === undefined || (nextBegin && nextBegin.start < pos)) nextBegin = findFrom(PEM_BEGIN, text, pos);
    if (nextEnd === undefined || (nextEnd && nextEnd.start < pos)) nextEnd = findFrom(PEM_END, text, pos);
    if (nextEnd && (!nextBegin || nextEnd.start < nextBegin.start)) {
      out = "[redacted]";
      pos = nextEnd.end;
      continue;
    }
    if (!nextBegin) break;
    out += `${text.slice(pos, nextBegin.start)}[redacted]`;
    if (nextEnd && nextEnd.start < nextBegin.end) nextEnd = findFrom(PEM_END, text, nextBegin.end);
    if (!nextEnd) return out;
    pos = nextEnd.end;
  }
  return out + text.slice(pos);
}

const PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

const BEARER = /\b(Bearer)\s+\S+/gi;

/**
 * `scheme://user:pass@host` -> `scheme://[redacted]@host`. The scheme is
 * matched once per run of scheme-ish characters (letters, digits, `+`, `.`,
 * `-`): the lookbehind keeps a long dotted/hyphenated blob with no `://`
 * anywhere in it from being retried at every character inside the blob.
 * The userinfo itself (`[^/\s@]+@`) is bounded by the next `/`, whitespace
 * or `@`, so (unlike the label-dependent patterns below) it is always
 * redacted outright with no same-line swallow risk.
 */
const URL_USERINFO = /(?<![\w+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+@/g;

const LABEL = /password|passwd|secret|token|api[_-]?key/i;

/**
 * `--password hunter2` / `--api-key=abc`: keep the flag, redact its value to
 * the end of the line, like a labeled assignment below, since a passphrase
 * can run several words. `FLAG_NAME` matches only the flag's name and
 * separator, not its value: matching the value only after confirming the
 * name is labeled means an unlabeled flag (`--verbose --token hunter2`) can't
 * swallow a labeled one that follows it on the same line into its own
 * unredacted "value". The separator never crosses a newline, and the value
 * is read with a sticky regex from right after it, so nothing past the line
 * is redacted and no copy of the rest of the text is made per flag.
 */
const FLAG_NAME = /(?<![\w-])(--[\w-]+)(=|[ \t]+)/g;
const REST_OF_LINE = /[^\n]*/y;

function redactFlags(text: string): string {
  FLAG_NAME.lastIndex = 0;
  let result = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = FLAG_NAME.exec(text))) {
    const name = match[1]!;
    const afterSep = match.index + match[0].length;
    if (!LABEL.test(name)) continue;
    REST_OF_LINE.lastIndex = afterSep;
    const value = REST_OF_LINE.exec(text)![0];
    if (value.trim() === "") continue;
    const lineEnd = afterSep + value.length;
    result += `${text.slice(last, afterSep)}[redacted]`;
    last = lineEnd;
    FLAG_NAME.lastIndex = lineEnd;
  }
  return result + text.slice(last);
}

/**
 * A labeled secret's value can be several words (a passphrase), so this
 * over-redacts to the end of the line rather than stopping at the first
 * word: a miss leaks a credential, a few extra redacted words do not.
 *
 * `IDENTIFIER_SEP` matches only the identifier and its separator, not the
 * value, for the same same-line-swallow reason as `redactFlags` above: the
 * value (to end of line) is only consumed once `LABEL.test` confirms the
 * identifier is a label, so `status: token=abc` doesn't let "status" eat
 * "token=abc" into an unredacted, unlabeled "value". Testing the whole
 * captured identifier against `LABEL` (rather than requiring a label
 * literally inside the pattern) is what catches a label embedded in a
 * longer name (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) without a second
 * variable-length prefix/suffix capture around it. An optional quote before
 * the separator catches a JSON-quoted key (`"password":`).
 */
const IDENTIFIER_SEP = /(?<![\w-])([\w-]+)(["']?)(\s*[:=]\s*)/g;

function redactAssigned(text: string): string {
  IDENTIFIER_SEP.lastIndex = 0;
  let result = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_SEP.exec(text))) {
    const full = match[0];
    const name = match[1]!;
    const afterSep = match.index + full.length;
    if (!LABEL.test(name)) continue;
    const nl = text.indexOf("\n", afterSep);
    const lineEnd = nl === -1 ? text.length : nl;
    const value = text.slice(afterSep, lineEnd);
    result += text.slice(last, afterSep) + (value.trim() === "[redacted]" ? value : "[redacted]");
    last = lineEnd;
    IDENTIFIER_SEP.lastIndex = lineEnd;
  }
  return result + text.slice(last);
}

export function redactSecrets(text: string): string {
  let out = redactPem(text);
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(BEARER, "$1 [redacted]");
  out = out.replace(URL_USERINFO, (match) => `${match.slice(0, match.indexOf("://") + 3)}[redacted]@`);
  out = redactFlags(out);
  out = redactAssigned(out);
  return out;
}
