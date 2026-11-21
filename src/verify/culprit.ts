import { dirname } from "node:path";

/**
 * The likely culprit of a red landing batch (docs/notes/2026-11-21-landing-batches-one-27.md):
 * the paths and packages a failing step's log names, matched against what each branch in the
 * batch changed. Plain code, a hint for the leader (and a fix worker), never an automatic drop.
 */

export interface BatchMember {
  task: string;
  /** The files the branch changed against main, repository-relative. */
  files: readonly string[];
}

export interface Culprit {
  /** The one branch that matches best, or null on a tie or no match. */
  task: string | null;
  why: string;
}

/** How much of a log is read, and how many names taken from it: the tail is bounded already, this bounds the work. */
const MAX_TAIL_CHARS = 16_384;
const MAX_NAMES = 200;

const FILE_AT_LINE = /([\w./-]{1,200}\.[A-Za-z0-9]{1,8}):\d{1,7}/g;
const GO_FAIL = /^FAIL\s+(\S{1,200})/;
const TEST_FILE = /^\s*(\S{1,200}\.(?:test|spec)\.[cm]?[jt]sx?):?\s*$/;

/** The file paths and package paths a log names, in order, each once. */
export function namesInLog(tail: string): string[] {
  const names = new Set<string>();
  const text = tail.length > MAX_TAIL_CHARS ? tail.slice(-MAX_TAIL_CHARS) : tail;
  for (const line of text.split("\n")) {
    if (names.size >= MAX_NAMES) break;
    const go = GO_FAIL.exec(line);
    if (go) names.add(go[1]!);
    const test = TEST_FILE.exec(line);
    if (test) names.add(test[1]!);
    for (const match of line.matchAll(FILE_AT_LINE)) names.add(match[1]!.replace(/^\.\//, ""));
  }
  return [...names].slice(0, MAX_NAMES);
}

/** Whether a changed file's directory is the named path's directory, or the package a Go import path ends in. */
function sameDir(file: string, name: string): boolean {
  const dir = dirname(file);
  if (dir === ".") return false;
  const nameDir = /\.[A-Za-z0-9]{1,8}$/.test(name) ? dirname(name) : name;
  return nameDir === dir || nameDir.endsWith(`/${dir}`) || dir.endsWith(`/${nameDir}`);
}

/**
 * Score each member: an exact changed file named in the log counts 3, a changed file in a
 * directory or package the log names counts 1. One member strictly ahead is the likely one.
 */
export function likelyCulprit(tail: string, members: readonly BatchMember[]): Culprit {
  const names = namesInLog(tail);
  if (names.length === 0) return { task: null, why: `the log names no file or package; branches: ${members.map((m) => m.task).join(", ")}` };
  const scored = members.map((m) => {
    const exact = m.files.filter((f) => names.some((n) => n === f || n.endsWith(`/${f}`)));
    const near = m.files.filter((f) => !exact.includes(f) && names.some((n) => sameDir(f, n)));
    return { task: m.task, score: exact.length * 3 + near.length, exact, near };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  if (best === 0) return { task: null, why: `no branch changed what the log names (${names.slice(0, 3).join(", ")}); branches: ${members.map((m) => m.task).join(", ")}` };
  if (top.length > 1) return { task: null, why: `no single likely branch: ${top.map((s) => s.task).join(", ")} all change what the log names` };
  const winner = top[0]!;
  const what = winner.exact.length > 0 ? `changes ${winner.exact.slice(0, 2).join(", ")}, named in the log` : `changes ${dirname(winner.near[0]!)}, a package the log names`;
  const others = scored.filter((s) => s.task !== winner.task);
  return { task: winner.task, why: `${what}${others.length > 0 ? `; ${others.map((s) => `${s.task}: ${s.score === 0 ? "no overlap" : "less overlap"}`).join(", ")}` : ""}` };
}

/** A file added in a migrations directory whose name starts with a number: `db/migrations/000123_add_x.up.sql`. */
const MIGRATION = /^(.*migration[^/]*\/(?:.*\/)?)(\d+)[_-][^/]*$/i;

export interface NumberClash {
  /** The member that takes the number second, in batch order: it renumbers. */
  task: string;
  path: string;
  /** The member ahead of it with the same number in the same directory. */
  with: string;
  withPath: string;
}

/**
 * Two members that both add a numbered file in the same migrations directory with the same
 * number: a clean merge, and a failing verify. `added` is in batch order; the later one clashes.
 * Narrow on purpose: only a directory whose path says "migration", so date-prefixed notes never clash.
 */
export function numberClashes(added: readonly { task: string; files: readonly string[] }[]): NumberClash[] {
  const taken = new Map<string, { task: string; path: string }>();
  const clashes: NumberClash[] = [];
  for (const member of added) {
    const mine = new Map<string, string>();
    for (const path of member.files) {
      const m = MIGRATION.exec(path);
      if (!m) continue;
      const key = `${m[1]}\u0000${Number(m[2])}`;
      const other = taken.get(key);
      if (other && other.task !== member.task) {
        clashes.push({ task: member.task, path, with: other.task, withPath: other.path });
        break;
      }
      if (!mine.has(key)) mine.set(key, path);
    }
    if (clashes.at(-1)?.task === member.task) continue;
    for (const [key, path] of mine) taken.set(key, { task: member.task, path });
  }
  return clashes;
}
