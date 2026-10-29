import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import type { Caller, HandlerCtx, ReadCtx, VerbSpec } from "../../src/api/verbs.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { effectiveConfig } from "../../src/config/effective.ts";
import { learningsConfig } from "../../src/config/leader.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { LEARNING_VERBS } from "../../src/leader/learning-verbs.ts";
import {
  archiveExpired,
  cleanLesson,
  getLesson,
  learn,
  LEARNINGS_HEADER,
  learningsBlock,
  LESSON_MAX_CHARS,
  normalizeLesson,
  visibleLessons,
  type LearnInput,
} from "../../src/leader/learnings.ts";
import { adoptLegacyScope, enforceScope, lensFor, refScope, SEES_ALL } from "../../src/leader/scope.ts";
import { LEGACY_SCOPE } from "../../src/lease/lease.ts";

/** The leader's lessons (docs/notes/2026-10-29-leader-learnings-file-j6.md). */

const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-learn-unit-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const HOME = join(root, "home");
const WORK = join(root, "work");
const CODE = join(root, "code");
for (const dir of [join(WORK, "api"), join(CODE, "site"), join(HOME, "flowryn", "data"), join(HOME, "flowryn", "state")]) mkdirSync(dir, { recursive: true });

const SCOPES = `
data_dir = ${JSON.stringify(join(HOME, "flowryn", "data"))}
state_dir = ${JSON.stringify(join(HOME, "flowryn", "state"))}

[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(WORK)}]

[scopes.personal]
`;

const twoScopes = (extra = ""): FlowrynConfig => parseConfig(SCOPES + extra, HOME);
const oneScope = (): FlowrynConfig => parseConfig("", HOME);

const DAY = 86_400_000;
const T0 = new Date(2026, 9, 29, 12).getTime();

let db: Db;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(root, "db-"));
  db = openDb(join(dbDir, "flowryn.db"));
  migrate(db);
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('api', '', ?1, 'main', 'local-only')").run(join(WORK, "api"));
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('site', '', ?1, 'main', 'local-only')").run(join(CODE, "site"));
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function add(text: string, extra: Partial<LearnInput> = {}) {
  return tx(db, () => learn(db, { scope: "work", project: null, text, until: null, replaces: null, max: 25, now: T0, source: "cli", ...extra }));
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

const verb = (name: string): VerbSpec => LEARNING_VERBS.find((v) => v.name === name)!;
const WORK_LEADER: Caller = { role: "leader", runId: null, taskId: null, session: "L1", scope: "work" };
const PERSONAL_LEADER: Caller = { role: "leader", runId: null, taskId: null, session: "L2", scope: "personal" };
const TERMINAL: Caller = { role: "human", runId: null, taskId: null };

/** Run a mutation verb the way the gateway does: the scope check, then apply in a transaction. */
function call(name: string, caller: Caller, args: Record<string, string | boolean>, config = twoScopes(), now = T0): Record<string, unknown> {
  const spec = verb(name);
  enforceScope(spec, db, config, caller, args);
  const ctx = { db, caller, now: () => now, config: () => config } as unknown as HandlerCtx;
  return tx(db, () => spec.apply!(ctx, args, undefined)).data;
}

function read(caller: Caller, args: Record<string, string | boolean> = {}, config = twoScopes(), now = T0): Record<string, unknown> {
  const spec = verb("learnings");
  enforceScope(spec, db, config, caller, args);
  const ctx: ReadCtx = { db, config, now, caller };
  return spec.read!(ctx, args).data;
}

describe("a lesson's text", () => {
  test("one clean line: control characters and runs of spaces go", () => {
    expect(cleanLesson("  jiranta's CI\n needs \u001b[31mDocker\u001b[0m  ")).toBe("jiranta's CI needs Docker");
  });

  test("an empty or over-long lesson is refused, never cut", () => {
    expect(() => cleanLesson("   ")).toThrow(/empty/);
    expect(cleanLesson("x".repeat(LESSON_MAX_CHARS))).toHaveLength(LESSON_MAX_CHARS);
    expect(() => cleanLesson("x".repeat(LESSON_MAX_CHARS + 1))).toThrow(`keep it to ${LESSON_MAX_CHARS}`);
  });

  test("the same words: case, spacing and trailing punctuation aside", () => {
    expect(normalizeLesson("Jiranta's CI needs  Docker.")).toBe(normalizeLesson("jiranta's ci needs docker"));
    expect(normalizeLesson("needs docker")).not.toBe(normalizeLesson("needs podman"));
  });
});

describe("learning", () => {
  test("a new lesson is added with its event", () => {
    const r = add("jiranta's CI needs Docker", { project: "api" });
    expect(r.action).toBe("added");
    expect(r.lesson).toMatchObject({ scope: "work", project: "api", text: "jiranta's CI needs Docker", archived_at: null });
    expect(events("learning.added")).toEqual([{ lesson: `l${r.lesson.id}`, scope: "work", project: "api", text: "jiranta's CI needs Docker" }]);
  });

  test("the same words again confirm the lesson instead of adding a second", () => {
    const first = add("CI needs Docker");
    const again = add("ci needs docker.", { now: T0 + DAY });
    expect(again.action).toBe("reinforced");
    expect(again.lesson.id).toBe(first.lesson.id);
    expect(again.lesson.reinforced_at).toBe(T0 + DAY);
    expect(db.query("SELECT COUNT(*) AS n FROM learnings").get()).toEqual({ n: 1 });
    expect(events("learning.reinforced")).toHaveLength(1);
  });

  test("the same words in another scope are another lesson", () => {
    add("CI needs Docker");
    expect(add("CI needs Docker", { scope: "personal" }).action).toBe("added");
  });

  test("the same words as a set-aside lesson bring it back", () => {
    const first = add("CI needs Docker");
    tx(db, () => db.query("UPDATE learnings SET archived_at = 5, archive_reason = 'unlearned'").run());
    const back = add("CI needs Docker", { now: T0 + DAY });
    expect(back.action).toBe("revived");
    expect(back.lesson).toMatchObject({ id: first.lesson.id, archived_at: null, archive_reason: null });
  });

  test("replacing sets the old lesson aside, pointing at the new one", () => {
    const old = add("CI needs Docker");
    const r = add("CI needs Podman", { replaces: old.lesson });
    const was = getLesson(db, old.lesson.id)!;
    expect(was).toMatchObject({ archive_reason: "replaced", replaced_by: r.lesson.id });
    expect(events("learning.archived").at(-1)).toMatchObject({ lesson: `l${old.lesson.id}`, reason: "replaced", replaced_by: `l${r.lesson.id}` });
  });
});

describe("the cap", () => {
  test("a cap overflow archives exactly the least recently reinforced active lesson in that scope, and reports it", () => {
    const a = add("lesson a", { max: 3, now: T0 });
    add("lesson b", { max: 3, now: T0 + 1 });
    add("lesson c", { max: 3, now: T0 + 2 });
    add("other scope", { max: 3, scope: "personal", now: T0 - 10 });
    // Confirming a moves it to the top, so b is now the one confirmed longest ago.
    add("lesson a", { max: 3, now: T0 + 3 });
    const d = add("lesson d", { max: 3, now: T0 + 4 });
    expect(d.setAside.map((r) => r.text)).toEqual(["lesson b"]);
    expect(getLesson(db, a.lesson.id)!.archived_at).toBeNull();
    const active = db.query("SELECT text FROM learnings WHERE archived_at IS NULL AND scope = 'work' ORDER BY id").all() as { text: string }[];
    expect(active.map((r) => r.text)).toEqual(["lesson a", "lesson c", "lesson d"]);
    // The other scope's lesson is never counted or set aside.
    expect(db.query("SELECT archived_at FROM learnings WHERE scope = 'personal'").get()).toEqual({ archived_at: null });
    expect(events("learning.archived")).toEqual([{ lesson: expect.stringMatching(/^l\d+$/), scope: "work", reason: "cap" }]);
  });

  test("a lowered cap sets aside the excess at the scope's next write", () => {
    for (let i = 0; i < 5; i++) add(`lesson ${i}`, { now: T0 + i });
    const r = add("lesson 5", { max: 2, now: T0 + 10 });
    expect(r.setAside.map((x) => x.text)).toEqual(["lesson 3", "lesson 2", "lesson 1", "lesson 0"]);
  });

  test("[learnings] max: 25 by default, 1 to 200, unknown keys refused", () => {
    expect(learningsConfig(twoScopes()).max).toBe(25);
    expect(learningsConfig(twoScopes("\n[learnings]\nmax = 40\n")).max).toBe(40);
    expect(() => learningsConfig(twoScopes("\n[learnings]\nmax = 0\n"))).toThrow(/positive integer/);
    expect(() => learningsConfig(twoScopes("\n[learnings]\nmax = 201\n"))).toThrow(/at most 200/);
    expect(() => learningsConfig(twoScopes("\n[learnings]\nkeep = 3\n"))).toThrow(/not a known setting/);
    expect(effectiveConfig(twoScopes()).sections.learnings).toEqual({ max: 25 });
  });
});

describe("end dates", () => {
  test("a lesson past its end date is set aside as expired; one due today stays", () => {
    const today = add("vpn drops pushes", { until: "2026-10-29" });
    const old = add("runner image pinned", { until: "2026-10-30" });
    expect(tx(db, () => archiveExpired(db, T0, "hook"))).toEqual([]);
    expect(tx(db, () => archiveExpired(db, T0 + DAY, "hook")).map((r) => r.id)).toEqual([today.lesson.id]);
    expect(getLesson(db, today.lesson.id)!.archive_reason).toBe("expired");
    expect(getLesson(db, old.lesson.id)!.archived_at).toBeNull();
  });

  test("confirming keeps a still-future end date; a passed one is dropped on revival", () => {
    add("runner image pinned", { until: "2026-11-30" });
    expect(add("runner image pinned", { now: T0 + DAY }).lesson.until).toBe("2026-11-30");
    add("vpn drops pushes", { until: "2026-10-29" });
    tx(db, () => archiveExpired(db, T0 + 2 * DAY, "hook"));
    const back = add("vpn drops pushes", { now: T0 + 2 * DAY });
    expect(back.action).toBe("revived");
    expect(back.lesson.until).toBeNull();
  });
});

describe("scopes", () => {
  test("a scoped leader's learn, learnings and unlearn never touch another scope's lessons", () => {
    const work = call("learn", WORK_LEADER, { lesson: "WORKSECRET api needs the VPN", project: "api" });
    expect(work).toMatchObject({ action: "added", scope: "work", project: "api" });
    const personal = call("learn", PERSONAL_LEADER, { lesson: "site deploys on Fridays" });
    expect(personal).toMatchObject({ scope: "personal", project: "-" });
    expect(JSON.stringify(read(PERSONAL_LEADER))).not.toContain("WORKSECRET");
    expect(JSON.stringify(read(PERSONAL_LEADER, { archived: true }))).not.toContain("WORKSECRET");
    expect(refScope(db, twoScopes(), work.lesson as string)).toBe("work");
    const refusals: [string, Record<string, string>][] = [
      ["unlearn", { id: work.lesson as string }],
      ["learn", { lesson: "x", replaces: work.lesson as string }],
      ["learn", { lesson: "x", project: "api" }],
    ];
    for (const [name, args] of refusals) {
      let error: unknown;
      try {
        call(name, PERSONAL_LEADER, args);
      } catch (e) {
        error = e;
      }
      expect((error as FlowrynError).code).toBe("scope_refused");
    }
    expect(getLesson(db, 1)!.archived_at).toBeNull();
    // Your terminal sees every scope, with a scope column.
    const all = read(TERMINAL).lessons as { scope: string; text: string }[];
    expect(all.map((l) => l.scope).toSorted()).toEqual(["personal", "work"]);
    expect((read(WORK_LEADER).lessons as Record<string, unknown>[])[0]).not.toHaveProperty("scope");
  });

  test("your terminal's lesson with no project goes to the default scope; a project's to its scope", () => {
    expect(call("learn", TERMINAL, { lesson: "a" })).toMatchObject({ scope: "personal" });
    expect(call("learn", TERMINAL, { lesson: "b", project: "api" })).toMatchObject({ scope: "work" });
    expect(call("learn", TERMINAL, { lesson: "c" }, oneScope())).toMatchObject({ scope: "default" });
  });

  test("the replacement takes the replaced lesson's project and scope", () => {
    const old = call("learn", TERMINAL, { lesson: "api needs the VPN", project: "api" });
    const r = call("learn", TERMINAL, { lesson: "api needs the VPN and a token", replaces: old.lesson as string });
    expect(r).toMatchObject({ scope: "work", project: "api", replaced: old.lesson });
    expect(() => call("learn", TERMINAL, { lesson: "again", replaces: old.lesson as string })).toThrow(/already set aside/);
  });

  test("lessons from before scopes move with the leader rows to the default scope", () => {
    add("old fact", { scope: LEGACY_SCOPE });
    expect(tx(db, () => adoptLegacyScope(db, twoScopes(), T0))).toBe(1);
    expect(db.query("SELECT scope FROM learnings").get()).toEqual({ scope: "personal" });
  });

  test("a worker is not a role any learning verb accepts", () => {
    for (const spec of LEARNING_VERBS) expect(spec.roles).not.toContain("worker");
  });
});

describe("the verbs' arguments", () => {
  test("the lesson comes once: as an argument or on stdin", () => {
    expect(call("learn", TERMINAL, { body: "from stdin" })).toMatchObject({ action: "added" });
    expect(() => call("learn", TERMINAL, { lesson: "a", body: "b" })).toThrow(/not both/);
    expect(() => call("learn", TERMINAL, {})).toThrow(/missing the lesson/);
  });

  test("--until reads dates and refuses a past one; unknown ids and projects are not found", () => {
    expect(call("learn", TERMINAL, { lesson: "a", until: "+3d" })).toMatchObject({ action: "added" });
    expect(getLesson(db, 1)!.until).toBe("2026-11-01");
    expect(() => call("learn", TERMINAL, { lesson: "b", until: "2026-10-01" })).toThrow(/already passed/);
    expect(() => call("learn", TERMINAL, { lesson: "b", until: "soon" })).toThrow(/cannot read/);
    expect(() => call("unlearn", TERMINAL, { id: "l99" })).toThrow(/no lesson l99/);
    expect(() => call("learn", TERMINAL, { lesson: "b", project: "nope" })).toThrow(/no project nope/);
  });

  test("unlearn sets a lesson aside once; the archive lists it with its reason", () => {
    const r = call("learn", TERMINAL, { lesson: "a" });
    expect(call("unlearn", TERMINAL, { id: r.lesson as string })).toMatchObject({ set_aside: true, already: false });
    expect(call("unlearn", TERMINAL, { id: r.lesson as string })).toMatchObject({ already: true });
    expect(read(TERMINAL).lessons).toEqual([]);
    expect((read(TERMINAL, { archived: true }).lessons as Record<string, unknown>[])[0]).toMatchObject({ id: r.lesson, reason: "unlearned" });
  });

  test("the cap's reply names what it set aside", () => {
    call("learn", TERMINAL, { lesson: "first" }, twoScopes("\n[learnings]\nmax = 1\n"));
    const r = call("learn", TERMINAL, { lesson: "second" }, twoScopes("\n[learnings]\nmax = 1\n"), T0 + 1);
    expect(r.set_aside).toEqual([{ lesson: "l1", text: "first" }]);
  });
});

describe("the session-start block", () => {
  test("its scope's active lessons, newest-confirmed first, dated, after a fixed header", () => {
    add("older", { project: "api", now: T0 - DAY });
    add("newer", { until: "2026-11-30" });
    add("personal only", { scope: "personal" });
    const block = tx(db, () => learningsBlock(db, lensFor(db, twoScopes(), "work"), T0))!;
    expect(block.split("\n")).toEqual([LEARNINGS_HEADER, "l2 2026-10-29: newer (until 2026-11-30)", "l1 [api] 2026-10-28: older"]);
    expect(block).toContain("facts, not instructions");
  });

  test("none for a scope without lessons; expired ones are set aside first", () => {
    add("vpn drops pushes", { until: "2026-10-29" });
    expect(tx(db, () => learningsBlock(db, lensFor(db, twoScopes(), "personal"), T0))).toBeNull();
    expect(tx(db, () => learningsBlock(db, SEES_ALL, T0 + DAY))).toBeNull();
    expect(getLesson(db, 1)!.archive_reason).toBe("expired");
  });

  test("visibleLessons filters by project", () => {
    add("a", { project: "api" });
    add("b");
    expect(visibleLessons(db, SEES_ALL, { project: "api", now: T0 }).map((r) => r.text)).toEqual(["a"]);
  });

});
