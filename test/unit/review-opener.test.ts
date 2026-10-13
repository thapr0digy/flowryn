import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_REVIEW, openerMode, reviewConfig, type OpenerMode, type ReviewConfig } from "../../src/config/leader.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { STAGE_SKILLS } from "../../src/skills/stages.ts";
import { lavishPresence, recordedPresence, recordOpen, ReviewOpener, type OpenResult, type PresenceResult } from "../../src/lavish/opener.ts";

/**
 * Review pages open in your browser (docs/notes/2026-10-10-review-pages-open-4b.md): the
 * opener's states with an injected `open` and presence, the recorder the test homes use,
 * the [review] config, the migration, and the real presence probe against a stand-in of
 * Lavish's /events WebSocket. No test runs /usr/bin/open (the preload refuses it).
 */

const URL_A = "http://127.0.0.1:4387/session/0123456789abcdef";
const URL_B = "http://127.0.0.1:4387/session/fedcba9876543210";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-opener-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(target: Db, runId = "r1", taskId = "web-a1"): void {
  const now = Date.now();
  tx(target, () => {
    target.query("INSERT OR IGNORE INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://example.test/web.git', '/tmp/web', 'main', 'no-mistakes')").run();
    target.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', 0, 'feature', ?2)").run(taskId, now);
    target
      .query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', '2.1.281', 'running', 'busy', 'feature', 'design', '/tmp/wt', 'fm/x', 'abc123', 'h', ?3, ?3)`,
      )
      .run(runId, taskId, now);
  });
}

/** A review gate as stage done opens it, with its gate_ready item. */
function seedGate(gateId: string, url: string, state = "pending", runId = "r1", title = "Feature"): void {
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at, open_state) VALUES (?1, ?2, 'design', 'review', ?3, 'open', ?4, ?5)").run(gateId, runId, url, now, state);
    const event = appendEvent(db, { source: "cli", kind: "stage.done", runId, taskId: "web-a1", payload: { gate: gateId } });
    openItem(db, { kind: "gate_ready", eventSeq: event.seq, taskId: "web-a1", runId, line: `design ready for review (${gateId}): ${title} (web) ${url}`, now });
  });
}

function closeGate(gateId: string): void {
  tx(db, () => db.query("UPDATE gates SET state = 'changes', closed_at = ?2 WHERE id = ?1").run(gateId, Date.now()));
  tx(db, () => db.query("UPDATE items SET state = 'resolved' WHERE kind = 'gate_ready' AND line LIKE ?1").run(`%(${gateId})%`));
}

function gate(id: string): { open_state: string; open_detail: string | null; open_at: number | null } {
  return db.query("SELECT open_state, open_detail, open_at FROM gates WHERE id = ?1").get(id) as { open_state: string; open_detail: string | null; open_at: number | null };
}

function itemLine(gateId: string): string {
  const rows = db.query("SELECT line, full_line FROM items WHERE kind = 'gate_ready'").all() as { line: string; full_line: string | null }[];
  const row = rows.find((r) => (r.full_line ?? r.line).includes(`(${gateId})`))!;
  return row.full_line ?? row.line;
}

function events(kindPrefix: string): { kind: string; payload: Record<string, unknown> }[] {
  return (db.query("SELECT kind, payload FROM events WHERE kind LIKE ?1 ORDER BY seq").all(`${kindPrefix}%`) as { kind: string; payload: string }[]).map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload) as Record<string, unknown> }));
}

interface Rig {
  opener: ReviewOpener;
  opens: { browser: string; url: string }[];
  probes: string[];
  logs: string[];
}

function rig(options: { review?: Partial<ReviewConfig>; mode?: OpenerMode; open?: OpenResult; presence?: PresenceResult } = {}): Rig {
  const opens: { browser: string; url: string }[] = [];
  const probes: string[] = [];
  const logs: string[] = [];
  const opener = new ReviewOpener({
    db,
    review: () => ({ ...DEFAULT_REVIEW, ...options.review }),
    mode: () => options.mode ?? { kind: "open" },
    log: (m) => logs.push(m),
    now: Date.now,
    open: async (browser, url) => {
      opens.push({ browser, url });
      return options.open ?? { ok: true };
    },
    presence: async (url) => {
      probes.push(url);
      return options.presence ?? { listening: true };
    },
  });
  return { opener, opens, probes, logs };
}

describe("the opener", () => {
  beforeEach(() => seedRun(db));

  test("opens a pending gate once Lavish shows it listening, and says so on the gate, its item and an event", async () => {
    seedGate("g1", URL_A);
    const r = rig();
    r.opener.offer("g1");
    r.opener.offer("g1");
    await r.opener.idle();
    r.opener.offer("g1");
    await r.opener.idle();
    expect(r.probes).toEqual([URL_A]);
    expect(r.opens).toEqual([{ browser: "Google Chrome", url: URL_A }]);
    expect(gate("g1")).toMatchObject({ open_state: "opened", open_detail: "opened in Google Chrome" });
    expect(gate("g1").open_at).toBeNumber();
    expect(itemLine("g1")).toBe(`design ready for review (g1): Feature (web) ${URL_A} · opened in Google Chrome`);
    expect(events("gate.browser").map((e) => e.kind)).toEqual(["gate.browser_opening", "gate.browser_opened"]);
    expect(events("gate.browser_opening")[0]!.payload).toMatchObject({ gate: "g1", url: URL_A, browser: "Google Chrome" });
  });

  test("a failed open shows on the gate and the item with why; it never claims it opened", async () => {
    seedGate("g1", URL_A);
    const r = rig({ review: { browser: "Missing Browser" }, open: { ok: false, why: "open exited 1: Unable to find application named 'Missing Browser'" } });
    r.opener.offer("g1");
    await r.opener.idle();
    expect(r.opens).toEqual([{ browser: "Missing Browser", url: URL_A }]);
    expect(gate("g1")).toMatchObject({ open_state: "failed", open_detail: "open exited 1: Unable to find application named 'Missing Browser'" });
    expect(itemLine("g1")).toBe(`design ready for review (g1): Feature (web) ${URL_A} · NOT opened (open exited 1: Unable to find application named 'Missing Browser'); open it by hand`);
    expect(itemLine("g1")).not.toContain("opened in");
    expect(events("gate.browser").map((e) => e.kind)).toEqual(["gate.browser_opening", "gate.browser_failed"]);
    // Failed is final: a later offer does not try again.
    r.opener.offer("g1");
    await r.opener.idle();
    expect(r.opens).toHaveLength(1);
  });

  test("a long title or URL gives way so the short item line still ends with the result; the full line keeps it all", async () => {
    const title = "Rework the review page flow so the leader can relay every gate's link without opening the board first";
    const longUrl = `${URL_A}?${"x".repeat(60)}`;
    seedGate("g1", longUrl, "pending", "r1", title);
    seedGate("g2", URL_B, "pending", "r1", title);
    const why = "open exited 1: Unable to find application named 'Missing Browser'";
    const failing = rig({ review: { browser: "Missing Browser" }, open: { ok: false, why } });
    failing.opener.offer("g1");
    await failing.opener.idle();
    const ok = rig();
    ok.opener.offer("g2");
    await ok.opener.idle();
    const rows = db.query("SELECT line, full_line FROM items WHERE kind = 'gate_ready' ORDER BY id").all() as { line: string; full_line: string | null }[];
    const [failed, opened] = rows as [{ line: string; full_line: string | null }, { line: string; full_line: string | null }];
    expect(failed.line.length).toBeLessThanOrEqual(200);
    expect(failed.line.startsWith("design ready for review (g1): Rework")).toBe(true);
    expect(failed.line.endsWith(`… · NOT opened (${why}); open it by hand`)).toBe(true);
    expect(failed.full_line).toBe(`design ready for review (g1): ${title} (web) ${longUrl} · NOT opened (${why}); open it by hand`);
    expect(opened.line.length).toBeLessThanOrEqual(200);
    expect(opened.line.endsWith("… · opened in Google Chrome")).toBe(true);
    expect(opened.full_line).toBe(`design ready for review (g2): ${title} (web) ${URL_B} · opened in Google Chrome`);
  });

  test("presence that never shows listening fails the gate without running open", async () => {
    seedGate("g1", URL_A);
    const r = rig({ presence: { listening: false, why: "Lavish never showed the page listened to in 60 s" } });
    r.opener.offer("g1");
    await r.opener.idle();
    expect(r.opens).toEqual([]);
    expect(gate("g1")).toMatchObject({ open_state: "failed", open_detail: "Lavish never showed the page listened to in 60 s" });
    expect(itemLine("g1")).toContain("· NOT opened (Lavish never showed the page listened to in 60 s); open it by hand");
    expect(events("gate.browser").map((e) => e.kind)).toEqual(["gate.browser_failed"]);
  });

  test("a file:// page opens at once: nothing listens on it", async () => {
    seedGate("g1", "file:///tmp/report/design/design.html");
    const r = rig();
    r.opener.offer("g1");
    await r.opener.idle();
    expect(r.probes).toEqual([]);
    expect(r.opens).toEqual([{ browser: "Google Chrome", url: "file:///tmp/report/design/design.html" }]);
    expect(gate("g1").open_state).toBe("opened");
  });

  test("once per page per run: the same page handed in again is skipped; another page or run opens", async () => {
    seedGate("g1", URL_A);
    const r = rig();
    r.opener.offer("g1");
    await r.opener.idle();
    closeGate("g1");
    seedGate("g2", URL_A);
    r.opener.offer("g2");
    await r.opener.idle();
    expect(gate("g2")).toMatchObject({ open_state: "skipped", open_detail: "already opened for g1" });
    expect(itemLine("g2")).not.toContain("opened in");
    seedGate("g3", URL_B);
    r.opener.offer("g3");
    seedRun(db, "r2", "web-a2");
    seedGate("g4", URL_A, "pending", "r2");
    r.opener.offer("g4");
    await r.opener.idle();
    expect(r.opens.map((o) => o.url)).toEqual([URL_A, URL_B, URL_A]);
    expect(events("gate.browser_skipped")).toHaveLength(1);
  });

  test("a page whose earlier open failed is tried again on the next gate", async () => {
    seedGate("g1", URL_A);
    const failing = rig({ open: { ok: false, why: "open exited 1" } });
    failing.opener.offer("g1");
    await failing.opener.idle();
    closeGate("g1");
    seedGate("g2", URL_A);
    const r = rig();
    r.opener.offer("g2");
    await r.opener.idle();
    expect(gate("g2").open_state).toBe("opened");
  });

  test("off by the setting or the environment: nothing is probed or opened", async () => {
    seedGate("g1", URL_A);
    seedGate("g2", URL_B);
    const bySetting = rig({ review: { open_browser: false } });
    bySetting.opener.offer("g1");
    const byEnv = rig({ mode: { kind: "off", why: "FLOWRYN_NOTIFY=off" } });
    byEnv.opener.offer("g2");
    await Promise.all([bySetting.opener.idle(), byEnv.opener.idle()]);
    expect([...bySetting.probes, ...byEnv.probes, ...bySetting.opens, ...byEnv.opens]).toEqual([]);
    expect(gate("g1")).toMatchObject({ open_state: "off", open_detail: "[review] open_browser = false" });
    expect(gate("g2")).toMatchObject({ open_state: "off", open_detail: "FLOWRYN_NOTIFY=off" });
  });

  test("at most once: a gate claimed by a daemon that died stays opening, and a closed gate is never opened", async () => {
    seedGate("g1", URL_A, "opening");
    seedGate("g2", URL_B);
    closeGate("g2");
    const r = rig();
    r.opener.offer("g1");
    r.opener.offer("g2");
    r.opener.offer("g404");
    await r.opener.idle();
    expect(r.probes).toEqual([]);
    expect(r.opens).toEqual([]);
    expect(gate("g1").open_state).toBe("opening");
    expect(gate("g2").open_state).toBe("pending");
  });

  test("a gate that closes while the opener waits for presence is not opened", async () => {
    seedGate("g1", URL_A);
    let release: (r: PresenceResult) => void = () => {};
    const opens: string[] = [];
    const opener = new ReviewOpener({
      db,
      review: () => DEFAULT_REVIEW,
      mode: () => ({ kind: "open" }),
      log: () => {},
      now: Date.now,
      open: async (_b, url) => {
        opens.push(url);
        return { ok: true };
      },
      presence: () => new Promise((resolve) => (release = resolve)),
    });
    opener.offer("g1");
    closeGate("g1");
    release({ listening: true });
    await opener.idle();
    expect(opens).toEqual([]);
    expect(gate("g1").open_state).toBe("pending");
  });

  test("a stopping daemon leaves a gate that waits for presence pending, for the next one", async () => {
    seedGate("g1", URL_A);
    const opener = new ReviewOpener({
      db,
      review: () => DEFAULT_REVIEW,
      mode: () => ({ kind: "open" }),
      log: () => {},
      now: Date.now,
      open: async () => ({ ok: true }),
      presence: (_url, _ms, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ listening: false, why: "stopped" }))),
    });
    opener.offer("g1");
    opener.stop();
    await opener.idle();
    expect(gate("g1").open_state).toBe("pending");
  });
});

describe("the recorder (FLOWRYN_OPENER=record:<path>)", () => {
  test("records each open instead of spawning, fails while <path>.fail exists, and reads presence from <path>.presence", () => {
    const path = join(dir, "browser-opens.log");
    expect(recordOpen(path, "Google Chrome", URL_A)).toEqual({ ok: true });
    writeFileSync(`${path}.fail`, "open exited 1: Unable to find application named 'Google Chrome'\n");
    expect(recordOpen(path, "Google Chrome", URL_B)).toEqual({ ok: false, why: "open exited 1: Unable to find application named 'Google Chrome'" });
    expect(readFileSync(path, "utf8")).toBe(`Google Chrome\t${URL_A}\nGoogle Chrome\t${URL_B}\n`);
    expect(recordedPresence(path)).toEqual({ listening: true });
    writeFileSync(`${path}.presence`, "waiting\n");
    expect(recordedPresence(path)).toEqual({ listening: false, why: "Lavish never showed the page listened to (waiting)" });
  });

  test("the mode: record, else off under FLOWRYN_NOTIFY=off, else open", () => {
    expect(openerMode({ FLOWRYN_OPENER: "record:/tmp/o.log", FLOWRYN_NOTIFY: "off" })).toEqual({ kind: "record", path: "/tmp/o.log" });
    expect(openerMode({ FLOWRYN_NOTIFY: "off" })).toEqual({ kind: "off", why: "FLOWRYN_NOTIFY=off" });
    expect(openerMode({ FLOWRYN_NOTIFIER: "null" })).toEqual({ kind: "off", why: "FLOWRYN_NOTIFY=off" });
    expect(openerMode({ FLOWRYN_OPENER: "record:" })).toEqual({ kind: "open" });
    expect(openerMode({})).toEqual({ kind: "open" });
    // This process never opens anything.
    expect(openerMode(process.env).kind).not.toBe("open");
  });
});

test("the design and QA skills host pages with --no-open and never trust lavish-axi's opened", () => {
  for (const id of ["flowryn-design", "flowryn-visual-qa"]) {
    const body = STAGE_SKILLS.find((s) => s.name === id)!.body;
    expect(body).toContain("lavish-axi --no-open $FLOWRYN_REPORT_DIR/");
    expect(body).not.toMatch(/`lavish-axi \$FLOWRYN_REPORT_DIR/);
    expect(body).toContain("Flowryn opens");
  }
});

describe("[review] config", () => {
  function config(toml: string) {
    return parseConfig(toml, "/tmp/fl-home");
  }

  test("defaults: open in Google Chrome; a review page's channel alerts after two minutes", () => {
    expect(reviewConfig(config(""))).toEqual({ open_browser: true, browser: "Google Chrome", channel_alert_ms: 120_000 });
    expect(reviewConfig(config('[review]\nopen_browser = false\nbrowser = "Safari"\nchannel_alert_ms = 0\n'))).toEqual({ open_browser: false, browser: "Safari", channel_alert_ms: 0 });
  });

  test("channel_alert_ms is a whole number of milliseconds, 0 or more", () => {
    for (const bad of ["-1", "1.5", '"2m"', "true"]) {
      expect(() => reviewConfig(config(`[review]\nchannel_alert_ms = ${bad}\n`))).toThrow(/channel_alert_ms must be a whole number/);
    }
  });

  test("refuses an unknown key, a non-boolean switch and a browser name that is not one", () => {
    for (const bad of ["[review]\nopen = true\n", '[review]\nopen_browser = "yes"\n', '[review]\nbrowser = ""\n', '[review]\nbrowser = "-n"\n', '[review]\nbrowser = "Chrome\\nEvil"\n', `[review]\nbrowser = "${"x".repeat(101)}"\n`, "[review]\nbrowser = 3\n"]) {
      expect(() => reviewConfig(config(bad))).toThrow(/\[review\]/);
    }
  });
});

describe("migration 18", () => {
  test("a review gate open at upgrade is skipped; closed and merge gates have no browser state", () => {
    const old = openDb(join(dir, "old.db"));
    try {
      migrate(old, MIGRATIONS.filter((m) => m.version < 18));
      seedRun(old);
      const now = Date.now();
      tx(old, () => {
        old.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at) VALUES ('g1', 'r1', 'design', 'review', ?1, 'open', ?2)").run(URL_A, now);
        old.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at, closed_at) VALUES ('g2', 'r1', 'design', 'review', ?1, 'changes', ?2, ?2)").run(URL_A, now);
        old.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES ('g3', 'r1', 'ship', 'merge', 'open', ?1)").run(now);
      });
      expect(migrate(old, MIGRATIONS.filter((m) => m.version <= 18))).toEqual([18]);
      const states = old.query("SELECT id, open_state, open_detail FROM gates ORDER BY id").all();
      expect(states).toEqual([
        { id: "g1", open_state: "skipped", open_detail: "open before Flowryn opened review pages" },
        { id: "g2", open_state: null, open_detail: null },
        { id: "g3", open_state: null, open_detail: null },
      ]);
      expect(() => old.query("UPDATE gates SET open_state = 'bogus' WHERE id = 'g1'").run()).toThrow();
    } finally {
      old.close();
    }
  });
});

describe("Lavish presence over its /events WebSocket", () => {
  /** A stand-in for lavish-axi 0.1.65's event socket: same-origin Origin required, chat-sync then presence. */
  function fakeLavish(presence: string[], gapMs = 20) {
    const origins: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const origin = req.headers.get("origin");
        origins.push(origin);
        const url = new URL(req.url);
        if (!/^\/events\/[0-9a-f]{16}$/.test(url.pathname)) return new Response("Not Found", { status: 404 });
        if (origin !== `http://127.0.0.1:${srv.port}`) return new Response("Forbidden", { status: 403 });
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "chat-sync", data: { chat: [] } }));
          presence.forEach((state, i) => setTimeout(() => ws.send(JSON.stringify({ type: "agent-presence", data: { state } })), i * gapMs));
        },
        message() {},
      },
    });
    return { server, origins, url: `http://127.0.0.1:${server.port}/session/0123456789abcdef` };
  }

  test("waits through waiting until listening, sending the page's own origin", async () => {
    const lavish = fakeLavish(["waiting", "listening"]);
    try {
      const seen = await lavishPresence(lavish.url, 5_000, new AbortController().signal);
      expect(seen).toEqual({ listening: true });
      expect(lavish.origins[0]).toBe(new URL(lavish.url).origin);
    } finally {
      lavish.server.stop(true);
    }
  });

  test("a page Lavish never shows listening fails after the wait, saying so", async () => {
    const lavish = fakeLavish(["waiting"]);
    try {
      const started = Date.now();
      const seen = await lavishPresence(lavish.url, 300, new AbortController().signal);
      expect(seen).toEqual({ listening: false, why: "Lavish never showed the page listened to in 0 s" });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      lavish.server.stop(true);
    }
  });

  test("no Lavish at the URL: cannot read presence, never opened early", async () => {
    const lavish = fakeLavish([]);
    const url = lavish.url;
    lavish.server.stop(true);
    const seen = await lavishPresence(url, 300, new AbortController().signal);
    expect(seen.listening).toBe(false);
    expect((seen as { why: string }).why).toStartWith("cannot read Lavish presence (");
  });

  test("not a Lavish URL, or a stop: no listening", async () => {
    expect(await lavishPresence("http://127.0.0.1:1/other", 300, new AbortController().signal)).toEqual({ listening: false, why: "cannot read Lavish presence (not a Lavish review URL)" });
    const lavish = fakeLavish(["waiting"]);
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const started = Date.now();
      expect((await lavishPresence(lavish.url, 10_000, abort.signal)).listening).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      lavish.server.stop(true);
    }
  });
});
