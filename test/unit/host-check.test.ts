import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHost, hostNeeds, judgeHost, parseMemFreeLevel, parsePressureSome, sampleHost, VM_READ_MS, vmCpuReading, type HostSample, type HostVerdict } from "../../src/sched/host.ts";

// The memory free level and Docker VM CPU pressure in the host check (docs/notes/2026-11-25-host-capacity-check-gs.md).
// Nothing here reads this machine's memory or a real Colima: samples are built by hand, and colima and the probe are stand-in scripts.

const dir = mkdtempSync(join(tmpdir(), "fw-host-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const HOST = { min_free_mem_gb: 8, max_load_per_core: 1.5, probe: null, pressure: true };

function sample(over: Partial<HostSample> = {}): HostSample {
  return { free_mem_gb: 20, load_per_core: 0.3, source: "probe", mem_free_pct: null, vm_cpu: null, notes: [], ...over };
}

const memFree = (mem_free_pct: number) => sample({ mem_free_pct });
const vm = (some_avg60: number | null, note: string | null = null) => sample({ vm_cpu: { some_avg60, at: 0, note } });

describe("readings", () => {
  test("sysctl kern.memorystatus_level is a percentage", () => {
    expect(parseMemFreeLevel("42\n")).toBe(42);
    expect(parseMemFreeLevel("kern.memorystatus_level: unknown")).toBeNull();
    expect(parseMemFreeLevel("142")).toBeNull();
  });

  test("the \"some\" avg60 of /proc/pressure/cpu, not avg10 or the \"full\" line", () => {
    expect(parsePressureSome("some avg10=7.18 avg60=21.50 avg300=16.18 total=653944570\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(21.5);
    expect(parsePressureSome("full avg10=0.00 avg60=40.00 avg300=0.00 total=0\n")).toBeNull();
  });
});

describe("memory free level", () => {
  test("under 20% free holds, and says so", () => {
    const verdict = judgeHost(memFree(15), HOST);
    expect(verdict).toMatchObject({ ok: false, holds: ["mem_free"], reason: "system-wide memory free 15%, under 20%" });
  });

  test("between 20% and 25% it keeps its last state", () => {
    const held = judgeHost(memFree(15), HOST);
    const inBand = memFree(22);
    expect(judgeHost(inBand, HOST, held)).toMatchObject({ ok: false, holds: ["mem_free"], reason: "system-wide memory free 22%, not yet over 25%" });
    expect(judgeHost(inBand, HOST, judgeHost(memFree(45), HOST))).toMatchObject({ ok: true, holds: [] });
    expect(judgeHost(inBand, HOST, null)).toMatchObject({ ok: true });
    expect(judgeHost(memFree(26), HOST, held)).toMatchObject({ ok: true, reason: "ok" });
  });

  test("45% free holds nothing, however full macOS's on-demand swap reads", () => {
    expect(judgeHost(memFree(45), HOST).ok).toBe(true);
  });

  test("pressure = false holds on neither the memory free level nor the VM", () => {
    const off = { ...HOST, pressure: false };
    expect(judgeHost(sample({ mem_free_pct: 5, vm_cpu: { some_avg60: 90, at: 0, note: null } }), off)).toMatchObject({ ok: true, holds: [] });
  });
});

describe("Docker VM CPU pressure", () => {
  test("some avg60 over 30% holds, and says so; one DB-heavy step's 28% does not", () => {
    expect(judgeHost(vm(31.25), HOST)).toMatchObject({ ok: false, holds: ["vm_cpu"], reason: "Docker VM CPU pressure 31.3% (some avg60), over 30%" });
    expect(judgeHost(vm(28), HOST).ok).toBe(true);
  });

  test("between 20% and 30% it keeps its last state", () => {
    const held = judgeHost(vm(35), HOST);
    expect(judgeHost(vm(25), HOST, held)).toMatchObject({ ok: false, reason: "Docker VM CPU pressure 25.0% (some avg60), not yet under 20%" });
    expect(judgeHost(vm(25), HOST, judgeHost(vm(5), HOST)).ok).toBe(true);
    expect(judgeHost(vm(19.9), HOST, held).ok).toBe(true);
  });

  test("a failed read passes, with the failure in the notes", async () => {
    const failing = script("colima-down", 'echo \'level=fatal msg="colima not running"\' >&2\nexit 1');
    const reading = await vmCpuReading(failing, null, 1_000);
    expect(reading.some_avg60).toBeNull();
    expect(reading.note).toContain("colima ssh exited 1");
    expect(reading.note).toContain("colima not running");
    expect(judgeHost(vm(null, reading.note), HOST).ok).toBe(true);
    expect((await vmCpuReading(null, null, 1_000)).note).toBe("Docker VM CPU pressure not read (no colima on PATH)");
    const garbled = await vmCpuReading(script("colima-garbled", "echo nothing"), null, 1_000);
    expect(garbled).toMatchObject({ some_avg60: null, note: 'Docker VM CPU pressure not read (no "some" line in /proc/pressure/cpu)' });
  });

  test("one read serves the checks for VM_READ_MS; the stand-in sees the argv a real colima would", async () => {
    const calls = join(dir, "calls");
    writeFileSync(calls, "");
    const colima = script("colima", `echo "$@" >> ${JSON.stringify(calls)}\necho 'some avg10=40.00 avg60=30.00 avg300=20.00 total=1'`);
    const first = await vmCpuReading(colima, null, 1_000);
    expect(first).toEqual({ some_avg60: 30, at: 1_000, note: null });
    expect(await vmCpuReading(colima, first, 1_000 + VM_READ_MS - 1)).toBe(first);
    expect((await vmCpuReading(colima, first, 1_000 + VM_READ_MS)).at).toBe(1_000 + VM_READ_MS);
    expect(readFileSync(calls, "utf8")).toBe("ssh -- cat /proc/pressure/cpu\n".repeat(2));
  });
});

describe("the probe and the stated needs", () => {
  test("a probe may report the memory free level and VM pressure; without them they hold nothing", async () => {
    const full = script("probe-full", `echo '{"free_mem_gb": 20, "load_per_core": 0.2, "mem_free_pct": 12, "vm_cpu_some_avg60": 40}'`);
    const verdict = await checkHost({ ...HOST, probe: full });
    expect(verdict.holds).toEqual(["mem_free", "vm_cpu"]);
    expect(verdict.reason).toBe("system-wide memory free 12%, under 20%; Docker VM CPU pressure 40.0% (some avg60), over 30%");
    const plain = script("probe-plain", `echo '{"free_mem_gb": 20, "load_per_core": 0.2}'`);
    expect(await sampleHost({ probe: plain, pressure: true })).toMatchObject({ mem_free_pct: null, vm_cpu: null, notes: [] });
    expect((await checkHost({ ...HOST, probe: full, pressure: false })).ok).toBe(true);
  });

  test("checkHost carries the last verdict's holds into the release levels", async () => {
    const band = script("probe-band", `echo '{"free_mem_gb": 20, "load_per_core": 0.2, "mem_free_pct": 22}'`);
    const held: HostVerdict = { ok: false, sample: null, reason: "mem_free", holds: ["mem_free"] };
    expect((await checkHost({ ...HOST, probe: band }, held)).holds).toEqual(["mem_free"]);
    expect((await checkHost({ ...HOST, probe: band }, null)).ok).toBe(true);
  });

  test("the needs name the memory free level and VM pressure only while pressure is on", () => {
    expect(hostNeeds(HOST)).toBe("8 GB free, load per core under 1.5, system-wide memory free over 20%, Docker VM CPU pressure under 30%");
    expect(hostNeeds({ ...HOST, pressure: false })).toBe("8 GB free, load per core under 1.5");
  });
});
