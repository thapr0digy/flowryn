import { describe, expect, test } from "bun:test";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * `bun test` pins the test file's own JS context's clock to UTC, independent
 * of the real system timezone, while a daemon or CLI the tests spawn via
 * `Bun.spawn` runs in the box's real local timezone unless something sets
 * `TZ`. In the evening window where the UTC calendar day has already rolled
 * over but the local one hasn't, that split makes a test's "yesterday" equal
 * a spawned process's real "today" (test/integration/leader-cli.test.ts's
 * overdue-item case). Both sides must agree on UTC so the split can't happen
 * on any machine, at any hour.
 */
describe("spawned test processes agree with bun test's own UTC clock", () => {
  test("this test process itself resolves to UTC", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  });

  test("a process spawned through the harness's standard env also resolves to UTC", async () => {
    let h: TestHome | null = null;
    try {
      h = makeHome();
      const proc = Bun.spawn(["bun", "-e", 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'], {
        env: h.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("UTC");
      if (stderr.trim()) throw new Error(`unexpected stderr: ${stderr}`);
    } finally {
      h?.cleanup();
    }
  });
});
