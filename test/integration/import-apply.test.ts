import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeOriginRepo } from "../helpers/fleet-env.ts";
import { daemonCall, makeHome, seedLeader, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let daemon: DaemonProc;
afterEach(async () => {
  await daemon?.kill9().catch(() => {});
  h?.cleanup();
});

test("dry run reports create; apply creates; a second apply reports exists", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [{ id: "alpha-amend-q1", project: "alpha", kind: "scout", title: "Fold the model in", body: "x", priority: null, blockedBy: [] }],
    decisions: [{ id: "alpha-arch-r2-decision-retention", project: "alpha", origin: "alpha-arch-r2", key: "retention", question: "Confirm 365-day retention?", context: "trade-off", archived: "2026-09-20" }],
  };
  const dry = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: true });
  expect((dry.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["create", "create", "create"]);
  const applied = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(applied.ok).toBe(true);
  const again = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect((again.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["exists", "exists", "exists"]);
  const db = h.db();
  expect(db.query("SELECT id, delivery_mode, yolo, import_source FROM projects").all()).toEqual([{ id: "alpha", delivery_mode: "no-mistakes", yolo: 1, import_source: "firstmate:alpha" }]);
  expect(db.query("SELECT import_source, origin, key FROM decisions").all()).toEqual([{ import_source: "firstmate:alpha-arch-r2-decision-retention", origin: "alpha-arch-r2", key: "retention" }]);
  db.close();
});

test("a leader cannot import", async () => {
  h = makeHome();
  const leader = seedLeader(h);
  daemon = await startDaemon(h);
  const refused = await daemonCall(h.home, "import.apply", { plan: JSON.stringify({ projects: [], tasks: [], decisions: [] }), dry: true }, leader);
  expect(refused.ok).toBe(false);
});
