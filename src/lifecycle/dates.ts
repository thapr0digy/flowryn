const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD in local time; to-do due dates are calendar days, not instants. */
export function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
}

/**
 * Parse a due-date argument: `today`, `tomorrow`, `+Nd` or `YYYY-MM-DD`.
 * Returns null when the text is none of those.
 */
export function parseDueArg(value: string, now: Date): string | null {
  const text = value.trim().toLowerCase();
  if (text === "today") return localDate(now);
  if (text === "tomorrow") return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const relative = /^\+(\d{1,3})d$/.exec(text);
  if (relative) return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(relative[1])));
  return isValidIsoDate(text) ? text : null;
}
