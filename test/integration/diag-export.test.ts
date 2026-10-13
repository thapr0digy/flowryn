import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { cli, cliJson, makeHome, seedLeader, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * `flowryn diag export` through the real CLI (docs/notes/2026-10-13-next-steps-md-wq.md):
 * the CLI process writes the file, new and mode 0600, from the daemon's read
 * or, with the daemon down, the read-only fallback; redacted unless --include-text.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

const QUESTION = "Should the export include the tenant table?";
const CONFIG_SECRET = "ghp_configtokenvalue123456";
const CONFIG = `[workers.pi]\nenv = { PI_API_KEY = "very-secret-value" }\n[workers.claude]\nextra_args = ["--note", "${CONFIG_SECRET}"]\n`;

function setup(): { h: TestHome; leader: string; worker: string; taskId: string } {
  const h = makeHome({ extraConfig: CONFIG });
  homes.push(h);
  const leader = seedLeader(h);
  const run = seedRun(h);
  const db = h.db();
  tx(db, () => {
    db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, created_at) VALUES ('q1', ?1, ?2, ?3, '[\"yes\",\"no\"]', 1, 'open', ?4)").run(run.taskId, run.runId, QUESTION, Date.now());
  });
  db.close();
  return { h, leader, worker: run.token, taskId: run.taskId };
}

describe("flowryn diag export", () => {
  test("with the daemon: a new 0600 file, redacted; an existing file is never overwritten; a worker is refused", async () => {
    const { h, leader, worker, taskId } = setup();
    daemons.push(await startDaemon(h));
    const out = join(h.home, "diag.json");
    const done = await cliJson(h, ["diag", "export", taskId, "--out", out], { env: { FLOWRYN_TOKEN: leader } });
    expect(done.code).toBe(0);
    expect(done.reply.data).toMatchObject({ exported: out, task: taskId, text: "redacted" });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, "utf8");
    const data = JSON.parse(text) as { format: string; flowryn: { version: string }; decisions: { id: string }[] };
    expect(data.format).toBe("flowryn-diag/1");
    expect(typeof data.flowryn.version).toBe("string");
    expect(data.decisions.map((d) => d.id)).toEqual(["q1"]);
    for (const secret of [QUESTION, CONFIG_SECRET, "very-secret-value"]) expect(text).not.toContain(secret);

    writeFileSync(out, "keep me");
    const again = await cli(h, ["diag", "export", taskId, "--out", out], { env: { FLOWRYN_TOKEN: leader } });
    expect(again.code).toBe(3);
    expect(again.stdout).toContain("code: already_exists");
    expect(readFileSync(out, "utf8")).toBe("keep me");

    const asWorker = await cli(h, ["diag", "export", taskId, "--out", join(h.home, "worker.json")], { env: { FLOWRYN_TOKEN: worker } });
    expect(asWorker.code).toBe(77);
    expect(existsSync(join(h.home, "worker.json"))).toBe(false);

    const missing = await cli(h, ["diag", "export", "no-such-task", "--out", join(h.home, "none.json")], { env: { FLOWRYN_TOKEN: leader } });
    expect(missing.code).toBe(4);
    expect(existsSync(join(h.home, "none.json"))).toBe(false);
  });

  test("with the daemon down: the read-only fallback serves it; --include-text keeps the question, never a config secret", async () => {
    const { h, leader, taskId } = setup();
    const out = join(h.home, "offline.json");
    const done = await cliJson(h, ["diag", "export", taskId, "--out", out, "--include-text"], { env: { FLOWRYN_TOKEN: leader } });
    expect(done.code).toBe(0);
    expect(done.reply.data).toMatchObject({ text: "included" });
    const text = readFileSync(out, "utf8");
    expect(JSON.parse(text)).toMatchObject({ flowryn: "read-only fallback (daemon down)", text: "included" });
    expect(text).toContain(QUESTION);
    for (const secret of [CONFIG_SECRET, "very-secret-value"]) expect(text).not.toContain(secret);
  });

  test("--out is required", async () => {
    const { h, leader, taskId } = setup();
    const result = await cli(h, ["diag", "export", taskId], { env: { FLOWRYN_TOKEN: leader } });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("--out <file> is required");
  });
});
