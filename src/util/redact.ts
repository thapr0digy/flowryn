/**
 * Remove secrets from text captured off a worker's screen before it is stored
 * or shown (cutover C2). Errs toward removing: a false positive costs a word
 * in a P1 line; a miss leaks a credential into the database and notifications.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];
const BEARER = /\b(Bearer)\s+\S+/gi;
// A labeled secret's value can be several words (a passphrase), so this
// over-redacts to the end of the line rather than stopping at the first
// word: a miss leaks a credential, a few extra redacted words do not.
const ASSIGNED = /\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)([^\n]*)/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(BEARER, "$1 [redacted]");
  out = out.replace(ASSIGNED, (_m, name: string, sep: string, value: string) => (value.trim() === "[redacted]" ? `${name}${sep}${value}` : `${name}${sep}[redacted]`));
  return out;
}
