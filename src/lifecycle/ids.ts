import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const MAX_SLUG = 24;

export function slugify(text: string, maxWords = 3): string {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0)
    .slice(0, maxWords);
  const slug = words.join("-").slice(0, MAX_SLUG).replace(/-+$/, "");
  return slug.length > 0 ? slug : "item";
}

/**
 * Mint a tasks-axi id in its house style: a slug of the title plus a
 * two-character suffix, like `renew-passport-k3`. flowrynd mints ids itself so
 * that a replayed `add` names the same task (design section 8).
 */
export function mintTaskId(title: string, taken: (id: string) => boolean): string {
  const slug = slugify(title);
  for (let attempt = 0; attempt < 200; attempt++) {
    const suffix = ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]!;
    const id = `${slug}-${suffix}`;
    if (!taken(id)) return id;
  }
  throw new Error(`could not mint a free id for "${title}"`);
}
