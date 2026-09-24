import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => bytes[i]! % 32);
}

function incrementRandom(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ULID random component overflowed within one millisecond");
}

/** A monotonic ULID: sortable by creation time, strictly increasing within one process. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => CROCKFORD[d]).join("");
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_PATTERN.test(value);
}
