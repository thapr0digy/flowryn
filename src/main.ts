#!/usr/bin/env bun
import { basename } from "node:path";
import { cliMain } from "./cli/main.ts";
import type { CliIo } from "./api/verbs.ts";

/**
 * One binary serves as both `flowryn` and `flowrynd` (design section 3):
 * invoked as flowrynd (a symlink), it runs the daemon; otherwise it is the CLI.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const invokedAs = basename(process.argv0);
  const args = invokedAs === "flowrynd" ? ["daemon", "run", ...argv] : argv;
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    json: false,
    env: process.env,
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
  };
  // Words after `--` belong to a command a verb runs (flowryn lead -- ...), not to flowryn.
  const cut = args.indexOf("--");
  io.json = (cut === -1 ? args : args.slice(0, cut)).includes("--json");
  return cliMain(args, io, () => Bun.stdin.text());
}

main().then(
  (code) => {
    process.exitCode = code;
    // Let stdout drain, then exit even if a stray handle (a watcher, a socket) is still open.
    setTimeout(() => process.exit(code), 50).unref();
  },
  (error: unknown) => {
    process.stderr.write(`flowryn: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  },
);
