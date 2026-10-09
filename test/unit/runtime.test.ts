import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrError, type HerdrTransport } from "../../src/runtime/herdr/client.ts";
import { HerdrRuntime, eventPaneId } from "../../src/runtime/herdr/runtime.ts";
import { resolveHerdrSocket } from "../../src/runtime/herdr/socket.ts";
import { descendantCommands, isAlive, parseLstart, parseProcessTable, parsePsLine, readIdentity, readProcessTable, sameProcess, terminate, type PsRunner } from "../../src/runtime/proc.ts";
import { defaultConfig } from "../../src/config/config.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-rt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The process table after pid 4242 was reused by another executable. */
const reusedPid: PsRunner = async () => "  4242 Wed Sep 23 22:48:39 2026     /bin/other\n";

describe("process identity", () => {
  test("parses ps lstart in the C locale as local time", () => {
    const at = parseLstart("Wed Sep 23 22:53:49 2026");
    expect(at).toBe(new Date(2026, 8, 23, 22, 53, 49).getTime());
    expect(parseLstart("garbage")).toBeNull();
  });

  test("parses a ps line whose executable contains spaces", () => {
    const id = parsePsLine("  90891 Wed Sep 23 22:48:39 2026     /Applications/Pi Launcher.app/Contents/Resources/pi/pi");
    expect(id).toMatchObject({ pid: 90891, exe: "/Applications/Pi Launcher.app/Contents/Resources/pi/pi" });
  });

  test("reads this process from the real process table, and a reused pid is not the same process", async () => {
    const me = await readIdentity(process.pid);
    expect(me).not.toBeNull();
    expect(await isAlive(me!)).toBe(true);
    expect(sameProcess(me!, { ...me!, start: me!.start - 5_000 })).toBe(false);
    expect(await isAlive({ ...me!, exe: "not-this" })).toBe(false);
  });

  test("terminate never signals a process whose identity no longer matches", async () => {
    const sent: string[] = [];
    const result = await terminate({ pid: 4242, start: parseLstart("Wed Sep 23 22:48:39 2026")!, exe: "/bin/claude" }, { ps: reusedPid, kill: (pid, s) => sent.push(`${pid}:${s}`), graceMs: 10 });
    expect(result).toEqual({ ok: true, evidence: "absent", signal: "none" });
    expect(sent).toEqual([]);
  });

  test("terminate escalates to SIGKILL after the grace period, and signals the group when asked", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; sleep 30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(200);
    const identity = (await readIdentity(child.pid))!;
    const result = await terminate(identity, { graceMs: 300, pollMs: 50 });
    expect(result).toMatchObject({ ok: true, signal: "SIGKILL" });
    await child.exited;
  }, 10_000);
});

/** A one-shot Herdr socket: answers each request with `respond(method, params)`. */
async function fakeSocket(respond: (method: string, params: Record<string, unknown>) => Record<string, unknown>): Promise<{ path: string; seen: string[]; close(): void }> {
  const path = join(tempDir(), "h.sock");
  const seen: string[] = [];
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
      seen.push(request.method);
      conn.end(JSON.stringify({ id: request.id, ...respond(request.method, request.params) }) + "\n");
    });
  });
  await new Promise<void>((done) => server.listen(path, () => done()));
  return { path, seen, close: () => server.close() };
}

describe("process tree", () => {
  test("finds a command anywhere under the root, never the root's own or another tree's", () => {
    const rows = parseProcessTable(
      [
        "  100     1 /Applications/Pi Launcher.app/Contents/MacOS/pi-signed",
        "  101   100 node pi",
        "  102   101 /bin/bash -c perl -e 'sleep 60'",
        "  103   102 perl -e sleep 60",
        "  200     1 perl -e sleep 120",
        "garbage",
      ].join("\n"),
    );
    expect(rows).toHaveLength(5);
    expect(descendantCommands(rows, 100)).toEqual(["node pi", "/bin/bash -c perl -e 'sleep 60'", "perl -e sleep 60"]);
    expect(descendantCommands(rows, 100)).not.toContain("perl -e sleep 120");
    expect(descendantCommands(rows, 103)).toEqual([]);
  });

  test("reads the real table: this test's own child shows under its pid", async () => {
    const child = Bun.spawn(["sleep", "7"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      expect(descendantCommands(await readProcessTable(), process.pid)).toContain("sleep 7");
    } finally {
      child.kill();
    }
  });
});

describe("Herdr client", () => {
  test("refuses server and session lifecycle methods before sending anything", async () => {
    const sock = await fakeSocket(() => ({ result: {} }));
    const client = new HerdrClient(sock.path);
    for (const method of ["server.stop", "server.live_handoff", "server.reload_config", "worktree.remove"]) {
      await expect(client.call(method, {})).rejects.toMatchObject({ code: "method_refused" });
    }
    expect(sock.seen).toEqual([]);
    sock.close();
  });

  test("maps a Herdr error reply and an unreachable socket to HerdrError codes", async () => {
    const sock = await fakeSocket(() => ({ error: { code: "pane_not_found", message: "pane w9:p9 not found" } }));
    await expect(new HerdrClient(sock.path).call("pane.get", { pane_id: "w9:p9" })).rejects.toMatchObject({ code: "pane_not_found" });
    await expect(new HerdrClient(join(tempDir(), "absent.sock")).call("ping", {})).rejects.toMatchObject({ code: "unreachable" });
    sock.close();
  });
});

function scriptedTransport(replies: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>): HerdrTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call(method, params) {
      calls.push(method);
      const reply = replies[method];
      if (!reply) throw new HerdrError("unknown", method);
      return reply(params);
    },
    async subscribe() {
      return { close() {} };
    },
  };
}

describe("Herdr runtime", () => {
  test("agent.start retries while the fresh pane's shell is not ready", async () => {
    let attempts = 0;
    const transport = scriptedTransport({
      "agent.start": () => {
        attempts++;
        if (attempts < 3) throw new HerdrError("agent_pane_busy", "not an available shell");
        return { type: "agent_started" };
      },
    });
    await new HerdrRuntime(transport, { pollMs: 5 }).startAgent("w1:p2", { kind: "pi", name: "x", args: ["hi"] });
    expect(attempts).toBe(3);
  });

  test("the harness process is the foreground group leader that the adapter accepts, never the shell", async () => {
    let fg = 100;
    const transport = scriptedTransport({
      "pane.process_info": () => ({
        process_info: {
          pane_id: "w1:p2",
          shell_pid: 100,
          foreground_process_group_id: fg,
          foreground_processes: fg === 100 ? [{ pid: 100, name: "zsh", argv0: "-zsh", argv: ["-zsh"], cwd: "/w" }] : [{ pid: process.pid, name: "2.1.281", argv0: "claude", argv: ["claude"], cwd: "/w" }],
        },
      }),
    });
    const runtime = new HerdrRuntime(transport, { pollMs: 5 });
    expect(await runtime.harnessProcess("w1:p2", (p) => p.argv0 === "claude", 0)).toBeNull();
    fg = process.pid;
    const found = await runtime.harnessProcess("w1:p2", (p) => p.argv0 === "claude", 0);
    expect(found?.identity.pid).toBe(process.pid);
    expect(await runtime.harnessProcess("w1:p2", (p) => p.argv0 === "pi", 0)).toBeNull();
  });

  test("a missing pane reads as null, not an error", async () => {
    const transport = scriptedTransport({
      "pane.process_info": () => {
        throw new HerdrError("pane_not_found", "gone");
      },
    });
    expect(await new HerdrRuntime(transport).processes("w1:p9")).toBeNull();
  });

  test("events name their pane in either shape Herdr 0.7.5 sends", () => {
    expect(eventPaneId({ event: "pane.agent_status_changed", data: { pane_id: "w1:p2" } })).toBe("w1:p2");
    expect(eventPaneId({ event: "pane_updated", data: { pane: { pane_id: "w1:p3" } } })).toBe("w1:p3");
    expect(eventPaneId({ event: "layout.updated", data: {} })).toBeNull();
  });

  test("readPane returns the pane's recent text, null for a gone pane", async () => {
    const seen: Record<string, unknown>[] = [];
    const runtime = new HerdrRuntime(
      scriptedTransport({
        "pane.read": (p) => {
          seen.push(p);
          if (p.pane_id === "w1:p9") throw new HerdrError("pane_not_found", "gone");
          return { type: "pane_read", read: { text: "line 1\nDo you want to proceed?\n❯ 1. Yes" } };
        },
      }),
    );
    expect(await runtime.readPane("w1:p2", 40)).toBe("line 1\nDo you want to proceed?\n❯ 1. Yes");
    expect(await runtime.readPane("w1:p9", 40)).toBeNull();
    expect(seen[0]).toMatchObject({ source: "recent_unwrapped" });
  });
});

async function refuseToList(): Promise<never> {
  throw new Error("must not list");
}

describe("Herdr socket resolution", () => {
  test("an explicit [herdr] socket runs no Herdr command", async () => {
    const config = { ...defaultConfig("/h"), extra: { herdr: { socket: "/s/herdr.sock" } } };
    expect(await resolveHerdrSocket(config, refuseToList)).toEqual({ socket: "/s/herdr.sock", reason: null });
  });

  test("a named session is picked from session list; the default otherwise", async () => {
    const listed = { sessions: [{ name: "default", default: true, running: true, socket_path: "/d.sock" }, { name: "lab", default: false, running: true, socket_path: "/l.sock" }] };
    const lister = async () => ({ exitCode: 0, stdout: JSON.stringify(listed) });
    const base = { ...defaultConfig("/h"), tools: { herdr: "/bin/echo" } };
    expect((await resolveHerdrSocket({ ...base, extra: { herdr: { session: "lab" } } }, lister)).socket).toBe("/l.sock");
    expect((await resolveHerdrSocket({ ...base, extra: {} }, lister)).socket).toBe("/d.sock");
    expect((await resolveHerdrSocket({ ...base, extra: { herdr: { session: "nope" } } }, lister)).reason).toContain("no Herdr session named nope");
  });
});
