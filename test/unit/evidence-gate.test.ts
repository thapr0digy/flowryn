import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeReturnBrief } from "../../src/attention/briefing.ts";
import { decisionsConfig } from "../../src/attention/decisions-policy.ts";
import { designEvidence, evidenceRefusal, probeProblems, qaEvidence } from "../../src/attention/evidence-gate.ts";
import { evidencePass, readProbes } from "../../src/attention/evidence-pass.ts";
import { settledValidators, validatorPass, type GateFacts, type ValidatorDeps } from "../../src/attention/gate-validator.ts";
import { loadConfig, parseConfig } from "../../src/config/config.ts";
import { getMeta, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { reopenableValidatorPass } from "../../src/policy/gates.ts";
import { DESIGN_GAP_CHECKS } from "../../src/skills/design-gap-check.ts";
import { DESIGN_TEMPLATE, DESIGN_PLACEHOLDERS } from "../../src/skills/design-template.ts";
import { QA_NOTHING_VISIBLE, QA_PLACEHOLDERS, QA_TEMPLATE } from "../../src/skills/qa-template.ts";
import { gatePassOnEvidence, verifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { initialSteps } from "../../src/verify/runner.ts";
import { finishVerification, insertVerification } from "../../src/verify/store.ts";
import { cleanGapCheck } from "../helpers/design-page.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * The evidence gate (docs/notes/2026-11-23-phase-gates-pass-8f.md): `gate_pass = "evidence"`, the
 * page and probe rules, each refusal alone, and the daemon pass end to end on a QA and a design
 * gate: the verify it queues, the pass on channel evidence, the hold, the brief's lines and the
 * undo. No model and no git: the call and git go through their seams.
 */

const HEAD = "b".repeat(40);
const CONFIG = '[projects.web]\nverify = ["true"]\ngate_pass = "evidence"\n';

let h: TestHome;
let db: Db;
let runId: string;
let taskId: string;
let reportDir: string;
let now: number;

function qaPage(verdict = "works", opts: { severity?: string; nothingVisible?: boolean } = {}): string {
  let page = QA_TEMPLATE.replace("{{VERDICT}}", verdict);
  if (opts.nothingVisible) page = page.replace("{{WHAT_CHANGED}}", `${QA_NOTHING_VISIBLE} Only the daemon changed.`);
  if (opts.severity) page = page.replace("{{FINDINGS}}", `<ol><li data-severity="${opts.severity}" id="F1">A finding.</li></ol>`);
  for (const slot of QA_PLACEHOLDERS) page = page.replaceAll(slot, "Said in plain words.");
  return page;
}

function designPage(gaps = cleanGapCheck()): string {
  let page = DESIGN_TEMPLATE.replace("{{ASK}}", "Approve, or send changes.").replace("{{GAPS}}", gaps);
  for (const slot of DESIGN_PLACEHOLDERS) page = page.replaceAll(slot, "Filled.");
  return page;
}

const CLEAN_PROBE = JSON.stringify({ url: "http://x/", pageOverflow: null, overflow: [], clipped: [{ selector: "p", ellipsis: true }], overlaps: [], images: [], contrast: [], contrastUnknown: [{ selector: "h1" }], names: [], focus: null, inventory: {}, offToken: [{ kind: "color" }], truncated: {}, errors: [] });

function setup(extra = CONFIG, stage = "qa"): void {
  h = makeHome({ extraConfig: extra });
  const seeded = seedRun(h);
  runId = seeded.runId;
  taskId = seeded.taskId;
  db = h.db();
  now = Date.now();
  db.query("UPDATE runs SET workflow = 'feature-ui', stage = ?2, stage_state = 'review' WHERE id = ?1").run(runId, stage);
  db.query("UPDATE task_policy SET workflow = 'feature-ui' WHERE task_id = ?1").run(taskId);
  reportDir = join(h.dataDir, taskId);
  mkdirSync(join(reportDir, "qa"), { recursive: true });
  mkdirSync(join(reportDir, "design"), { recursive: true });
}

function openGate(stage: string, html: string, passHead: string | null = HEAD): void {
  const page = join(reportDir, stage === "qa" ? "qa/evidence.html" : "design/design.html");
  writeFileSync(page, html);
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, page_path, state, opened_at, pass_head) VALUES ('g1', ?1, ?2, 'review', 'http://127.0.0.1:4387/session/x', ?3, 'open', ?4, ?5)").run(runId, stage, page, now - 60_000, passHead);
}

function deps(over: Partial<ValidatorDeps> = {}): ValidatorDeps {
  const config = loadConfig(h.home).config;
  return {
    db,
    config: () => config,
    decisions: () => decisionsConfig(config),
    git: async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: "" }),
    now: () => now,
    log: () => {},
    changed: () => {},
    ...over,
  };
}

function verified(state: "passed" | "failed"): string {
  const config = loadConfig(h.home).config;
  const steps = verifyConfig(config, "web")!;
  return tx(db, () => {
    const v = insertVerification(db, { project_id: "web", pr_url: "local:fm/x", task_id: taskId, head_sha: HEAD, steps: initialSteps(steps.steps), policy_id: verifyPolicyId(steps), dir: (id) => join(h.stateDir, id), worktree: (id) => join(h.stateDir, id, "wt"), project_path: "/tmp/web", source: "daemon", now });
    finishVerification(db, v, { state, steps: v.steps, tests: null, detail: null, binary: null }, now + 1);
    return v.id;
  });
}

const gate = () => db.query("SELECT * FROM gates WHERE id = 'g1'").get() as { state: string; approval_id: string | null };
const channel = () => (db.query("SELECT a.channel FROM gates g JOIN approvals a ON a.id = g.approval_id WHERE g.id = 'g1'").get() as { channel: string } | null)?.channel ?? null;
const events = (kind: string) => db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind).map((r) => JSON.parse((r as { payload: string }).payload) as Record<string, unknown>);

afterEach(() => {
  db?.close();
  h?.cleanup();
});

describe("[projects.<id>] gate_pass", () => {
  test('"evidence" is the one value; unset is off; anything else is refused', () => {
    const on = parseConfig(CONFIG, "/tmp/h");
    expect(gatePassOnEvidence(on, "web")).toBe(true);
    expect(gatePassOnEvidence(parseConfig('[projects.web]\nverify = ["true"]\n', "/tmp/h"), "web")).toBe(false);
    const bad = parseConfig('[projects.web]\nverify = ["true"]\ngate_pass = "always"\n', "/tmp/h");
    expect(() => verifyConfig(bad, "web")).toThrow(/gate_pass must be "evidence"/);
    expect(gatePassOnEvidence(bad, "web")).toBe(false);
  });
});

describe("the page and probe rules", () => {
  test("a probe is clean with intended ellipses, unknown contrast and off-token values; each defect list is not", () => {
    expect(probeProblems("p.json", CLEAN_PROBE)).toEqual([]);
    const dirty = { ...JSON.parse(CLEAN_PROBE), pageOverflow: { scrollWidth: 500, viewport: 390 }, contrast: [{}, {}], clipped: [{ ellipsis: false }] };
    expect(probeProblems("p.json", JSON.stringify(dirty))).toEqual(["p.json: the page scrolls sideways", "p.json: 2 contrast", "p.json: 1 clipped without an ellipsis"]);
    expect(probeProblems("p.json", JSON.stringify({ error: "boom" }))).toEqual(["p.json: the probe failed (boom)"]);
    expect(probeProblems("p.json", "{")).toEqual(["p.json is not JSON"]);
  });

  test("a probe missing a list it must measure is not clean", () => {
    expect(probeProblems("p.json", "{}")).toEqual(["p.json: pageOverflow missing"]);
    for (const list of ["overflow", "overlaps", "contrast", "names", "images", "clipped"]) {
      const partial = JSON.parse(CLEAN_PROBE) as Record<string, unknown>;
      delete partial[list];
      expect(probeProblems("p.json", JSON.stringify(partial))).toEqual([`p.json: ${list} missing`]);
    }
  });

  test("QA: works, no blocker or major, and clean probes; nothing visible needs no probe", () => {
    const probe = [{ name: "probe-a.json", text: CLEAN_PROBE }];
    expect(qaEvidence({ html: qaPage(), probes: probe })).toEqual({ ok: true, evidence: { verdict: "works", probes: 1, nothingVisible: false } });
    expect(qaEvidence({ html: qaPage("works", { severity: "minor" }), probes: probe }).ok).toBe(true);
    expect(qaEvidence({ html: qaPage("works-with-caveats"), probes: probe })).toMatchObject({ ok: false, why: expect.stringMatching(/works-with-caveats, not works/) });
    expect(qaEvidence({ html: qaPage("works", { severity: "major" }), probes: probe })).toMatchObject({ ok: false, why: expect.stringMatching(/major/) });
    expect(qaEvidence({ html: qaPage(), probes: [] })).toMatchObject({ ok: false, why: expect.stringMatching(/no probe was run/) });
    expect(qaEvidence({ html: qaPage("works", { nothingVisible: true }), probes: [] }).ok).toBe(true);
  });

  test("design: a ready gap check whose Simplest secure option records nothing", () => {
    expect(designEvidence(designPage())).toEqual({ ok: true, gap: "ready" });
    expect(designEvidence(designPage(cleanGapCheck("ready with the fixes below")))).toEqual({ ok: true, gap: "ready with the fixes below" });
    const infra = cleanGapCheck().replace(`<td>${DESIGN_GAP_CHECKS[0].name}</td><td>none</td>`, `<td>${DESIGN_GAP_CHECKS[0].name}</td><td>1</td>`);
    expect(designEvidence(designPage(infra))).toMatchObject({ ok: false, why: expect.stringMatching(/may add infrastructure: .* records 1/) });
    const caveat = cleanGapCheck().replace(`<td>${DESIGN_GAP_CHECKS[0].name}</td><td>none</td>`, `<td>${DESIGN_GAP_CHECKS[0].name}</td><td>None needed, but a new Redis service</td>`);
    expect(designEvidence(designPage(caveat))).toMatchObject({ ok: false, why: expect.stringMatching(/records None needed, but a new Redis service/) });
    const unnumbered = `<p>Verdict: ready</p><table><tr><td>${DESIGN_GAP_CHECKS[0].name}</td><td>1</td></tr><tr><td>${DESIGN_GAP_CHECKS[1].name}</td><td>none</td></tr></table>`;
    expect(designEvidence(designPage(unnumbered))).toMatchObject({ ok: false, why: expect.stringMatching(/records 1$/) });
    expect(designEvidence(designPage("<p>No verdict here.</p>"))).toMatchObject({ ok: false, why: expect.stringMatching(/verdict is missing/) });
  });

  test("readProbes reads probe-*.json only and refuses a symlink", () => {
    setup();
    writeFileSync(join(reportDir, "qa", "probe-inbox-390x844-light-default.json"), CLEAN_PROBE);
    writeFileSync(join(reportDir, "qa", "checklist.md"), "1. x (source: y)\n");
    expect(readProbes(join(reportDir, "qa"))).toEqual([{ name: "probe-inbox-390x844-light-default.json", text: CLEAN_PROBE }]);
    Bun.spawnSync(["ln", "-s", "/etc/hosts", join(reportDir, "qa", "probe-x.json")]);
    expect(readProbes(join(reportDir, "qa"))).toMatch(/probe-x.json is not a regular file/);
  });
});

describe("evidenceRefusal: each check alone", () => {
  const CFG = { validator_rounds: 2 };
  const ok = (over: Partial<GateFacts> = {}): GateFacts => ({
    gate: { kind: "review", state: "open", stage: "qa", opened_at: 0, page_path: "/p.html" },
    run: { state: "running", sensitive: 0 },
    away: { since: 0 },
    autonomyCovered: false,
    pendingPlan: false,
    pinned: true,
    roundsUsed: 0,
    heldUnderAway: false,
    reopenedUnderAway: false,
    running: false,
    questions: [],
    ...over,
  });

  test("green facts: none", () => expect(evidenceRefusal(ok(), CFG)).toBeNull());

  const holds: [Partial<GateFacts>, RegExp][] = [
    [{ run: { state: "running", sensitive: 1 } }, /sensitive task/],
    [{ run: { state: "cancelled", sensitive: 0 } }, /run is over/],
    [{ pendingPlan: true }, /phase plan/],
    [{ gate: { kind: "review", state: "open", stage: "qa", opened_at: 0, page_path: null } }, /no review page/],
    [{ pinned: false }, /changed since it was pinned/],
    [{ heldUnderAway: true }, /left this stage to the user/],
    [{ reopenedUnderAway: true }, /reopened an evidence pass/],
    [{ roundsUsed: 2 }, /2 evidence rounds used/],
  ];
  for (const [over, why] of holds) test(`holds: ${why.source}`, () => expect(evidenceRefusal(ok(over), CFG)).toEqual({ why: expect.stringMatching(why), wait: false }));

  const waits: [Partial<GateFacts>, RegExp][] = [
    [{ autonomyCovered: true }, /unattended mode/],
    [{ running: true }, /already running/],
    [{ questions: [{ question: "q", context: null, reserved_class: null }] }, /questions are the user's/],
  ];
  for (const [over, why] of waits) test(`waits: ${why.source}`, () => expect(evidenceRefusal(ok(over), CFG)).toEqual({ why: expect.stringMatching(why), wait: true }));
});

describe("the pass on a QA gate", () => {
  beforeEach(() => {
    setup();
    writeFileSync(join(reportDir, "qa", "probe-inbox-390x844-light-default.json"), CLEAN_PROBE);
  });

  test("queues the verify at the head once, then passes on channel evidence when it passed; the brief shows it with its page and undo", async () => {
    openGate("qa", qaPage());
    const first = await evidencePass(deps());
    expect(first.verifies).toHaveLength(1);
    const queued = db.query("SELECT pr_url, head_sha, worktree, source FROM verify_queue").all();
    expect(queued).toEqual([{ pr_url: "local:fm/x", head_sha: HEAD, worktree: "/tmp/wt", source: "auto" }]);
    expect((await evidencePass(deps())).verifies).toHaveLength(0);
    expect(gate().state).toBe("open");

    db.query("UPDATE verify_queue SET state = 'started'").run();
    const v = verified("passed");
    const out = await evidencePass(deps());
    expect(out.passed).toEqual(["g1"]);
    expect(gate().state).toBe("passed");
    expect(channel()).toBe("evidence");
    expect(events("gate.evidence_passed")).toEqual([expect.objectContaining({ gate: "g1", stage: "qa", verdict: "works", probes: 1, verification: v, head: HEAD, review_url: "http://127.0.0.1:4387/session/x" })]);

    const brief = composeReturnBrief(db, { since: now - 1000, until: now + 1000, now: now + 1000, ageMs: 1000, reason: "back" });
    expect(brief).toContain(`- [g1] qa review of ${taskId} → passed on evidence (works, 1 clean probes, verify ${v} passed at ${HEAD.slice(0, 8)}; page: http://127.0.0.1:4387/session/x; undo: flowryn gate reopen ${taskId} --gate qa --body-file -)`);
    expect(reopenableValidatorPass(db, getRunWithPolicy(db, runId)!, "qa").id).toBe("g1");
  });

  test("a major finding holds the gate once, with why; the brief says it waits", async () => {
    openGate("qa", qaPage("works-with-caveats", { severity: "major" }));
    expect((await evidencePass(deps())).held).toEqual(["g1"]);
    expect((await evidencePass(deps())).held).toEqual([]);
    expect(gate().state).toBe("open");
    expect(events("gate.evidence_held")).toEqual([expect.objectContaining({ gate: "g1", why: expect.stringMatching(/works-with-caveats/) })]);
    expect(getMeta(db, "evidence_held:g1")).not.toBeNull();
    const brief = composeReturnBrief(db, { since: now - 1000, until: now + 1000, now: now + 1000, ageMs: 1000, reason: "back" });
    expect(brief).toContain(`- [g1] qa review of ${taskId} → waits for you: the QA verdict is works-with-caveats, not works (page: http://127.0.0.1:4387/session/x)`);
  });

  test("a verify that failed at the head holds it", async () => {
    openGate("qa", qaPage());
    const v = verified("failed");
    await evidencePass(deps());
    expect(events("gate.evidence_held")).toEqual([expect.objectContaining({ why: `verify ${v} failed at ${HEAD.slice(0, 8)}` })]);
  });

  test("a verify cut off by a daemon restart and requeued is waited on, then its passing rerun passes the gate", async () => {
    openGate("qa", qaPage());
    await evidencePass(deps());
    db.query("UPDATE verify_queue SET state = 'started'").run();
    verified("failed");
    tx(db, () => db.query("INSERT INTO verify_queue (id, project_id, pr_url, task_id, head_sha, policy_id, worktree, source, state, requested_at, path) SELECT 'rq-again', project_id, pr_url, task_id, head_sha, policy_id, worktree, 'recovered', 'queued', ?1, path FROM verify_queue LIMIT 1").run(now));
    expect((await evidencePass(deps())).held).toEqual([]);
    db.query("UPDATE verify_queue SET state = 'started' WHERE id = 'rq-again'").run();
    now += 10;
    verified("passed");
    expect((await evidencePass(deps())).passed).toEqual(["g1"]);
    expect(events("gate.evidence_held")).toEqual([]);
  });

  test("a dirty probe holds it", async () => {
    openGate("qa", qaPage());
    writeFileSync(join(reportDir, "qa", "probe-b.json"), JSON.stringify({ ...JSON.parse(CLEAN_PROBE), names: [{}] }));
    await evidencePass(deps());
    expect(events("gate.evidence_held")[0]!.why).toMatch(/probe is not clean: probe-b.json: 1 names/);
  });

  test("a sensitive task stays the user's", async () => {
    db.query("UPDATE task_policy SET sensitive = 1 WHERE task_id = ?1").run(taskId);
    openGate("qa", qaPage());
    await evidencePass(deps());
    expect(events("gate.evidence_held")[0]!.why).toMatch(/sensitive task/);
    expect(db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 0 });
  });

  test("the branch moved since the review opened: held", async () => {
    openGate("qa", qaPage(), "c".repeat(40));
    await evidencePass(deps());
    expect(events("gate.evidence_held")[0]!.why).toMatch(/branch moved from cccccccc/);
  });
});

test("a project without gate_pass is left alone", async () => {
  setup('[projects.web]\nverify = ["true"]\n');
  openGate("qa", qaPage());
  const out = await evidencePass(deps());
  expect(out).toEqual({ passed: [], rounds: [], verifies: [], held: [] });
  expect(events("gate.evidence_held")).toEqual([]);
});

describe("the pass on a design gate", () => {
  const PASS = { verdict: "pass", findings: [], questions: [] };
  const claude = (obj: unknown) => async () => ({ code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(obj), total_cost_usd: 0.04 }), stderr: "", timedOut: false, aborted: false, spawnError: null, truncated: false }) as never;

  beforeEach(() => setup(CONFIG, "design"));

  test("a clean gap check starts one independent round; its pass passes the gate on channel evidence", async () => {
    openGate("design", designPage());
    const out = await evidencePass(deps({ call: claude(PASS) }));
    expect(out.rounds).toEqual(["j1"]);
    await settledValidators();
    expect(db.query("SELECT basis, away_since, state FROM gate_validations WHERE id = 'j1'").get()).toEqual({ basis: "evidence", away_since: 0, state: "passed" });
    expect(gate().state).toBe("passed");
    expect(channel()).toBe("evidence");
    expect(events("gate.evidence_passed")).toEqual([expect.objectContaining({ gate: "g1", stage: "design", validation: "j1", gap: "ready" })]);
    const brief = composeReturnBrief(db, { since: now - 1000, until: Date.now() + 1000, now: Date.now() + 1000, ageMs: 1000, reason: "back" });
    expect(brief).toContain(`- [g1] design review of ${taskId} → passed on evidence (gap check ready, independent review j1 passed; report: flowryn show j1; page: http://127.0.0.1:4387/session/x; undo: flowryn gate reopen ${taskId} --gate design --body-file -)`);
    // The round's own line is not repeated.
    expect(brief).not.toContain("[j1] design");
  });

  test("changes from the reviewer send the design back; it is not passed", async () => {
    openGate("design", designPage());
    await evidencePass(deps({ call: claude({ verdict: "changes", findings: [{ requirement: "R1", problem: "Missing.", fix: "Add it." }], questions: [] }) }));
    await settledValidators();
    expect(gate().state).toBe("changes");
    expect(events("gate.evidence_passed")).toEqual([]);
  });

  test("a design that may add infrastructure is held without a round", async () => {
    const infra = cleanGapCheck().replace(`<td>${DESIGN_GAP_CHECKS[0].name}</td><td>none</td>`, `<td>${DESIGN_GAP_CHECKS[0].name}</td><td>1 (a new Vault role)</td>`);
    openGate("design", designPage(infra));
    const out = await evidencePass(deps({ call: claude(PASS) }));
    expect(out).toMatchObject({ rounds: [], held: ["g1"] });
    expect(db.query("SELECT COUNT(*) AS n FROM gate_validations").get()).toEqual({ n: 0 });
  });

  test("a round that gives no verdict hands the stage to the user: no second round starts", async () => {
    openGate("design", designPage());
    await evidencePass(deps({ call: claude({ nonsense: true }) }));
    await settledValidators();
    expect(db.query("SELECT state FROM gate_validations WHERE id = 'j1'").get()).toEqual({ state: "failed" });
    const again = await evidencePass(deps({ call: claude(PASS) }));
    expect(again).toMatchObject({ rounds: [], held: ["g1"] });
    expect(gate().state).toBe("open");
    expect(events("gate.evidence_held")[0]!.why).toMatch(/earlier evidence round left this stage to the user/);
  });

  test("a round the daemon cut off is rerun once; a second cut-off hands the stage to the user", async () => {
    openGate("design", designPage());
    const roomy = (over: Partial<ValidatorDeps> = {}) => {
      const base = deps(over);
      return { ...base, decisions: () => ({ ...base.decisions(), validator_rounds: 5 }) };
    };
    const cutOff = (id: string) => tx(db, () => db.query("INSERT INTO gate_validations (id, gate_id, run_id, task_id, stage, away_since, head, state, waited_ms, started_at, basis) VALUES (?1, 'g1', ?2, ?3, 'design', 0, ?4, 'running', 0, ?5, 'evidence')").run(id, runId, taskId, HEAD, now));
    cutOff("j90");
    await validatorPass(roomy());
    expect(db.query("SELECT state, reason FROM gate_validations WHERE id = 'j90'").get()).toEqual({ state: "failed", reason: "the daemon stopped while it ran" });
    cutOff("j91");
    await validatorPass(roomy());
    expect(await evidencePass(roomy({ call: claude(PASS) }))).toMatchObject({ rounds: [], held: ["g1"] });
    expect(events("gate.evidence_held")[0]!.why).toMatch(/earlier evidence round left this stage to the user/);
  });

  test("one cut-off round is rerun and its fresh pass passes the gate", async () => {
    openGate("design", designPage());
    tx(db, () => db.query("INSERT INTO gate_validations (id, gate_id, run_id, task_id, stage, away_since, head, state, waited_ms, started_at, basis) VALUES ('j90', 'g1', ?1, ?2, 'design', 0, ?3, 'running', 0, ?4, 'evidence')").run(runId, taskId, HEAD, now));
    await validatorPass(deps());
    const out = await evidencePass(deps({ call: claude(PASS) }));
    expect(out.held).toEqual([]);
    expect(out.rounds).toHaveLength(1);
    await settledValidators();
    expect(gate().state).toBe("passed");
    expect(channel()).toBe("evidence");
  });

  test("a review gate of a stage with no evidence rule is left to the user without a word", async () => {
    db.query("UPDATE runs SET stage = 'build' WHERE id = ?1").run(runId);
    openGate("build", designPage());
    const out = await evidencePass(deps({ call: claude(PASS) }));
    expect(out).toEqual({ passed: [], rounds: [], verifies: [], held: [] });
    expect(events("gate.evidence_held")).toEqual([]);
    expect(getMeta(db, "evidence_held:g1")).toBeNull();
  });

  test("a stage the user reopened stays theirs", async () => {
    openGate("design", designPage());
    tx(db, () => appendEvent(db, { source: "cli", kind: "gate.reopened", runId, taskId, payload: { gate: "g0", stage: "design", by: "human" }, ts: now - 1000 }));
    await evidencePass(deps({ call: claude(PASS) }));
    expect(events("gate.evidence_held")[0]!.why).toMatch(/reopened an evidence pass/);
  });
});
