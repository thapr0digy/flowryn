import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchdDeps, type LaunchctlResult, agentPid, bootstrapDomain, kickstart, launchdDomain, loadAgent, renderPlist, servicePlist, unloadAgent } from "../../src/service/launchd.ts";
import { processTypeCheck } from "../../src/doctor/doctor.ts";

const LABEL = "dev.flowryn.flowrynd.test";
const PLIST = "/tmp/dev.flowryn.flowrynd.test.plist";
const UID = process.getuid!();
const GUI = `gui/${UID}`;
const USER = `user/${UID}`;
const IO_ERROR: LaunchctlResult = { exitCode: 5, output: "Bootstrap failed: 5: Input/output error" };
const NO_DOMAIN: LaunchctlResult = { exitCode: 125, output: "Could not print domain: 125: Domain does not support specified action" };

const domainOf = (target: string) => target.split("/").slice(0, 2).join("/");

/**
 * A scripted launchd. `desktop` says whether gui/<uid> exists (it does not
 * when the Mac has no desktop login); `loadedIn` is the domain (or domains)
 * the agent is loaded in, and `runningIn` the ones whose copy reports a pid
 * (every loaded copy by default). bootout leaves a copy loaded for
 * `unloadAfterPrints` more prints of it (bootout is asynchronous), and
 * bootstrap answers from `bootstrapReplies` in order, failing while a copy is
 * still loaded and with 125 in a domain that does not exist.
 */
function fakeLaunchd(opts: { loadedIn: string | string[] | null; runningIn?: string[]; desktop?: boolean; unloadAfterPrints?: number; bootstrapReplies?: LaunchctlResult[] }) {
  const desktop = opts.desktop ?? true;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const loaded = new Map<string, number | null>([opts.loadedIn ?? []].flat().map((domain) => [domain, null]));
  const running = (domain: string) => opts.runningIn?.includes(domain) ?? true;
  const replies = [...(opts.bootstrapReplies ?? [])];
  const exists = (domain: string) => domain === USER || (domain === GUI && desktop);
  const deps: LaunchdDeps = {
    async launchctl(args) {
      const [verb, target = ""] = args;
      calls.push(args.join(" "));
      if (verb === "print" && target.split("/").length === 2) return exists(target) ? { exitCode: 0, output: `${target} = {}` } : NO_DOMAIN;
      const domain = domainOf(target);
      const agentHere = target === `${domain}/${LABEL}` && loaded.has(domain);
      if (verb === "print") {
        if (!agentHere) return { exitCode: 113, output: "Could not find service" };
        const left = loaded.get(domain)!;
        if (left !== null && left <= 0) {
          loaded.delete(domain);
          return { exitCode: 113, output: "Could not find service" };
        }
        if (left !== null) loaded.set(domain, left - 1);
        return { exitCode: 0, output: `${target} = {\n\tstate = ${running(domain) ? "running\n\tpid = 6421" : "not running"}\n}` };
      }
      if (verb === "bootout" || verb === "kickstart") {
        if (!agentHere) return { exitCode: 113, output: "Could not find service" };
        if (verb === "bootout") loaded.set(domain, opts.unloadAfterPrints ?? 0);
        return { exitCode: 0, output: "" };
      }
      if (verb === "bootstrap") {
        if (!exists(target)) return NO_DOMAIN;
        const reply = replies.shift() ?? (loaded.size > 0 ? IO_ERROR : { exitCode: 0, output: "" });
        if (reply.exitCode === 0) loaded.set(target, null);
        return reply;
      }
      throw new Error(`unexpected launchctl ${args.join(" ")}`);
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    unloadTimeoutMs: 1_000,
    unloadPollMs: 100,
    bootstrapBackoffMs: [250, 500, 1_000],
  };
  return { deps, calls, sleeps, loadedIn: () => [...loaded.keys()][0] ?? null, loadedDomains: () => [...loaded.keys()] };
}

/** The rendered plist as plutil reads it, the way launchd does (plutil ships with macOS). */
function parsedPlist(xml: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "launchd-"));
  try {
    const path = join(dir, "agent.plist");
    writeFileSync(path, xml);
    const converted = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", path]);
    expect(converted.exitCode).toBe(0);
    return JSON.parse(converted.stdout.toString()) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("launchd domain", () => {
  test("a bootstrap targets gui/<uid> while a desktop session exists, else user/<uid>", async () => {
    expect(await bootstrapDomain(fakeLaunchd({ loadedIn: null }).deps)).toBe(GUI);
    expect(await bootstrapDomain(fakeLaunchd({ loadedIn: null, desktop: false }).deps)).toBe(USER);
  });

  test("the agent is addressed in the domain it is loaded in, even when gui/<uid> exists", async () => {
    expect(await launchdDomain(LABEL, fakeLaunchd({ loadedIn: GUI }).deps)).toBe(GUI);
    expect(await launchdDomain(LABEL, fakeLaunchd({ loadedIn: USER, desktop: false }).deps)).toBe(USER);
    expect(await launchdDomain(LABEL, fakeLaunchd({ loadedIn: USER, desktop: true }).deps)).toBe(USER);
    expect(await launchdDomain(LABEL, fakeLaunchd({ loadedIn: null, desktop: false }).deps)).toBe(USER);
  });

  test("agentPid and kickstart find the agent in user/<uid> with no desktop session", async () => {
    const fake = fakeLaunchd({ loadedIn: USER, desktop: false });
    expect(await agentPid(LABEL, fake.deps)).toBe(6421);
    expect(await kickstart(LABEL, fake.deps)).toBe(true);
    expect(fake.calls).toContain(`kickstart ${USER}/${LABEL}`);
  });

  test("a load with no desktop session bootstraps into user/<uid>", async () => {
    const fake = fakeLaunchd({ loadedIn: null, desktop: false });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls).toContain(`bootstrap ${USER} ${PLIST}`);
    expect(fake.loadedIn()).toBe(USER);
  });

  test("a reload boots the agent out of user/<uid> where it was loaded", async () => {
    const fake = fakeLaunchd({ loadedIn: USER, desktop: false, unloadAfterPrints: 1 });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls).toContain(`bootout ${USER}/${LABEL}`);
    expect(fake.calls.filter((c) => c.startsWith("bootstrap"))).toEqual([`bootstrap ${USER} ${PLIST}`]);
    expect(fake.loadedIn()).toBe(USER);
  });

  // macOS only: plutil ships with macOS.
  test.skipIf(process.platform !== "darwin")("the plist names the Background session type only for user/<uid>, as Aqua and Background", () => {
    const spec = { label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" };
    expect(parsedPlist(renderPlist(spec, GUI))).not.toHaveProperty("LimitLoadToSessionType");
    expect(parsedPlist(renderPlist(spec))).not.toHaveProperty("LimitLoadToSessionType");
    expect(parsedPlist(renderPlist(spec, USER)).LimitLoadToSessionType).toEqual(["Aqua", "Background"]);
  });

  // macOS only: plutil ships with macOS.
  test.skipIf(process.platform !== "darwin")("the plist runs the daemon as ProcessType Interactive in every domain, so launchd does not throttle verify children", () => {
    const spec = { label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" };
    for (const domain of [GUI, USER, undefined]) expect(parsedPlist(renderPlist(spec, domain)).ProcessType).toBe("Interactive");
  });

  // macOS only: plutil ships with macOS.
  test.skipIf(process.platform !== "darwin")("the plist install writes and --print shows has the session types for the domain it bootstraps into", async () => {
    const spec = { label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" };
    expect(parsedPlist(await servicePlist(spec, fakeLaunchd({ loadedIn: null, desktop: false }).deps)).LimitLoadToSessionType).toEqual(["Aqua", "Background"]);
    expect(parsedPlist(await servicePlist(spec, fakeLaunchd({ loadedIn: null }).deps))).not.toHaveProperty("LimitLoadToSessionType");
  });

  test("with a copy in each domain, the running one is the agent addressed", async () => {
    const fake = fakeLaunchd({ loadedIn: [GUI, USER], runningIn: [USER] });
    expect(await agentPid(LABEL, fake.deps)).toBe(6421);
    expect(await launchdDomain(LABEL, fake.deps)).toBe(USER);
    expect(await kickstart(LABEL, fake.deps)).toBe(true);
    expect(fake.calls).toContain(`kickstart ${USER}/${LABEL}`);
  });

  test("with no copy running, the first loaded copy is addressed and reports no pid", async () => {
    const fake = fakeLaunchd({ loadedIn: [GUI, USER], runningIn: [] });
    expect(await agentPid(LABEL, fake.deps)).toBeNull();
    expect(await launchdDomain(LABEL, fake.deps)).toBe(GUI);
  });

  test("unloadAgent boots the agent out of both domains and waits for both", async () => {
    const fake = fakeLaunchd({ loadedIn: [GUI, USER], unloadAfterPrints: 2 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith("bootout"))).toEqual([`bootout ${GUI}/${LABEL}`, `bootout ${USER}/${LABEL}`]);
    expect(fake.loadedDomains()).toEqual([]);
  });

  test("unloadAgent keeps waiting while one domain's copy is still loaded", async () => {
    const fake = fakeLaunchd({ loadedIn: [GUI, USER], unloadAfterPrints: 1_000 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(false);
  });

  // macOS only: plutil ships with macOS.
  test.skipIf(process.platform !== "darwin")("the gui/<uid> and user/<uid> plists pass plutil -lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchd-"));
    try {
      const path = join(dir, "agent.plist");
      for (const domain of [GUI, USER]) {
        writeFileSync(path, renderPlist({ label: LABEL, program: ["/d/flowryn"], env: {}, logDir: "/l", workingDir: "/w" }, domain));
        expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", path]).exitCode).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor launchd throttle check", () => {
  test("warns with the reinstall hint when the plist names no ProcessType or another one", async () => {
    const missing = await processTypeCheck("/a.plist", async () => ({ processType: null }));
    expect(missing).toMatchObject({ check: "launchd throttle", status: "warn" });
    expect(missing.detail).toContain("has no ProcessType");
    expect(missing.detail).toContain("reinstall to apply: flowryn daemon install");
    expect((await processTypeCheck("/a.plist", async () => ({ processType: "Background" }))).detail).toContain("has ProcessType Background");
    expect(await processTypeCheck("/a.plist", async () => ({ processType: "Interactive" }))).toMatchObject({ status: "ok" });
  });

  test("an unreadable plist warns with the read error", async () => {
    const check = await processTypeCheck("/a.plist", async () => {
      throw new Error("plutil could not read /a.plist");
    });
    expect(check).toEqual({ check: "launchd throttle", status: "warn", detail: "plutil could not read /a.plist" });
  });

  // macOS only: the check reads the plist through plutil, which ships with macOS.
  test.skipIf(process.platform !== "darwin")("a plist written before ProcessType warns; the one install writes now passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launchd-"));
    try {
      const path = join(dir, "agent.plist");
      const current = renderPlist({ label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" }, GUI);
      writeFileSync(path, current.replace(/\n  <key>ProcessType<\/key>\n  <string>Interactive<\/string>/, ""));
      const old = await processTypeCheck(path);
      expect(old.status).toBe("warn");
      expect(old.detail).toContain("reinstall to apply");
      writeFileSync(path, current);
      expect(await processTypeCheck(path)).toMatchObject({ status: "ok", detail: "ProcessType Interactive" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launchd agent loading", () => {
  test("unloadAgent polls print until the asynchronous bootout has finished", async () => {
    const fake = fakeLaunchd({ loadedIn: GUI, unloadAfterPrints: 3 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(true);
    const agent = `${GUI}/${LABEL}`;
    expect(fake.calls).toEqual([`print ${agent}`, `print ${USER}/${LABEL}`, `bootout ${agent}`, ...Array(4).fill(`print ${agent}`)]);
    expect(fake.sleeps).toEqual([100, 100, 100]);
  });

  test("unloadAgent gives up at the timeout and reports the agent still loaded", async () => {
    const fake = fakeLaunchd({ loadedIn: GUI, unloadAfterPrints: 1_000 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(false);
    expect(fake.sleeps.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  test("a reinstall waits for the old agent to unload before bootstrapping", async () => {
    const fake = fakeLaunchd({ loadedIn: GUI, unloadAfterPrints: 2 });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(1);
    expect(fake.calls.findIndex((c) => c.startsWith("bootstrap"))).toBeGreaterThan(fake.calls.findLastIndex((c) => c === `print ${GUI}/${LABEL}`));
    expect(fake.loadedIn()).toBe(GUI);
  });

  test("install right after uninstall retries bootstrap with a bounded backoff", async () => {
    const fake = fakeLaunchd({ loadedIn: null, bootstrapReplies: [IO_ERROR, IO_ERROR] });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(3);
    expect(fake.sleeps).toEqual([250, 500]);
    expect(fake.loadedIn()).toBe(GUI);
  });

  test("a bootstrap that never succeeds fails with a clear error after every retry", async () => {
    const fake = fakeLaunchd({ loadedIn: null, bootstrapReplies: [IO_ERROR, IO_ERROR, IO_ERROR, IO_ERROR] });
    const failure = loadAgent(LABEL, PLIST, fake.deps);
    await expect(failure).rejects.toThrow(/failed after 4 attempts \(exit 5: Bootstrap failed: 5: Input\/output error\)/);
    await expect(failure).rejects.toThrow(/plutil -lint/);
    expect(fake.sleeps).toEqual([250, 500, 1_000]);
  });

  test("a failed bootstrap into user/<uid> names the Background session type the plist needs", async () => {
    const fake = fakeLaunchd({ loadedIn: null, desktop: false, bootstrapReplies: Array.from({ length: 4 }, () => ({ exitCode: 134, output: "Bootstrap failed: 134: Service cannot load in requested session" })) });
    await expect(loadAgent(LABEL, PLIST, fake.deps)).rejects.toThrow(/bootstrap user\/\d+ .*LimitLoadToSessionType Background/);
  });

  test("the error names a previous agent that never unloaded", async () => {
    const fake = fakeLaunchd({ loadedIn: GUI, unloadAfterPrints: 1_000 });
    await expect(loadAgent(LABEL, PLIST, fake.deps)).rejects.toThrow(/previous agent dev\.flowryn\.flowrynd\.test is still loaded/);
    expect(fake.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(4);
  });
});
