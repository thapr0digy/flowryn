#!/usr/bin/env bun
/**
 * The test homes' treehouse (test/helpers/harness.ts): `bun test` never runs
 * the real one. It answers the calls Flowryn makes (src/runtime/treehouse.ts)
 * the way treehouse 3.1.8 did when tried by hand: `--version`; `get --lease
 * --json` (a slot cut detached from the checkout's HEAD, a fresh one with a
 * real `git worktree add --detach`); `status --json`; and `return [--force]
 * [--if-lease-id <id>] <path>`, which refuses a slot with changes unless forced
 * (exit 3, as with stdin at EOF), refuses another lease (exit 1), and resets a
 * returned slot clean and detached while keeping its ignored files.
 *
 * State lives in the pool root (`--root`), in `.treehouse/fake-state.json`.
 * Every call is appended to `$FLOWRYN_HOME/treehouse-calls.log`; with
 * `$FLOWRYN_HOME/treehouse.fail` present every call fails, printing its text.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";

interface Slot {
  name: string;
  path: string;
  repo: string;
  lease_id: string;
  lease_holder: string;
}

const argv = process.argv.slice(2);
const home = process.env.FLOWRYN_HOME;
if (home) appendFileSync(join(home, "treehouse-calls.log"), `${JSON.stringify({ cwd: process.cwd(), argv })}\n`);
if (home && existsSync(join(home, "treehouse.fail"))) {
  console.error(readFileSync(join(home, "treehouse.fail"), "utf8").trim() || "treehouse: failing on purpose");
  process.exit(1);
}

function take(flag: string): string | null {
  const at = argv.indexOf(flag);
  if (at < 0) return null;
  const value = argv[at + 1] ?? null;
  argv.splice(at, 2);
  return value;
}

function has(flag: string): boolean {
  const at = argv.indexOf(flag);
  if (at < 0) return false;
  argv.splice(at, 1);
  return true;
}

function git(args: string[], cwd: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function must(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) {
    console.error(`git ${args.join(" ")}: ${r.err.trim()}`);
    process.exit(1);
  }
  return r.out.trim();
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (has("--version") || has("-v")) {
  console.log("v3.1.8");
  process.exit(0);
}
const root = take("--root");
if (!root) {
  console.error("the stand-in needs --root");
  process.exit(2);
}
const stateFile = join(root, ".treehouse", "fake-state.json");
const load = (): Slot[] => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as Slot[]) : []);
const save = (slots: Slot[]) => {
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(slots, null, 2));
};
const command = argv.shift();

if (command === "get") {
  if (!has("--lease")) {
    console.error("the stand-in only leases");
    process.exit(2);
  }
  const holder = take("--lease-holder") ?? "";
  has("--json");
  has("--no-fetch");
  has("--unique-leaf");
  const repo = must(["rev-parse", "--show-toplevel"], process.cwd());
  const base = must(["rev-parse", "HEAD"], repo);
  const slots = load();
  let slot = slots.find((s) => s.lease_id === "" && real(s.repo) === real(repo) && existsSync(s.path));
  if (slot) {
    must(["checkout", "-q", "--detach", base], slot.path);
  } else {
    const name = String(slots.length + 1);
    const leaf = `${basename(repo)}-${name}`;
    const path = join(root, ".treehouse", `${basename(repo)}-fake`, name, leaf);
    mkdirSync(join(path, ".."), { recursive: true });
    must(["worktree", "add", "-q", "--detach", path, base], repo);
    slot = { name, path, repo, lease_id: "", lease_holder: "" };
    slots.push(slot);
  }
  slot.lease_id = randomBytes(16).toString("hex");
  slot.lease_holder = holder;
  save(slots);
  console.error(`🌳 Leased worktree at ${slot.path}.`);
  console.log(JSON.stringify({ path: slot.path, lease_id: slot.lease_id, lease_holder: holder, leased_at: new Date().toISOString(), base_branch: "main" }));
  process.exit(0);
}

if (command === "status") {
  has("--json");
  const repo = real(must(["rev-parse", "--show-toplevel"], process.cwd()));
  const out = load()
    .filter((s) => real(s.repo) === repo)
    .map((s) => {
      const branch = existsSync(s.path) ? git(["branch", "--show-current"], s.path).out.trim() : "";
      return { name: s.name, path: s.path, status: s.lease_id ? "leased" : "available", branch, detached: branch === "", flavor: "git", lease_id: s.lease_id, lease_holder: s.lease_holder, leased_at: null, processes: [] };
    });
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (command === "return") {
  const force = has("--force");
  const ifLease = take("--if-lease-id");
  const target = argv.shift();
  const slots = load();
  const slot = target ? slots.find((s) => real(s.path) === real(target)) : undefined;
  if (!slot) {
    console.error(`worktree ${target} is not managed by treehouse`);
    process.exit(1);
  }
  if (ifLease !== null && slot.lease_id !== ifLease) {
    console.error(`failed to return worktree: lease precondition failed: lease identity does not match worktree ${slot.path}`);
    process.exit(1);
  }
  const dirty = must(["status", "--porcelain"], slot.path) !== "";
  if (dirty && !force) {
    console.error(`Worktree has uncommitted changes. Clean and return? [Y/n] 🌳 worktree not returned: it has uncommitted changes and the confirmation could not be answered (stdin reached EOF)`);
    process.exit(3);
  }
  must(["reset", "-q", "--hard"], slot.path);
  // -d without -x: untracked files go, ignored ones (the warm caches) stay.
  must(["clean", "-q", "-fd"], slot.path);
  must(["checkout", "-q", "--detach", must(["rev-parse", "HEAD"], slot.repo)], slot.path);
  slot.lease_id = "";
  slot.lease_holder = "";
  save(slots);
  console.error("🌳 Worktree returned to pool.");
  process.exit(0);
}

console.error(`the stand-in does not answer ${command ?? "(nothing)"}`);
process.exit(2);
