/**
 * Remove secrets from text captured off a worker's screen before it is stored
 * or shown (cutover C2). Errs toward removing: a false positive costs a word
 * in a P1 line; a miss leaks a credential into the database and notifications.
 */

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_PAIRED = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * A PEM block, whole when both BEGIN and END are present. A lone BEGIN (the
 * END fell off a tailed screen capture) redacts from BEGIN to the end of the
 * text; a lone END (the BEGIN scrolled off) redacts from the start to END.
 */
function redactPem(text: string): string {
  let out = text.replace(PEM_PAIRED, "[redacted]");
  const begin = out.search(PEM_BEGIN);
  if (begin !== -1) return `${out.slice(0, begin)}[redacted]`;
  const end = out.match(PEM_END);
  if (end && end.index !== undefined) return `[redacted]${out.slice(end.index + end[0].length)}`;
  return out;
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

/** `scheme://user:pass@host` -> `scheme://[redacted]@host`. */
const URL_USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;

/** `--password hunter2` / `--api-key=abc`: keep the flag, redact its value. */
const FLAG = /(--(?:password|passwd|secret|token|api[_-]?key)[\w-]*)(=|\s+)\S+/gi;

/**
 * A labeled secret's value can be several words (a passphrase), so this
 * over-redacts to the end of the line rather than stopping at the first
 * word: a miss leaks a credential, a few extra redacted words do not. The
 * lazy prefix and optional suffix/quote catch a label embedded in a longer
 * identifier (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) or quoted as a JSON
 * key (`"password":`), neither of which sits on a word boundary right
 * before the label itself.
 */
const ASSIGNED = /\b([\w-]*?)(password|passwd|secret|token|api[_-]?key)([\w-]*["']?)(\s*[:=]\s*)([^\n]*)/gi;

export function redactSecrets(text: string): string {
  let out = redactPem(text);
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(BEARER, "$1 [redacted]");
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = out.replace(FLAG, "$1$2[redacted]");
  out = out.replace(ASSIGNED, (_m, prefix: string, name: string, suffix: string, sep: string, value: string) =>
    value.trim() === "[redacted]" ? `${prefix}${name}${suffix}${sep}${value}` : `${prefix}${name}${suffix}${sep}[redacted]`,
  );
  return out;
}
