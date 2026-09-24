import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Reply } from "../../src/api/envelope.ts";
import { writeLeaderFiles, type LeaderFiles } from "../../src/bridges/files.ts";
import { STYLE_BLOCK } from "../../src/harness/contract-text.ts";
import { leaderEnv } from "../../src/cli/commands/lead.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { FakeClaudeLeader } from "./fake-claude-leader.ts";
import { FakeGitHub } from "./fake-github.ts";
import { FakePiLeader } from "./fake-pi-leader.ts";
import { makeFleetEnv, type FleetEnv, type FleetOptions } from "./fleet-env.ts";
import { REPO_ROOT, waitUntil } from "./harness.ts";

/**
 * A daemon with everything a ship needs from dispatch to cleaned: the fake
 * Herdr and fake workers of M2, a fake GitHub backed by the project's bare
 * origin (no network), and fake Claude and Pi leaders that run the real leader
 * bridge files. Approvals from your shell and the board go through the same
 * daemon verbs `flowryn approve` uses (the /dev/tty part has its own test).
 */

export const SHIP_TEST_CONFIG = (apiUrl: string) =>
  [
    "[github]",
    `api_url = ${JSON.stringify(apiUrl)}`,
    "poll_ms = 300",
    "[cleanup]",
    "lock_wait_ms = 50",
    "lock_retries = 2",
    "reap_grace_ms = 200",
    "[leader]",
    "busy_lease_ms = 3000",
    "inactive_ms = 400",
    "digest_budget_ms = 30000",
    "[notify]",
    "macos = false",
  ].join("\n");

export interface ShipEnv {
  fleet: FleetEnv;
  github: FakeGitHub;
  files: LeaderFiles;
  claude(): Promise<FakeClaudeLeader>;
  pi(): Promise<FakePiLeader>;
  /** The newest leader session's token (the leader once it claimed the lease), else the seeded lease token. */
  leaderToken(): string;
  /** A daemon call as your own terminal (channel tty), the way `flowryn approve` makes it. */
  call(verb: string, args: Record<string, unknown>, token?: string | null): Promise<Reply>;
  /** Approve in your shell or on the board: begin, then confirm with the code it showed. */
  approve(task: string, opts?: { allowRed?: string; discard?: boolean; gate?: string; channel?: "cli-tty" | "board" }): Promise<Reply>;
  /** The worker verb replies the fake worker recorded, once there are `count`. */
  replies(task: string, count: number): Promise<{ args: string[]; code: number; reply: Record<string, unknown> }[]>;
  cleanup(): Promise<void>;
}

export async function makeShipEnv(options: FleetOptions = {}): Promise<ShipEnv> {
  const github = await FakeGitHub.start();
  const fleet = await makeFleetEnv({ origin: true, ...options, extraConfig: `${SHIP_TEST_CONFIG(github.apiUrl)}\n${options.extraConfig ?? ""}` });
  github.addRepo("acme", "web", { bare: fleet.origin });
  const sock = join(fleet.h.home, "run", "flowrynd.sock");
  const files = await writeLeaderFiles({ home: fleet.h.home, socket: sock, command: ["bun", join(REPO_ROOT, "src/main.ts")], style: STYLE_BLOCK });
  const cwd = join(fleet.h.home, "leader-cwd");
  mkdirSync(cwd, { recursive: true });
  const fakes: { kill(): void }[] = [];
  let lastToken: string | null = null;

  const call = async (verb: string, args: Record<string, unknown>, token: string | null = null): Promise<Reply> =>
    (await request(sock, { proto: PROTO, ulid: ulid(), verb, token, channel: token ? null : "tty", args }, { connectMs: 1_000, replyMs: 120_000 })) as Reply;

  const open = async (harness: "claude" | "pi") => {
    const reply = await call("lead.open", { harness, pane: `w9:p${Math.floor(Math.random() * 90) + 10}`, cwd });
    if (!reply.ok) throw new Error(`lead.open: ${JSON.stringify(reply.error)}`);
    const { session, token } = reply.data as { session: string; token: string };
    lastToken = token;
    return { session, token, env: leaderEnv({ ...fleet.h.env }, { token, session, files, inactiveMs: 400 }) };
  };

  const env: ShipEnv = {
    fleet,
    github,
    files,
    call,
    leaderToken: () => lastToken ?? fleet.leader,
    async claude() {
      const opened = await open("claude");
      const fake = new FakeClaudeLeader({ settingsPath: files.claudeSettings, env: opened.env, dir: fleet.h.home, cwd, onQuit: async () => void (await call("lead.close", { reason: "test quit" }, opened.token)) });
      fakes.push(fake);
      return fake;
    },
    async pi() {
      const opened = await open("pi");
      const fake = new FakePiLeader({
        extensionPath: files.piExtension,
        env: opened.env,
        cwd,
        inactive: () => false,
        onQuit: async () => void (await call("lead.close", { reason: "test quit" }, opened.token)),
      });
      fakes.push(fake);
      return fake;
    },
    async approve(task, opts = {}) {
      const begun = await call("approve.begin", { task, "allow-red": opts.allowRed, discard: opts.discard || undefined, gate: opts.gate, channel: opts.channel ?? "cli-tty" });
      if (!begun.ok) return begun;
      const data = begun.data as { challenge: string; code: string };
      return call("approve.confirm", { challenge: data.challenge, code: data.code, actor: "tester" });
    },
    async replies(task, count) {
      const file = join(fleet.h.dataDir, task, "fake-replies.jsonl");
      const read = () => {
        try {
          return readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const row = JSON.parse(l) as { args: string[]; code: number; reply: string };
              return { args: row.args, code: row.code, reply: JSON.parse(row.reply || "{}") as Record<string, unknown> };
            });
        } catch {
          return [];
        }
      };
      await waitUntil(() => read().length >= count, 30_000, `${count} worker verb replies for ${task}`);
      return read();
    },
    async cleanup() {
      for (const fake of fakes) fake.kill();
      await github.stop().catch(() => {});
      await fleet.cleanup();
    },
  };
  return env;
}
