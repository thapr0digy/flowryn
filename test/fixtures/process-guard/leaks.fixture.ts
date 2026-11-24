/**
 * A test file that leaks on purpose (test/unit/process-guard.test.ts runs it in a bun test of its own):
 * a `sh -c` in its own process group whose real work is a grandchild, never killed by a teardown.
 * LEAK_PID_FILE gets the grandchild's pid once it runs; LEAK_HOLD_MS keeps the test running that long
 * afterwards, so the caller can kill the bun test process mid-test.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("starts a child and forgets it", async () => {
  const file = process.env.LEAK_PID_FILE;
  const record = file ? `echo $! > ${JSON.stringify(`${file}.tmp`)} && mv ${JSON.stringify(`${file}.tmp`)} ${JSON.stringify(file)};` : "";
  const child = Bun.spawn(["/bin/sh", "-c", `sleep ${process.env.LEAK_SECONDS ?? "30"} & ${record} wait`], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  expect(child.pid).toBeGreaterThan(0);
  if (file) while (!existsSync(file)) await Bun.sleep(20);
  await Bun.sleep(Number(process.env.LEAK_HOLD_MS ?? "0"));
}, 120_000);
