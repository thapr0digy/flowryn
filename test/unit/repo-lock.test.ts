import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepoLock } from "../../src/runtime/repo-lock.ts";

/** The per-repository worktree lock (docs/notes/2026-10-24-flaky-test-draining-v9.md). */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repos(): { a: string; b: string; aLink: string } {
  const dir = mkdtempSync(join(tmpdir(), "fl-rl-"));
  dirs.push(dir);
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  const aLink = join(dir, "a-link");
  symlinkSync(a, aLink);
  return { a, b, aLink };
}

/** A holder that records when it starts and ends, and ends when told. */
function holder(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const work = async () => {
    log.push(`${name} start`);
    await done;
    log.push(`${name} end`);
    return name;
  };
  return { work, finish };
}

describe("withRepoLock", () => {
  test("holders of one repository take turns in arrival order, by any path to it; another repository runs alongside", async () => {
    const { a, b, aLink } = repos();
    const log: string[] = [];
    const first = holder(log, "a1");
    const second = holder(log, "a2");
    const other = holder(log, "b1");
    const p1 = withRepoLock(a, first.work);
    const p2 = withRepoLock(aLink, second.work);
    const p3 = withRepoLock(b, other.work);
    await Bun.sleep(10);
    expect(log).toEqual(["a1 start", "b1 start"]);
    second.finish();
    other.finish();
    await p3;
    await Bun.sleep(10);
    expect(log).toEqual(["a1 start", "b1 start", "b1 end"]);
    first.finish();
    expect(await Promise.all([p1, p2])).toEqual(["a1", "a2"]);
    expect(log).toEqual(["a1 start", "b1 start", "b1 end", "a1 end", "a2 start", "a2 end"]);
  });

  test("a holder that throws passes its error on and still lets the next one in", async () => {
    const { a } = repos();
    const failed = withRepoLock(a, async () => {
      throw new Error("git worktree add failed");
    });
    const next = withRepoLock(a, async () => "next");
    await expect(failed).rejects.toThrow("git worktree add failed");
    expect(await next).toBe("next");
  });

  test("a repository path that does not exist yet is still a key", async () => {
    const { a } = repos();
    expect(await withRepoLock(join(a, "missing"), async () => 1)).toBe(1);
  });
});
