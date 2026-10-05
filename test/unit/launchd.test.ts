import { describe, expect, test } from "bun:test";
import { type LaunchdDeps, type LaunchctlResult, loadAgent, unloadAgent } from "../../src/service/launchd.ts";

const LABEL = "dev.flowryn.flowrynd.test";
const PLIST = "/tmp/dev.flowryn.flowrynd.test.plist";
const IO_ERROR: LaunchctlResult = { exitCode: 5, output: "Bootstrap failed: 5: Input/output error" };

/**
 * A scripted launchd: bootout leaves the agent loaded for `unloadAfterPrints`
 * more `print` calls (bootout is asynchronous), and bootstrap answers from
 * `bootstrapReplies` in order, failing while the agent is still loaded.
 */
function fakeLaunchd(opts: { loaded: boolean; unloadAfterPrints?: number; bootstrapReplies?: LaunchctlResult[] }) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let loaded = opts.loaded;
  let printsUntilUnloaded: number | null = null;
  const replies = [...(opts.bootstrapReplies ?? [])];
  const deps: LaunchdDeps = {
    async launchctl(args) {
      const verb = args[0]!;
      calls.push(verb);
      if (verb === "print") {
        if (printsUntilUnloaded !== null) {
          if (printsUntilUnloaded <= 0) {
            loaded = false;
            printsUntilUnloaded = null;
          } else printsUntilUnloaded--;
        }
        return loaded ? { exitCode: 0, output: "state = running" } : { exitCode: 113, output: "Could not find service" };
      }
      if (verb === "bootout") {
        printsUntilUnloaded = opts.unloadAfterPrints ?? 0;
        return { exitCode: 0, output: "" };
      }
      if (verb === "bootstrap") {
        const reply = replies.shift() ?? (loaded ? IO_ERROR : { exitCode: 0, output: "" });
        if (reply.exitCode === 0) loaded = true;
        return reply;
      }
      throw new Error(`unexpected launchctl ${verb}`);
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    unloadTimeoutMs: 1_000,
    unloadPollMs: 100,
    bootstrapBackoffMs: [250, 500, 1_000],
  };
  return { deps, calls, sleeps, isLoaded: () => loaded };
}

describe("launchd agent loading", () => {
  test("unloadAgent polls print until the asynchronous bootout has finished", async () => {
    const fake = fakeLaunchd({ loaded: true, unloadAfterPrints: 3 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(true);
    expect(fake.calls).toEqual(["bootout", "print", "print", "print", "print"]);
    expect(fake.sleeps).toEqual([100, 100, 100]);
  });

  test("unloadAgent gives up at the timeout and reports the agent still loaded", async () => {
    const fake = fakeLaunchd({ loaded: true, unloadAfterPrints: 1_000 });
    expect(await unloadAgent(LABEL, fake.deps)).toBe(false);
    expect(fake.sleeps.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  test("a reinstall waits for the old agent to unload before bootstrapping", async () => {
    const fake = fakeLaunchd({ loaded: true, unloadAfterPrints: 2 });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls.filter((c) => c === "bootstrap")).toHaveLength(1);
    expect(fake.calls.indexOf("bootstrap")).toBeGreaterThan(fake.calls.lastIndexOf("print"));
    expect(fake.isLoaded()).toBe(true);
  });

  test("install right after uninstall retries bootstrap with a bounded backoff", async () => {
    const fake = fakeLaunchd({ loaded: false, bootstrapReplies: [IO_ERROR, IO_ERROR] });
    await loadAgent(LABEL, PLIST, fake.deps);
    expect(fake.calls.filter((c) => c === "bootstrap")).toHaveLength(3);
    expect(fake.sleeps).toEqual([250, 500]);
    expect(fake.isLoaded()).toBe(true);
  });

  test("a bootstrap that never succeeds fails with a clear error after every retry", async () => {
    const fake = fakeLaunchd({ loaded: false, bootstrapReplies: [IO_ERROR, IO_ERROR, IO_ERROR, IO_ERROR] });
    const failure = loadAgent(LABEL, PLIST, fake.deps);
    await expect(failure).rejects.toThrow(/failed after 4 attempts \(exit 5: Bootstrap failed: 5: Input\/output error\)/);
    await expect(failure).rejects.toThrow(/plutil -lint/);
    expect(fake.sleeps).toEqual([250, 500, 1_000]);
  });

  test("the error names a previous agent that never unloaded", async () => {
    const fake = fakeLaunchd({ loaded: true, unloadAfterPrints: 1_000 });
    await expect(loadAgent(LABEL, PLIST, fake.deps)).rejects.toThrow(/previous agent dev\.flowryn\.flowrynd\.test is still loaded/);
    expect(fake.calls.filter((c) => c === "bootstrap")).toHaveLength(4);
  });
});
