import { describe, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import pkg from "../../package.json";
import { isUlid, ulid } from "../../src/util/ulid.ts";
import { sanitizeBlock, sanitizeLine } from "../../src/util/sanitize.ts";
import { KeyedMutex } from "../../src/journal/file-locks.ts";
import { parseDueArg, isValidIsoDate } from "../../src/lifecycle/dates.ts";
import { dueOf, withDue } from "../../src/lifecycle/todos.ts";
import { mintTaskId, slugify } from "../../src/lifecycle/ids.ts";
import { renderReply, exitCodeOf } from "../../src/cli/render.ts";
import { EXIT, ERROR_CODES, exitCodeFor } from "../../src/api/errors.ts";
import { errorReply, okReply } from "../../src/api/envelope.ts";
import { VERSION } from "../../src/version.ts";

describe("ulid", () => {
  test("is 26 Crockford characters and sorts by creation", () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    for (const id of ids) expect(isUlid(id)).toBe(true);
    expect(ids.toSorted()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("stays monotonic within one millisecond and across a clock step back", () => {
    const a = ulid(1_000_000);
    const b = ulid(1_000_000);
    const c = ulid(999_999);
    expect(a < b && b < c).toBe(true);
  });

  test("rejects non-ULIDs", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false); // I is not Crockford
  });
});

describe("sanitize", () => {
  test("strips ANSI and control characters and truncates to 200", () => {
    expect(sanitizeLine("\u001b[31mred\u001b[0m\u0007 text\nnext")).toBe("red text next");
    const long = sanitizeLine("x".repeat(500));
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });

  test("keeps newlines in blocks", () => {
    expect(sanitizeBlock("a\u001b[1mb\u0000\nc\td")).toBe("ab\nc\td");
  });
});

describe("KeyedMutex", () => {
  test("serializes work per key and not across keys", async () => {
    const mutex = new KeyedMutex<string>();
    const order: string[] = [];
    const slow = mutex.run("a", async () => {
      order.push("a1-start");
      await Bun.sleep(30);
      order.push("a1-end");
    });
    const second = mutex.run("a", async () => {
      order.push("a2");
    });
    const other = mutex.run("b", async () => {
      order.push("b");
    });
    await Promise.all([slow, second, other]);
    expect(order.indexOf("a2")).toBeGreaterThan(order.indexOf("a1-end"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a1-end"));
  });

  test("releases the key when the work throws", async () => {
    const mutex = new KeyedMutex<string>();
    await expect(mutex.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await mutex.run("k", async () => 7)).toBe(7);
    expect(mutex.isHeld("k")).toBe(false);
  });
});

describe("to-do dates", () => {
  const now = new Date(2026, 8, 23, 10, 0); // 2026-09-23 local

  test("parses today, tomorrow, +Nd and ISO dates", () => {
    expect(parseDueArg("today", now)).toBe("2026-09-23");
    expect(parseDueArg("tomorrow", now)).toBe("2026-09-24");
    expect(parseDueArg("+10d", now)).toBe("2026-10-03");
    expect(parseDueArg("2026-12-31", now)).toBe("2026-12-31");
    expect(parseDueArg("2026-02-30", now)).toBeNull();
    expect(parseDueArg("next week", now)).toBeNull();
    expect(isValidIsoDate("2028-02-29")).toBe(true);
  });

  test("the due date is the body's first line", () => {
    expect(dueOf("due: 2026-09-20\nnotes")).toBe("2026-09-20");
    expect(dueOf("notes\ndue: 2026-09-20")).toBeNull();
    expect(dueOf("due: none")).toBeNull();
    expect(withDue("notes", "2026-10-01")).toBe("due: 2026-10-01\nnotes");
    expect(withDue("due: 2026-10-01\nnotes", "2026-11-01")).toBe("due: 2026-11-01\nnotes");
    expect(withDue("due: 2026-10-01\nnotes", null)).toBe("notes");
    // tasks-axi cannot store an empty body, so a cleared date with no notes reads `due: none`.
    expect(withDue("due: 2026-10-01", null)).toBe("due: none");
    expect(dueOf(withDue("due: 2026-10-01", null))).toBeNull();
  });
});

describe("ids", () => {
  test("mints tasks-axi style ids and avoids taken ones", () => {
    expect(slugify("Renew the Passport, please!")).toBe("renew-the-passport");
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = mintTaskId("call bank", (c) => taken.has(c));
      expect(id).toMatch(/^call-bank-[a-z2-9]{2}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});

describe("output", () => {
  test("TOON output is valid TOON with at most two hints", () => {
    const text = renderReply(okReply({ todo: "a-b", rows: [{ id: "x", title: "a, b" }] }, ["flowryn todo list", 'flowryn todo add "<t>"', "dropped"]), { json: false });
    const parsed = decode(text) as Record<string, unknown>;
    expect(parsed.todo).toBe("a-b");
    expect(parsed.help).toEqual(["flowryn todo list", 'flowryn todo add "<t>"']);
    expect((parsed.rows as { title: string }[])[0]!.title).toBe("a, b");
  });

  test("errors print error, code and help", () => {
    const text = renderReply(errorReply({ code: "approval_required", message: "merge refused", help: "flowryn approve x" }), { json: false });
    expect(decode(text)).toEqual({ error: "merge refused", code: "approval_required", help: "flowryn approve x" });
  });

  test("--json prints the reply object, with the banner when read-only", () => {
    const text = renderReply(okReply({ a: 1 }), { json: true, banner: "daemon down" });
    expect(JSON.parse(text)).toEqual({ ok: true, data: { a: 1 }, banner: "daemon down" });
  });

  test("every error code maps to one of the section 12 exit codes", () => {
    const allowed = new Set<number>(Object.values(EXIT));
    for (const code of Object.keys(ERROR_CODES)) expect(allowed.has(exitCodeFor(code))).toBe(true);
    expect(exitCodeFor("approval_required")).toBe(2);
    expect(exitCodeFor("bad_args")).toBe(3);
    expect(exitCodeFor("not_found")).toBe(4);
    expect(exitCodeFor("daemon_unavailable")).toBe(69);
    expect(exitCodeFor("protocol_mismatch")).toBe(76);
    expect(exitCodeFor("not_leader")).toBe(77);
    expect(exitCodeFor("worker_token")).toBe(77);
    expect(exitCodeFor("human_only")).toBe(77);
    expect(exitCodeFor("never-heard-of-it")).toBe(1);
    expect(exitCodeOf(okReply({}))).toBe(0);
  });
});

test("VERSION matches package.json", () => {
  expect(VERSION).toBe(pkg.version);
});
