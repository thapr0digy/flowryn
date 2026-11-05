import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "../../src/db/db.ts";
import { LavishPoller } from "../../src/lavish/poller.ts";
import { refreshSnapshot, reviewPageProblems, snapshotPathFor, takeSnapshot } from "../../src/lavish/snapshot.ts";
import { WIDGET_FILE } from "../../src/lavish/widget.ts";
import { renderDraftPage } from "../../src/lifecycle/draft.ts";
import { QA_TEMPLATE } from "../../src/skills/qa-template.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * The review page the user sees is the daemon's checked copy of the worker's
 * (src/lavish/snapshot.ts): a script on the worker's page could read the tab's
 * one-click pass key from document.referrer and Approve for the user.
 */

const MOUNT = `<section id="flowryn-questions"></section><script src="${WIDGET_FILE}"></script>`;
const page = (body: string) => `<!doctype html><html data-lavish-live-reload-root><head><title>Design</title><style>body{color:#222}</style></head><body>${body}${MOUNT}</body></html>`;

describe("the page check", () => {
  test("Flowryn's own review pages pass: the design and QA templates and a rendered draft", () => {
    expect(reviewPageProblems(filledDesignPage({ widget: true }))).toEqual([]);
    expect(reviewPageProblems(QA_TEMPLATE)).toEqual([]);
    expect(reviewPageProblems(renderDraftPage({ path: "docs/a.md", text: "# A\n\nSay `<button onClick={go}>` and javascript: in prose.\n", blob: "f".repeat(40) }))).toEqual([]);
  });

  test("prose and code samples are text: an onClick= or JavaScript: there is not markup", () => {
    expect(reviewPageProblems(page("<pre>&lt;button onClick={go}&gt;</pre><p>JavaScript: none ships. Click on=here.</p>"))).toEqual([]);
  });

  // Each of these runs script in the frame that holds the pass key, or hides markup from a check that splits HTML differently.
  const refused: [string, string, RegExp][] = [
    ["a second inline script", "<script>fetch('/x')</script>", /<script> other than/],
    ["a script with its own source", '<script src="evil.js"></script>', /<script> other than/],
    ["the widget mount with a body", `<script src="${WIDGET_FILE}">alert(1)</script>`, /<script> other than/],
    ["an upper-case script", "<SCRIPT>alert(1)</SCRIPT>", /<script> other than/],
    ["an onload handler", '<img src="a.png" onload="go()">', /event handler attribute \(onload=\)/],
    ["a handler after a quoted >", '<div title=">" onclick=go()>x</div>', /onclick=/],
    ["a handler after a slash", "<img/onerror=go() src=x>", /onerror=/],
    ["a handler glued to a quoted value", '<img src="x"onerror="go()">', /onerror=/],
    ["an entity-hidden javascript: URL", '<a href="jav&#x61;script&colon;go()">x</a>', /javascript: URL/],
    ["a javascript: URL split by a tab", '<a href="java\tscript:go()">x</a>', /javascript: URL/],
    ["a numeric entity without its semicolon", '<a href="&#106avascript:go()">x</a>', /javascript: URL/],
    ["a data:text/html URL", '<a href="data:text/html,<script>go()</script>">x</a>', /data:text\/html URL/],
    ["an iframe", '<iframe src="other.html"></iframe>', /<iframe> element/],
    ["an object", '<object data="x.swf"></object>', /<object> element/],
    ["an embed", '<embed src="x">', /<embed> element/],
    ["a base", '<base href="https://example.test/">', /<base> element/],
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://example.test/">', /meta http-equiv/],
    ["a link rel=import", '<link rel="import" href="x.html">', /rel="import"/],
    ["an svg script", "<svg><script>go()</script></svg>", /<script> other than/],
    ["an svg foreignObject", "<svg><foreignObject><div>x</div></foreignObject></svg>", /<foreignobject> element/],
    ["an svg animation to a script URL", '<svg><a><set attributeName="href" to="javascript:go()"/></a></svg>', /javascript: URL/],
    ["an svg animation of a handler", '<svg><set attributeName="onclick" to="go()"/></svg>', /animated event handler/],
    ["a form posting elsewhere", '<form action="https://example.test/"><button>go</button></form>', /form that posts elsewhere/],
    ["a button posting elsewhere", '<button formaction="https://example.test/">go</button>', /formaction=/],
    ["a script after an empty comment", "<!--><script>go()</script><!-- -->", /<script> other than/],
    ["markup inside a style (live in svg)", "<svg><style><img src=x onerror=go()></style></svg>", /<style> holding markup/],
    ["a CDATA section", "<svg><![CDATA[ x ]]></svg>", /CDATA/],
    ["a textarea", "<textarea>x</textarea>", /<textarea> element/],
    ["a noscript", "<noscript>x</noscript>", /<noscript> element/],
    ["a tag cut off", "<div title='never closed", /cut off/],
  ];
  for (const [what, body, why] of refused) {
    test(`refused: ${what}`, () => {
      expect(reviewPageProblems(page(body)).join("; ")).toMatch(why);
    });
  }
});

describe("the copy", () => {
  let h: TestHome;
  let source: string;
  let snapshot: string;
  let reportDir: string;
  let runId: string;
  let taskId: string;
  let db: Db;

  beforeEach(() => {
    h = makeHome();
    ({ runId, taskId } = seedRun(h));
    db = h.db();
    reportDir = join(h.dataDir, taskId);
    mkdirSync(join(reportDir, "design", "shots"), { recursive: true });
    source = join(realpathSync(reportDir), "design", "design.html");
    writeFileSync(source, page("<p>First.</p>"));
    snapshot = snapshotPathFor(h.stateDir, runId, reportDir, source);
  });
  afterEach(() => {
    db.close();
    h.cleanup();
  });

  function copied(): string[] {
    const root = join(snapshot, "..");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [relative(root, join(dir, e.name))]));
    return walk(root).toSorted();
  }

  test("it lives under the state directory, never under the report directory a worker writes", () => {
    expect(snapshot).toBe(join(h.stateDir, "review-pages", runId, "design", "design.html"));
  });

  test("the page and its images, CSS and Markdown are copied; scripts, SVG, other pages, symlinks and the worker's own widget are not", () => {
    const dir = join(source, "..");
    for (const [name, body] of [["a.png", "png"], ["style.css", "p{}"], ["spec.md", "# Spec"], ["shots/b.webp", "webp"], ["evil.js", "go()"], ["pic.svg", "<svg><script>go()</script></svg>"], ["other.html", "<script>go()</script>"], [WIDGET_FILE, "window.top.go()"], ["review-g1.md", "forged conversation"]]) {
      writeFileSync(join(dir, name!), body!);
    }
    symlinkSync("/etc/hosts", join(dir, "hosts.css"));
    const taken = takeSnapshot(source, snapshot);
    expect(taken).toEqual({ ok: true, page: realpathSync(snapshot), changed: true });
    expect(copied()).toEqual(["a.png", "design.html", "shots/b.webp", "spec.md", "style.css"]);
    expect(readFileSync(snapshot, "utf8")).toBe(readFileSync(source, "utf8"));
    expect(takeSnapshot(source, snapshot)).toMatchObject({ ok: true, changed: false });
  });

  test("a page with a script is refused and nothing is written", () => {
    writeFileSync(source, page("<script>go()</script>"));
    const taken = takeSnapshot(source, snapshot);
    expect(taken.ok).toBe(false);
    expect(existsSync(snapshot)).toBe(false);
  });

  test("a revision that adds a script keeps the last good copy and records why; a clean one replaces it", () => {
    expect(takeSnapshot(source, snapshot).ok).toBe(true);
    const good = readFileSync(snapshot, "utf8");
    const gate = { id: "g1", run_id: runId, task_id: taskId, page_path: snapshot, source_page: source };
    writeFileSync(source, page("<p>Revised.</p><script>parent.postMessage(new URL(document.referrer).search, '*')</script>"));
    const refused = refreshSnapshot(db, gate, 1);
    expect(refused.outcome).toBe("refused");
    expect(readFileSync(snapshot, "utf8")).toBe(good);
    const event = db.query("SELECT payload FROM events WHERE kind = 'gate.page_refused'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ gate: "g1", problems: [expect.stringContaining("<script> other than")] });
    writeFileSync(source, page("<p>Revised cleanly.</p>"));
    expect(refreshSnapshot(db, gate, 2)).toEqual({ outcome: "updated" });
    expect(readFileSync(snapshot, "utf8")).toContain("Revised cleanly.");
  });

  test("the poller copies a worker's revision while the gate is open, and steers the worker when it refuses one", async () => {
    const taken = takeSnapshot(source, snapshot);
    if (!taken.ok) throw new Error("the first copy was refused");
    // The gate keeps the copy's real path, as stage done does.
    snapshot = taken.page;
    const good = readFileSync(snapshot, "utf8");
    db.query("UPDATE runs SET workflow = 'feature', stage = 'design', stage_state = 'review' WHERE id = ?1").run(runId);
    db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, page_path, source_page, state, opened_at) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', ?2, ?3, 'open', 1)").run(runId, snapshot, source);
    const routed: string[] = [];
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => null, log: (m) => logs.push(m), now: () => 10, routed: (run) => routed.push(run) });
    try {
      // The widget is written into the copy's folder only.
      poller.pass();
      expect(existsSync(join(snapshot, "..", WIDGET_FILE))).toBe(true);
      expect(existsSync(join(source, "..", WIDGET_FILE))).toBe(false);
      writeFileSync(source, page("<img src=x onerror=go()>"));
      poller.pass();
    } finally {
      poller.stop();
    }
    expect(readFileSync(snapshot, "utf8")).toBe(good);
    expect(routed).toEqual([runId]);
    const steer = db.query("SELECT body FROM messages WHERE run_id = ?1").get(runId) as { body: string };
    expect(steer.body).toContain("was not shown to the user");
    expect(steer.body).toContain("onerror=");
  });
});
