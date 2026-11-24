import { describe, expect, test } from "bun:test";
import { ETA_BASIS, median, queueEtas, verifyProgress } from "../../src/dashboard/eta.ts";
import type { VerifyStep } from "../../src/verify/store.ts";

/** The dashboard's estimates (docs/notes/2026-11-24-a-live-build-t8.md): plain arithmetic, each rule its own case. */

const MIN = 60_000;
const NOW = 100 * MIN;

function step(name: string, state: VerifyStep["state"], group: number | undefined, extra: Partial<VerifyStep> = {}): VerifyStep {
  return { name, state, exit: null, ms: null, log: `${name}.log`, tests: null, detail: null, ...(group === undefined ? {} : { group }), ...extra };
}

const USUAL: Record<string, number> = { install: MIN, lint: 2 * MIN, types: 3 * MIN, test: 10 * MIN, docs: MIN };
const usual = (name: string) => USUAL[name] ?? null;

describe("median", () => {
  test("odd, even, one and none", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
});

describe("verifyProgress", () => {
  test("a running step under its usual time leaves the rest of it, plus each later group's usual", () => {
    const p = verifyProgress(
      { started_at: NOW - 10 * MIN, steps: [step("install", "passed", 0, { ms: MIN }), step("test", "running", 1, { started_at: NOW - 4 * MIN }), step("docs", "waiting", 2)] },
      usual,
      NOW,
    );
    expect(p.eta).toEqual({ left_ms: 6 * MIN + MIN, basis: ETA_BASIS, over_ms: 0 });
    expect(p.current).toEqual(["test"]);
    expect(p.steps[1]).toMatchObject({ elapsed_ms: 4 * MIN, usual_ms: 10 * MIN, approx: false });
  });

  test("a step past its usual time adds nothing and shows how far over it is", () => {
    const p = verifyProgress({ started_at: NOW - 20 * MIN, steps: [step("test", "running", 0, { started_at: NOW - 13 * MIN }), step("docs", "waiting", 1)] }, usual, NOW);
    expect(p.eta).toMatchObject({ left_ms: MIN, over_ms: 3 * MIN });
  });

  test("a later group counts its longest step; steps of one group run at once", () => {
    const p = verifyProgress(
      { started_at: NOW, steps: [step("install", "running", 0, { started_at: NOW }), step("lint", "waiting", 1), step("types", "waiting", 1), step("docs", "waiting", 2)] },
      usual,
      NOW,
    );
    expect(p.eta?.left_ms).toBe(MIN + 3 * MIN + MIN);
  });

  test("an unfinished step with no history gives no estimate and names it", () => {
    const p = verifyProgress({ started_at: NOW, steps: [step("install", "running", 0, { started_at: NOW }), step("e2e", "waiting", 1)] }, usual, NOW);
    expect(p.eta).toBeNull();
    expect(p.eta_why).toBe("no history for e2e");
  });

  test("a finished step without history does not block the estimate; skipped and passed steps count nothing", () => {
    const p = verifyProgress(
      { started_at: NOW - MIN, steps: [step("e2e", "passed", 0, { ms: MIN }), step("lint", "skipped", 1, { ms: 0 }), step("docs", "waiting", 2)] },
      usual,
      NOW,
    );
    expect(p.eta?.left_ms).toBe(MIN);
  });

  test("a running step from before steps recorded their start: its group's start, marked approximate", () => {
    const p = verifyProgress({ started_at: NOW - 10 * MIN, steps: [step("install", "passed", 0, { ms: 2 * MIN }), step("test", "running", 1)] }, usual, NOW);
    expect(p.steps[1]).toMatchObject({ elapsed_ms: 8 * MIN, approx: true });
    expect(p.eta?.left_ms).toBe(2 * MIN);
  });

  test("rows from before groups: each step is its own group, in order", () => {
    const p = verifyProgress({ started_at: NOW, steps: [step("install", "running", undefined, { started_at: NOW }), step("lint", "waiting", undefined), step("docs", "waiting", undefined)] }, usual, NOW);
    expect(p.eta?.left_ms).toBe(MIN + 2 * MIN + MIN);
  });
});

describe("queueEtas", () => {
  const typical = (project: string) => (project === "new" ? null : 10 * MIN);

  test("each request takes the earliest free slot for its project's typical verify", () => {
    const etas = queueEtas([4 * MIN, 7 * MIN], [{ id: "vq1", project: "web", held: null }, { id: "vq2", project: "web", held: null }, { id: "vq3", project: "web", held: null }], typical);
    expect(etas.get("vq1")).toEqual({ starts_in_ms: 4 * MIN, done_in_ms: 14 * MIN });
    expect(etas.get("vq2")).toEqual({ starts_in_ms: 7 * MIN, done_in_ms: 17 * MIN });
    expect(etas.get("vq3")).toEqual({ starts_in_ms: 14 * MIN, done_in_ms: 24 * MIN });
  });

  test("a held request steps aside with its reason and takes no slot", () => {
    const etas = queueEtas([0], [{ id: "vq1", project: "web", held: "waits on its own PR" }, { id: "vq2", project: "web", held: null }], typical);
    expect(etas.get("vq1")).toEqual({ starts_in_ms: null, why: "waits on its own PR" });
    expect(etas.get("vq2")).toEqual({ starts_in_ms: 0, done_in_ms: 10 * MIN });
  });

  test("a request without history ends the estimates behind it", () => {
    const etas = queueEtas([0], [{ id: "vq1", project: "new", held: null }, { id: "vq2", project: "web", held: null }], typical);
    expect(etas.get("vq1")).toEqual({ starts_in_ms: null, why: "new has no passed verify yet" });
    expect(etas.get("vq2")).toEqual({ starts_in_ms: null, why: "vq1 ahead has no estimate" });
  });

  test("a running verify without an estimate: a free slot still starts now, the next has no estimate", () => {
    const etas = queueEtas([null, 0], [{ id: "vq1", project: "web", held: null }, { id: "vq2", project: "web", held: null }], typical);
    expect(etas.get("vq1")).toEqual({ starts_in_ms: 0, done_in_ms: 10 * MIN });
    expect(etas.get("vq2")).toEqual({ starts_in_ms: null, why: "a running verify has no estimate" });
    expect(queueEtas([null], [{ id: "vq1", project: "web", held: null }], typical).get("vq1")).toEqual({ starts_in_ms: null, why: "a running verify has no estimate" });
  });

  test("no slot listed counts as one free slot", () => {
    expect(queueEtas([], [{ id: "vq1", project: "web", held: null }], typical).get("vq1")).toEqual({ starts_in_ms: 0, done_in_ms: 10 * MIN });
  });
});
