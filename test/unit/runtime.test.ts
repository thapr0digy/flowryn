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
import { FakeHerdr } from "../helpers/fake-herdr.ts";

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

/**
 * A Herdr socket for events.subscribe: after the request it writes `lines`
 * (raw, so a test can send what a broken peer would), or nothing at all.
 * The connection stays open, as a subscription's does.
 */
async function subscribeSocket(lines: (id: string) => string[]): Promise<{ path: string; requests: number; send(line: string): void; close(): void }> {
  const path = join(tempDir(), "s.sock");
  const conns: net.Socket[] = [];
  const state = { path, requests: 0, send: (line: string) => conns.forEach((c) => c.write(line)), close: () => {} };
  const server = net.createServer((conn) => {
    conns.push(conn);
    conn.setEncoding("utf8");
    conn.on("error", () => conn.destroy());
    let buffer = "";
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
      buffer = buffer.slice(newline + 1);
      state.requests++;
      for (const line of lines(request.id)) conn.write(line);
    });
  });
  await new Promise<void>((done) => server.listen(path, () => done()));
  state.close = () => {
    for (const c of conns) c.destroy();
    server.close();
  };
  return state;
}

/** How a subscribe attempt settled, or "pending" if it had not by `withinMs`. */
async function settle(attempt: Promise<unknown>, withinMs: number): Promise<{ code: string } | "started" | "pending"> {
  return Promise.race([
    attempt.then(
      () => "started" as const,
      (error: unknown) => ({ code: (error as HerdrError).code }),
    ),
    Bun.sleep(withinMs).then(() => "pending" as const),
  ]);
}

const ack = (id: string) => JSON.stringify({ id, result: { type: "subscription_started" } }) + "\n";

describe("Herdr subscription handshake", () => {
  test("assumption: a peer that never acknowledges fails within the handshake deadline, as timeout", async () => {
    const sock = await subscribeSocket(() => []);
    try {
      const started = Date.now();
      const outcome = await settle(new HerdrClient(sock.path, { handshakeMs: 200 }).subscribe([], () => {}, () => {}), 3_000);
      expect(outcome).toEqual({ code: "timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(sock.requests).toBe(1);
    } finally {
      sock.close();
    }
  });

  test("assumption: only {id, result: {type: subscription_started}} is an acknowledgement; anything else is protocol", async () => {
    const malformed: ((id: string) => string)[] = [
      () => "not json\n",
      () => "{}\n",
      () => JSON.stringify({ event: "pane.updated", data: { pane_id: "w1:p1" } }) + "\n",
      () => JSON.stringify({ id: "another", result: { type: "subscription_started" } }) + "\n",
      (id) => JSON.stringify({ id, result: { type: "pane_info" } }) + "\n",
      (id) => JSON.stringify({ id, result: "subscription_started" }) + "\n",
      () => "[1,2]\n",
    ];
    for (const first of malformed) {
      const sock = await subscribeSocket((id) => [first(id), ack(id)]);
      try {
        expect({ line: first("ID"), outcome: await settle(new HerdrClient(sock.path, { handshakeMs: 2_000 }).subscribe([], () => {}, () => {}), 3_000) }).toEqual({
          line: first("ID"),
          outcome: { code: "protocol" },
        });
      } finally {
        sock.close();
      }
    }
  });

  test("a refusal keeps Herdr's own code; a valid acknowledgement starts the stream", async () => {
    const refused = await subscribeSocket((id) => [JSON.stringify({ id, error: { code: "invalid_params", message: "bad subscription" } }) + "\n"]);
    try {
      expect(await settle(new HerdrClient(refused.path, { handshakeMs: 2_000 }).subscribe([], () => {}, () => {}), 3_000)).toEqual({ code: "invalid_params" });
    } finally {
      refused.close();
    }
    const good = await subscribeSocket((id) => ["\n", ack(id)]);
    try {
      const events: string[] = [];
      const subscription = await new HerdrClient(good.path, { handshakeMs: 2_000 }).subscribe([], (e) => events.push(e.event), () => {});
      good.send(JSON.stringify({ event: "pane.updated", data: { pane_id: "w1:p1" } }) + "\n");
      for (let i = 0; i < 50 && events.length === 0; i++) await Bun.sleep(20);
      expect(events).toEqual(["pane.updated"]);
      subscription.close();
    } finally {
      good.close();
    }
  });

  test("assumption: after the acknowledgement, a line that is not JSON ends the stream with protocol, and an {error} line with Herdr's code", async () => {
    for (const [bad, code] of [
      ["garbage\n", "protocol"],
      ["[1,2]\n", "protocol"],
      [JSON.stringify({ error: { code: "server_shutting_down", message: "bye" } }) + "\n", "server_shutting_down"],
    ] as const) {
      const sock = await subscribeSocket((id) => [ack(id)]);
      try {
        const closed = Promise.withResolvers<HerdrError | null>();
        await new HerdrClient(sock.path, { handshakeMs: 2_000 }).subscribe([], () => {}, closed.resolve);
        sock.send(bad);
        const error = await Promise.race([closed.promise, Bun.sleep(3_000).then(() => "still open" as const)]);
        expect({ bad, code: error === "still open" ? error : error?.code }).toEqual({ bad, code });
      } finally {
        sock.close();
      }
    }
  });

  test("assumption: an unknown JSON line after the acknowledgement (a reply, a heartbeat) is dropped, logged once and counted; the stream stays up", async () => {
    const sock = await subscribeSocket((id) => [ack(id)]);
    try {
      const logged: string[] = [];
      const events: string[] = [];
      let closes = 0;
      const subscription = await new HerdrClient(sock.path, { handshakeMs: 2_000, log: (line) => logged.push(line) }).subscribe(
        [],
        (e) => events.push(e.event),
        () => closes++,
      );
      for (const unknown of [{ type: "heartbeat" }, { id: "sub1", result: { type: "noted" } }, { event: "pane_updated", data: "w1:p1" }]) sock.send(JSON.stringify(unknown) + "\n");
      sock.send(JSON.stringify({ event: "pane_closed", data: { pane_id: "w1:p1", type: "pane_closed", workspace_id: "w1" } }) + "\n");
      for (let i = 0; i < 50 && events.length === 0; i++) await Bun.sleep(20);
      expect(events).toEqual(["pane_closed"]);
      expect(subscription.ignored?.()).toBe(3);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("heartbeat");
      expect(closes).toBe(0);
      subscription.close();
    } finally {
      sock.close();
    }
  });

  test("a socket that does not exist is unreachable, at once", async () => {
    expect(await settle(new HerdrClient(join(tempDir(), "absent.sock"), { handshakeMs: 2_000 }).subscribe([], () => {}, () => {}), 3_000)).toEqual({ code: "unreachable" });
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

  test("assumption: a malformed pane.process_info is unknown evidence (protocol), never an empty pane", async () => {
    const shell = { pid: 100, name: "zsh", argv0: "-zsh", argv: ["-zsh"], cwd: "/w" };
    const malformed: Record<string, unknown>[] = [
      {},
      { process_info: "w1:p2" },
      { process_info: { pane_id: "w1:p2", foreground_process_group_id: 100, foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 0, foreground_process_group_id: 100, foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: "100", foreground_process_group_id: 100, foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: -1, foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: "100", foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 1.5, foreground_processes: [shell] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100 } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: null } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_processes: "zsh" } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: null, foreground_processes: { pid: 100 } } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ name: "zsh" }] } },
      { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: ["zsh"] } },
    ];
    for (const reply of malformed) {
      const runtime = new HerdrRuntime(scriptedTransport({ "pane.process_info": () => reply }), { pollMs: 5 });
      const outcome = await runtime.processes("w1:p2").then(
        (info) => ({ info }),
        (error: unknown) => ({ code: (error as HerdrError).code }),
      );
      expect({ reply, outcome }).toEqual({ reply, outcome: { code: "protocol" } });
      await expect(runtime.harnessProcess("w1:p2", () => true, 0)).rejects.toMatchObject({ code: "protocol" });
    }
    const valid = new HerdrRuntime(scriptedTransport({ "pane.process_info": () => ({ process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [shell] } }) }));
    expect(await valid.processes("w1:p2")).toMatchObject({ shellPid: 100, foregroundGroup: 100, processes: [{ pid: 100, argv0: "-zsh" }] });
  });

  test("assumption: a pane with no foreground group yet (M0 h02's handoff reply) is a pane with no job, not malformed", async () => {
    const shell = { pid: 100, name: "zsh", argv0: "-zsh", argv: ["-zsh"], cwd: "/w" };
    const replies: [Record<string, unknown>, unknown][] = [
      // Herdr 0.7.5's own reply at the shell-to-job handoff, seen live: both fields omitted.
      [{ pane_id: "w1:p2", shell_pid: 100 }, { foregroundGroup: null, processes: [] }],
      [{ pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: null, foreground_processes: null }, { foregroundGroup: null, processes: [] }],
      [{ pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: null, foreground_processes: [shell] }, { foregroundGroup: null, processes: [{ pid: 100 }] }],
      [{ pane_id: "w1:p2", shell_pid: 100, foreground_processes: [shell] }, { foregroundGroup: null, processes: [{ pid: 100 }] }],
    ];
    for (const [info, expected] of replies) {
      const runtime = new HerdrRuntime(scriptedTransport({ "pane.process_info": () => ({ process_info: info }) }));
      expect({ info, read: await runtime.processes("w1:p2") }).toMatchObject({ info, read: { paneId: "w1:p2", shellPid: 100, ...(expected as object) } });
      expect(await runtime.harnessProcess("w1:p2", () => true, 0)).toBeNull();
    }
  });

  test("the launch's identity wait keeps polling through reads with no foreground group until the harness appears", async () => {
    let reads = 0;
    const transport = scriptedTransport({
      "pane.process_info": () => {
        reads++;
        if (reads <= 2) return { process_info: { pane_id: "w1:p2", shell_pid: 100 } };
        return {
          process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: process.pid, foreground_processes: [{ pid: process.pid, name: "2.1.296", argv0: "claude", argv: ["claude"], cwd: "/w" }] },
        };
      },
    });
    const found = await new HerdrRuntime(transport, { pollMs: 5 }).harnessProcess("w1:p2", (p) => p.argv0 === "claude", 10_000);
    expect(found?.identity.pid).toBe(process.pid);
    expect(reads).toBe(3);
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

/** The workspaces Flowryn asked Herdr to focus. */
function focusCalls(herdr: FakeHerdr): unknown[] {
  return herdr.calls.filter((c) => c.method === "workspace.focus").map((c) => c.params.workspace_id);
}

describe("Herdr focus across workspace closes (M0 h07)", () => {
  const fakes: FakeHerdr[] = [];
  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.stop();
  });

  /** A fake Herdr with workspaces `a, leader, w1, w2` (the leader focused) and a runtime on it. */
  async function fleet(): Promise<{ herdr: FakeHerdr; runtime: HerdrRuntime; ids: Record<"a" | "leader" | "w1" | "w2", string> }> {
    const dir = tempDir();
    const herdr = await FakeHerdr.start(join(dir, "h.sock"), { env: {}, logDir: dir });
    fakes.push(herdr);
    const runtime = new HerdrRuntime(new HerdrClient(herdr.socket));
    const ids = {} as Record<"a" | "leader" | "w1" | "w2", string>;
    for (const name of ["a", "leader", "w1", "w2"] as const) ids[name] = (await runtime.openWorkspace(dir, name)).workspaceId;
    herdr.focusWorkspace(ids.leader);
    return { herdr, runtime, ids };
  }

  test("opening a worker workspace leaves the focused one focused", async () => {
    const { herdr, runtime, ids } = await fleet();
    await runtime.openWorkspace("/", "w3");
    expect(herdr.focusedWorkspace).toBe(ids.leader);
    expect(herdr.calls.find((c) => c.method === "workspace.create")?.params.focus).toBe(false);
  });

  test("closing an unfocused worker puts focus back where Herdr's close took it from", async () => {
    const { herdr, runtime, ids } = await fleet();
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.focusedWorkspace).toBe(ids.leader);
    // Herdr's own move already lands on the leader here (`a, leader*, w2`, then `leader*, w2`), so nothing is restored.
    await runtime.closeWorkspace(ids.a);
    await runtime.closeWorkspace(ids.w2);
    expect(herdr.focusedWorkspace).toBe(ids.leader);
    expect(focusCalls(herdr)).toEqual([ids.leader]);
  });

  test("with nothing focused, a close reads the list once and focuses nothing", async () => {
    const { herdr, runtime, ids } = await fleet();
    herdr.focusedWorkspace = null;
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.focusedWorkspace).toBeNull();
    expect(herdr.calls.filter((c) => c.method === "workspace.list")).toHaveLength(1);
    expect(focusCalls(herdr)).toEqual([]);
  });

  test("closing the focused workspace leaves focus to Herdr", async () => {
    const { herdr, runtime, ids } = await fleet();
    herdr.focusWorkspace(ids.w1);
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.focusedWorkspace).toBe(ids.w2);
    expect(focusCalls(herdr)).toEqual([]);
  });

  test("a focus the user chose between the close and the check stays", async () => {
    const { herdr, runtime, ids } = await fleet();
    herdr.afterClose = () => herdr.focusWorkspace(ids.a);
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.focusedWorkspace).toBe(ids.a);
    expect(focusCalls(herdr)).toEqual([]);
  });

  test("two closes at once both keep the leader focused", async () => {
    const { herdr, runtime, ids } = await fleet();
    await runtime.openWorkspace("/", "w3");
    await Promise.all([runtime.closeWorkspace(ids.w1), runtime.closeWorkspace(ids.w2), runtime.openWorkspace("/", "w4")]);
    expect(herdr.focusedWorkspace).toBe(ids.leader);
  });

  test("a close that succeeded resolves even when the restore's list read fails", async () => {
    const { herdr, runtime, ids } = await fleet();
    herdr.afterClose = () => herdr.failNext.set("workspace.list", ["internal"]);
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.workspaces.has(ids.w1)).toBe(false);
    expect(focusCalls(herdr)).toEqual([]);
  });

  test("a close with a time budget stays within it when Herdr never answers", async () => {
    const path = join(tempDir(), "silent.sock");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const started = Date.now();
      const error = await new HerdrRuntime(new HerdrClient(path)).closeWorkspace("w1", 300).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(600);
    } finally {
      server.close();
    }
  });

  test("a workspace already gone is not an error and moves no focus", async () => {
    const { herdr, runtime, ids } = await fleet();
    await runtime.closeWorkspace(ids.w1);
    await runtime.closeWorkspace(ids.w1);
    expect(herdr.focusedWorkspace).toBe(ids.leader);
    expect(focusCalls(herdr)).toEqual([ids.leader]);
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
