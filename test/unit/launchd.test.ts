import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchdDeps, type LaunchctlResult, agentPid, bootstrapDomain, kickstart, launchdDomain, loadAgent, renderPlist, unloadAgent } from "../../src/service/launchd.ts";

const LABEL = "dev.flowryn.flowrynd.test";
const PLIST = "/tmp/dev.flowryn.flowrynd.test.plist";
const UID = process.getuid!();
const GUI = `gui/${UID}`;
const USER = `user/${UID}`;
const IO_ERROR: LaunchctlResult = { exitCode: 5, output: "Bootstrap failed: 5: Input/output error" };
const NO_DOMAIN: LaunchctlResult = { exitCode: 125, output: "Could not print domain: 125: Domain does not support specified action" };

/**
 * A scripted launchd. `desktop` says whether gui/<uid> exists (it does not
 * when the Mac has no desktop login); `loadedIn` is the domain the agent is
 * loaded in, or null. bootout leaves the agent loaded for `unloadAfterPrints`
 * more prints of it (bootout is asynchronous), and bootstrap answers from
 * `bootstrapReplies` in order, failing while the agent is still loaded and
 * with 125 in a domain that does not exist.
 */
function fakeLaunchd(opts: { loadedIn: string | null; desktop?: boolean; unloadAfterPrints?: number; bootstrapReplies?: LaunchctlResult[] }) {
  const desktop = opts.desktop ?? true;
  const calls: string[] = [];
  const sleeps: number[] = [];
  let loadedIn = opts.loadedIn;
  let printsUntilUnloaded: number | null = null;
  const replies = [...(opts.bootstrapReplies ?? [])];
  const exists = (domain: string) => domain === USER || (domain === GUI && desktop);
  const deps: LaunchdDeps = {
    async launchctl(args) {
      const [verb, target = ""] = args;
      calls.push(args.join(" "));
      if (verb === "print" && target.split("/").length === 2) return exists(target) ? { exitCode: 0, output: `${target} = {}` } : NO_DOMAIN;
      if (verb === "print") {
        if (target === `${loadedIn}/${LABEL}` && printsUntilUnloaded !== null) {
          if (printsUntilUnloaded <= 0) {
            loadedIn = null;
            printsUntilUnloaded = null;
          } else printsUntilUnloaded--;
        }
        return target === `${loadedIn}/${LABEL}` ? { exitCode: 0, output: `${target} = {\n\tstate = running\n\tpid = 6421\n}` } : { exitCode: 113, output: "Could not find service" };
      }
      if (verb === "bootout" || verb === "kickstart") {
        if (target !== `${loadedIn}/${LABEL}`) return { exitCode: 113, output: "Could not find service" };
        if (verb === "bootout") printsUntilUnloaded = opts.unloadAfterPrints ?? 0;
        return { exitCode: 0, output: "" };
      }
      if (verb === "bootstrap") {
        if (!exists(target)) return NO_DOMAIN;
        const reply = replies.shift() ?? (loadedIn ? IO_ERROR : { exitCode: 0, output: "" });
        if (reply.exitCode === 0) loadedIn = target;
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
  return { deps, calls, sleeps, loadedIn: () => loadedIn };
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

  test("the plist names the Background session type only for user/<uid>, as Aqua and Background", () => {
    const spec = { label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" };
    expect(renderPlist(spec, GUI)).not.toContain("LimitLoadToSessionType");
    expect(renderPlist(spec)).not.toContain("LimitLoadToSessionType");
    expect(renderPlist(spec, USER)).toContain("<key>LimitLoadToSessionType</key>\n  <array>\n    <string>Aqua</string>\n    <string>Background</string>\n  </array>");
  });

  // macOS only: plutil ships with macOS.
  test.skipIf(process.platform !== "darwin")("the user/<uid> plist passes plutil -lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchd-"));
    try {
      const path = join(dir, "agent.plist");
      writeFileSync(path, renderPlist({ label: LABEL, program: ["/d/flowryn"], env: {}, logDir: "/l", workingDir: "/w" }, USER));
      expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", path]).exitCode).toBe(0);
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
    expect(fake.calls).toEqual([`print ${agent}`, `bootout ${agent}`, ...Array(4).fill(`print ${agent}`)]);
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
