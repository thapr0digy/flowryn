import { describe, expect, test } from "bun:test";
import { autonomyVerdict } from "../../src/attention/autonomy-pass.ts";
import { decisionsConfig, keywordClasses, type DecisionsConfig } from "../../src/attention/decisions-policy.ts";
import { answerKind, exemptFinding, nmRecordJson, parseNmRecord, type NmRecordFinding } from "../../src/attention/real-actions.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import type { DecisionRow } from "../../src/lifecycle/decisions.ts";

/**
 * Unattended mode's finding rule (docs/notes/2026-11-10-unattended-mode-decide-8k.md): each rule
 * alone, on fixtures shaped like the real past questions (q196, q154, q91). Tests named
 * "assumption: …" fail when a design assumption is wrong.
 */

const config = (toml: string): DecisionsConfig => decisionsConfig(parseConfig(toml, "/tmp/h"));
const OFF = config("");
const CRED = config('[decisions]\nunattended_findings = "credential"\n');
const WIDE = config('[decisions]\nunattended_findings = "by-answer"\n');
const live = { state: "running" as const, sensitive: 0 };
const facts = { noCi: null };

function finding(over: Partial<NmRecordFinding> = {}): NmRecordFinding {
  return { id: "test-1", action: "ask-user", severity: "warning", category: "", file: "scripts/test.ts", cls: "diff-line", description: "Live evidence is missing for the main runtime change.", ...over };
}

function record(step: string, findings: NmRecordFinding[]): string {
  return JSON.stringify({ v: 1, step, findings });
}

let n = 1;
function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: `q${n++}`,
    task_id: "t",
    run_id: "r1",
    question: "Which cache layout?",
    options: JSON.stringify(["approve", "fix", "skip"]),
    blocking: 0,
    state: "open",
    answer: null,
    answered_via: null,
    answered_at: null,
    origin: null,
    key: null,
    context: null,
    recommendation: "approve",
    reserved_reason: null,
    reserved_class: null,
    defer_until: null,
    answered_by: null,
    rationale: null,
    created_at: 0,
    kind: null,
    gate_id: null,
    note: null,
    blocks: "the test step",
    autonomy_id: null,
    autonomy_state: null,
    nm_record: null,
    ...over,
  };
}

const Q196_TEXT =
  'no-mistakes test gate, two ask-user findings (verbatim):\n\ntest-1 (warning, scripts/test.ts): "Live evidence is missing for the main runtime change, the integration serial files running with --parallel=5. The gate-questions secret scan does not fail when the daemon removes a state/owned file between listing and reading it." Re-run this test step.';
const q196 = (over: Partial<DecisionRow> = {}) =>
  decision({
    question: Q196_TEXT,
    reserved_reason: "credential",
    reserved_class: "credential",
    nm_record: record("test", [finding({ description: "Live evidence is missing for the main runtime change. The gate-questions secret scan does not fail when the daemon removes a state/owned file between listing and reading it." })]),
    ...over,
  });

const Q154_TEXT =
  'no-mistakes test gate, ask-user finding flaky-gate-questions-parallel (warning, test/unit/gate-questions.test.ts), verbatim:\n\n"This test is flaky under the new parallel default." It did not fail in my 3 full runs. My recommendation is serial: it matches how this change handles the other timing-sensitive files and does not weaken an assertion.';
const q154 = () =>
  decision({
    question: Q154_TEXT,
    options: JSON.stringify(["serial", "tolerate", "approve"]),
    recommendation: "serial",
    reserved_reason: "security",
    reserved_class: "security",
    nm_record: record("test", [finding({ id: "flaky-gate-questions-parallel", file: "test/unit/gate-questions.test.ts", description: "This test is flaky under the new parallel default." })]),
  });

const review = (description: string, over: Partial<NmRecordFinding> = {}) => record("review", [finding({ id: "review-1", file: "src/config/workers.ts", description, ...over })]);

describe("the credential option", () => {
  test("assumption: a q196-shaped question (a test named secret scan, approve) is decided", () => {
    expect(autonomyVerdict(q196(), live, CRED, facts)).toEqual({ action: "decide", choice: "approve", rule: "finding-credential", classes: ["credential"] });
  });

  test("assumption: the same q196 text through a plain ask (no daemon record) still parks", () => {
    const v = autonomyVerdict(q196({ nm_record: null }), live, CRED, facts);
    expect(v).toMatchObject({ action: "park", klass: "credential" });
    expect(v.action === "park" && v.why).toContain("no no-mistakes record");
  });

  test("assumption: a q196-shaped question asked with the worker's own --reserved parks", () => {
    expect(autonomyVerdict(q196({ reserved_reason: "the user owns secrets", reserved_class: null }), live, CRED, facts)).toMatchObject({ action: "park", klass: null });
  });

  test("assumption: a sensitive task's q196-shaped question parks", () => {
    expect(autonomyVerdict(q196(), { ...live, sensitive: 1 }, CRED, facts)).toMatchObject({ action: "park", why: "a sensitive task's question" });
  });

  test("a q154-shaped security question is not covered: it parks", () => {
    const v = autonomyVerdict(q154(), live, CRED, facts);
    expect(v.action === "park" && v.why).toContain("does not cover security");
  });

  test("rotating the API key parks, even recommended as a fix", () => {
    const d = decision({
      question: "no-mistakes review finding key-age (warning, src/deploy.ts): the deploy key is old.",
      options: JSON.stringify(["rotate-key", "approve"]),
      recommendation: "rotate-key",
      reserved_class: "credential",
      reserved_reason: "credential",
      nm_record: review("The API key used by the deploy script is two years old; rotate the API key.", { file: "src/deploy.ts" }),
    });
    for (const cfg of [CRED, WIDE]) {
      const v = autonomyVerdict(d, live, cfg, facts);
      expect(v.action === "park" && v.why).toContain("real credential action");
    }
  });

  test("assumption: an approve on a finding that unsets credentials (q91-shaped) parks; a fix of it is decided", () => {
    const base = { question: "no-mistakes review finding workers-config-dir-now-unsets-credentials (warning, src/config/workers.ts): the diff changes behaviour.", reserved_class: "credential", reserved_reason: "credential", nm_record: review("Intent conformance: the diff unsets credentials for a home that has no [accounts].") };
    const approve = autonomyVerdict(decision({ ...base, recommendation: "approve" }), live, CRED, facts);
    expect(approve.action === "park" && approve.why).toContain("touches credentials");
    expect(autonomyVerdict(decision({ ...base, recommendation: "fix" }), live, CRED, facts)).toMatchObject({ action: "decide", choice: "fix" });
  });

  test("an approve on a finding filed under secrets parks", () => {
    const v = autonomyVerdict(q196({ nm_record: record("review", [finding({ category: "secrets" })]) }), live, CRED, facts);
    expect(v.action === "park" && v.why).toContain("secrets finding");
  });

  test("error, outside the diff, no file, no severity, a ci gate, no ask-user finding and a secrets file each park", () => {
    const cases: [string, string][] = [
      [record("test", [finding({ severity: "error" })]), "is an error"],
      [record("test", [finding({ cls: "outside" })]), "outside the branch's diff"],
      [record("test", [finding({ file: "", cls: "none" })]), "outside the branch's diff"],
      [record("test", [finding({ severity: "" })]), "no severity"],
      [record("ci", [finding()]), "a ci gate"],
      [record("test", [finding({ action: "auto-fix" })]), "no ask-user finding"],
      [record("test", [finding({ file: ".env.local", cls: "added" })]), "secrets file"],
    ];
    for (const [nm, why] of cases) {
      const v = autonomyVerdict(q196({ nm_record: nm }), live, CRED, facts);
      expect({ nm, why: v.action === "park" ? v.why : v.action }).toEqual({ nm, why: expect.stringContaining(why) });
    }
  });

  test("a skip recommendation parks", () => {
    const v = autonomyVerdict(q196({ recommendation: "skip" }), live, CRED, facts);
    expect(v.action === "park" && v.why).toContain("skips it");
  });

  test("a protected question with no recommendation still parks", () => {
    const v = autonomyVerdict(q196({ recommendation: null }), live, CRED, facts);
    expect(v.action === "park" && v.why).toContain("no recommendation");
  });

  test("a malformed or truncated record parks", () => {
    for (const nm of ["{not json", JSON.stringify({ v: 2, step: "test", findings: [] }), JSON.stringify({ v: 1, step: "test", findings: [{ id: 1 }] }), JSON.stringify({ v: 1, step: "test", findings: [], truncated: true })]) {
      const v = autonomyVerdict(q196({ nm_record: nm }), live, CRED, facts);
      expect(v.action === "park" && v.why).toContain("could not be read");
    }
  });

  test("assumption: credential plus another class parks under credential (the mode must cover every class)", () => {
    const d = q196({ question: `${Q196_TEXT} Also drop the stale snapshot.` });
    expect(keywordClasses(d.question)).toEqual(["destructive", "credential"]);
    const v = autonomyVerdict(d, live, CRED, facts);
    expect(v.action === "park" && v.why).toContain("does not cover destructive");
    expect(autonomyVerdict(d, live, WIDE, facts)).toMatchObject({ action: "decide", rule: "finding-by-answer", classes: ["credential", "destructive"] });
  });
});

describe("the all-five option, by the answer", () => {
  test("assumption: q154-shaped (the worker's own 'does not weaken') is decided", () => {
    expect(autonomyVerdict(q154(), live, WIDE, facts)).toEqual({ action: "decide", choice: "serial", rule: "finding-by-answer", classes: ["security"] });
  });

  test("remove-it and drop-from-init misfires are decided", () => {
    const remove = decision({ question: "no-mistakes review finding F1 (ask-user): the flaggedNow branch of harnessRefusal is unreachable; remove it?", options: JSON.stringify(["remove-it", "keep-it"]), recommendation: "remove-it", reserved_class: "destructive", reserved_reason: "destructive", nm_record: review("The branch is unreachable in production; delete the dead code.") });
    expect(autonomyVerdict(remove, live, WIDE, facts)).toMatchObject({ action: "decide", choice: "remove-it" });
    const drop = decision({ question: "no-mistakes document finding init-writes-retired-cap: drop it from init?", options: JSON.stringify(["drop-from-init", "keep"]), recommendation: "drop-from-init", reserved_class: "destructive", reserved_reason: "destructive", nm_record: review("init still writes a retired key.", { severity: "info" }) });
    expect(autonomyVerdict(drop, live, WIDE, facts)).toMatchObject({ action: "decide", choice: "drop-from-init" });
  });

  test("an approve on a finding filed under security parks", () => {
    const d = decision({ ...q154(), recommendation: "approve", nm_record: record("review", [finding({ category: "security" })]) });
    const v = autonomyVerdict(d, live, WIDE, facts);
    expect(v.action === "park" && v.why).toContain("security finding");
  });

  test("assumption: real actions park: drop the users table, force-push, npm publish, disable TLS", () => {
    const real: [string, string][] = [
      ["Fix: drop the users table and recreate it.", "destructive"],
      ["Fix it by a force-push of the branch.", "irreversible"],
      ["Then run npm publish for the fix.", "outward"],
      ["Fix: disable TLS verification in the client.", "security"],
    ];
    for (const [text, klass] of real) {
      const d = decision({ question: `no-mistakes review finding review-1 (warning, src/a.ts): ${text}`, recommendation: "fix", nm_record: review("A finding.", { file: "src/a.ts" }) });
      const v = autonomyVerdict(d, live, WIDE, facts);
      expect({ text, why: v.action === "park" ? v.why : v.action }).toEqual({ text, why: expect.stringContaining(`real ${klass} action`) });
    }
  });

  test("a real action in no-mistakes' own finding text parks too", () => {
    const d = decision({ question: "no-mistakes review finding review-1: one finding.", reserved_class: "destructive", reserved_reason: "destructive", recommendation: "fix", nm_record: review("Fix by running rm -rf on the cache dir.") });
    const v = autonomyVerdict(d, live, WIDE, facts);
    expect(v.action === "park" && v.why).toContain("real destructive action");
  });
});

describe("off, the setting and the record", () => {
  test("assumption: with the setting off every fixture parks as today, with today's reasons", () => {
    expect(autonomyVerdict(q196(), live, OFF, facts)).toEqual({ action: "park", why: "a credential question", klass: "credential" });
    expect(autonomyVerdict(q154(), live, OFF, facts)).toEqual({ action: "park", why: "a security question", klass: "security" });
    expect(autonomyVerdict(decision({ question: "Rotate the API key now?" }), live, OFF, facts)).toEqual({ action: "park", why: "its wording names a credential step", klass: "credential" });
  });

  test("unattended_findings takes off, credential or by-answer; anything else is config_invalid", () => {
    expect(OFF.unattended_findings).toBe("off");
    expect(CRED.unattended_findings).toBe("credential");
    expect(WIDE.unattended_findings).toBe("by-answer");
    for (const bad of ['"yes"', "true", '["credential"]', '"Credential"']) {
      let code = "ok";
      try {
        config(`[decisions]\nunattended_findings = ${bad}\n`);
      } catch (error) {
        code = error instanceof FlowrynError ? error.code : "other";
      }
      expect({ bad, code }).toEqual({ bad, code: "config_invalid" });
    }
  });

  test("keywordClasses names every class, in reservedReason's order", () => {
    expect(keywordClasses("rotate the token, publish it, then force-push and delete")).toEqual(["irreversible", "destructive", "credential", "outward"]);
    expect(keywordClasses("which cache layout")).toEqual([]);
  });

  test("answerKind reads the recommended label", () => {
    expect(["skip", "skip-it", "ignore", "waive_it", "defer"].map(answerKind)).toEqual(["skip", "skip", "skip", "skip", "skip"]);
    expect(["approve", "keep-cap", "accept-false-p1", "approve-as-is", "tolerate"].map(answerKind)).toEqual(["approve", "approve", "approve", "approve", "approve"]);
    expect(["fix", "serial", "remove-it", "record-on-plain-cleanup"].map(answerKind)).toEqual(["fix", "fix", "fix", "fix"]);
  });

  test("the stored record is sanitized and capped; an oversized one exempts nothing", () => {
    const one = nmRecordJson("test", [{ id: "t-1", action: "ask-user", description: "a\u001b[31m b\nc", category: "", severity: "warning", file: "a.ts", line: "1", cls: "added" }]);
    const parsed = parseNmRecord(one)!;
    expect(parsed.findings[0]!.description).toBe("a b c");
    expect(parsed.findings[0]).not.toHaveProperty("line");
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `t-${i}`, action: "ask-user", description: "d", category: "", severity: "warning", file: "a.ts", line: "", cls: "added" as const }));
    const big = nmRecordJson("test", many);
    expect(parseNmRecord(big)!.truncated).toBe(true);
    expect(exemptFinding({ mode: "credential", classes: ["credential"], record: big, choice: "approve", texts: [] })).toEqual({ exempt: false, why: "its no-mistakes record could not be read" });
  });
});
