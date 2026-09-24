import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeDriver } from "../../src/contracts/bridge-suite.ts";

/**
 * A fake Claude Code leader for tests. It plays Claude only through the hooks
 * in the real leader settings file `flowryn lead` writes, with the semantics
 * the M0 spikes recorded on 2.1.281:
 *   - SessionStart and UserPromptSubmit additionalContext reaches the model
 *     (c02); a Stop hook's additionalContext continues the turn and Stop
 *     fires again with stop_hook_active (c06);
 *   - an asyncRewake hook runs in the background; exit 2 wakes an idle
 *     session with its stderr as the prompt, and a woken turn also runs
 *     UserPromptSubmit (c01); while busy its line arrives inside the running
 *     turn; every Stop arms another waiter and Claude never deduplicates them;
 *   - Notification idle_prompt fires only when you stop typing after a normal
 *     turn end (c03); an interrupt fires no hook at all and writes the marker
 *     to the transcript (c04, finding 6).
 */

interface HookCommand {
  type: string;
  command: string;
  asyncRewake?: boolean;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface FakeClaudeOptions {
  settingsPath: string;
  env: Record<string, string>;
  /** Where this fake keeps its transcript (the interrupt marker lands here). */
  dir: string;
  cwd: string;
  /** Called when the session quits, the way `flowryn lead` closes it. */
  onQuit?: () => Promise<void>;
}

const MAX_CONTINUATIONS = 8;

export class FakeClaudeLeader implements BridgeDriver {
  readonly harness = "claude" as const;
  readonly seen: { text: string; via: string }[] = [];
  private readonly settings: { hooks: Record<string, HookGroup[]> };
  private readonly opts: FakeClaudeOptions;
  private readonly transcript: string;
  private readonly sessionId = crypto.randomUUID();
  private readonly waiters = new Set<ReturnType<typeof Bun.spawn>>();
  private sessionName = "";
  private busy = false;
  private quitting = false;
  private turnChain: Promise<void> = Promise.resolve();

  constructor(opts: FakeClaudeOptions) {
    this.opts = opts;
    this.settings = JSON.parse(readFileSync(opts.settingsPath, "utf8"));
    this.transcript = join(opts.dir, `transcript-${this.sessionId}.jsonl`);
    writeFileSync(this.transcript, "");
    this.sessionName = opts.env.FLOWRYN_LEADER_SESSION ?? "";
  }

  session(): string {
    return this.sessionName;
  }

  private input(event: string, extra: Record<string, unknown>): string {
    return JSON.stringify({ session_id: this.sessionId, transcript_path: this.transcript, cwd: this.opts.cwd, permission_mode: "auto", hook_event_name: event, ...extra });
  }

  private groups(event: string, matcher?: string): HookCommand[] {
    return (this.settings.hooks[event] ?? []).filter((g) => !g.matcher || g.matcher === "*" || g.matcher === matcher).flatMap((g) => g.hooks);
  }

  /** Run the event's hooks the way Claude does; returns the additionalContext each synchronous hook printed. */
  private async fire(event: string, extra: Record<string, unknown> = {}, matcher?: string): Promise<string[]> {
    const contexts: string[] = [];
    const input = this.input(event, extra);
    const sync: Promise<void>[] = [];
    for (const hook of this.groups(event, matcher)) {
      if (hook.asyncRewake) {
        this.armWaiter(hook.command, input);
        continue;
      }
      sync.push(
        (async () => {
          const proc = Bun.spawn(["sh", "-c", hook.command], { env: this.opts.env, cwd: this.opts.cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
          const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          const line = out.trim().split("\n").pop() ?? "";
          if (!line) return;
          try {
            const parsed = JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } };
            const context = parsed.hookSpecificOutput?.additionalContext;
            if (typeof context === "string" && context.length > 0) contexts.push(context);
          } catch {
            // Not JSON: Claude shows plain stdout only in the transcript view; nothing reaches the model.
          }
        })(),
      );
    }
    await Promise.all(sync);
    for (const context of contexts) this.see(context, event);
    return contexts;
  }

  private see(text: string, via: string): void {
    this.seen.push({ text, via });
    appendFileSync(this.transcript, JSON.stringify({ type: "attachment", via, text }) + "\n");
  }

  /** An asyncRewake hook: exit 2 wakes the session with stderr; anything else is silent. */
  private armWaiter(command: string, input: string): void {
    if (this.quitting) return;
    const proc = Bun.spawn(["sh", "-c", command], { env: this.opts.env, cwd: this.opts.cwd, stdin: new Blob([input]), stdout: "ignore", stderr: "pipe" });
    this.waiters.add(proc);
    void (async () => {
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      this.waiters.delete(proc);
      if (code !== 2 || this.quitting) return;
      const line = err.trim();
      const framed = `Stop hook blocking error from command "Stop": ${line}`;
      if (this.busy) {
        // Delivered inside the running turn, beside the next tool result (M0 c01).
        this.see(framed, "waiter-busy");
        return;
      }
      this.see(framed, "waiter");
      this.turnChain = this.turnChain.then(() => this.turn(framed));
      await this.turnChain;
    })();
  }

  private async endTurn(): Promise<void> {
    for (let n = 0; n < MAX_CONTINUATIONS; n++) {
      const contexts = await this.fire("Stop", { stop_hook_active: n > 0 });
      if (contexts.length === 0) break;
    }
    this.busy = false;
  }

  private async turn(prompt: string): Promise<void> {
    this.busy = true;
    await this.fire("UserPromptSubmit", { prompt });
    await this.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "true" } }, "Bash");
    await this.fire("PostToolUse", { tool_name: "Bash", tool_input: { command: "true" } }, "Bash");
    await this.endTurn();
  }

  async start(): Promise<void> {
    await this.fire("SessionStart", { source: "startup" });
  }

  async prompt(label: string): Promise<void> {
    await this.turnChain;
    this.turnChain = this.turn(`${label}: reply ok`);
    await this.turnChain;
  }

  async promptBusy(label: string): Promise<void> {
    await this.turnChain;
    this.busy = true;
    await this.fire("UserPromptSubmit", { prompt: `${label}: run a long command` });
    await this.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "perl -e 'sleep 25'" } }, "Bash");
  }

  async finishBusy(): Promise<void> {
    await this.fire("PostToolUse", { tool_name: "Bash", tool_input: { command: "perl -e 'sleep 25'" } }, "Bash");
    this.turnChain = this.endTurn();
    await this.turnChain;
  }

  async typeDraft(): Promise<void> {
    // Typing after a turn means Claude never sends idle_prompt for it (M0 c03): nothing to fire.
  }

  async clearDraft(): Promise<void> {}

  async goInactive(): Promise<void> {
    await this.turnChain;
    await this.fire("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }, "idle_prompt");
  }

  /** Escape during a tool: no Stop, no StopFailure, no idle_prompt; only the transcript marker (M0 c04). */
  async interrupt(): Promise<void> {
    appendFileSync(this.transcript, JSON.stringify({ type: "user", message: { content: "[Request interrupted by user for tool use]" } }) + "\n");
    this.busy = false;
  }

  async compact(): Promise<void> {
    await this.turnChain;
    await this.fire("SessionStart", { source: "compact" });
  }

  async saw(marker: string): Promise<number> {
    return this.seen.filter((s) => s.text.includes(marker)).length;
  }

  /** Run a hook event directly, for race tests that need a precise order. */
  async hook(event: string, extra: Record<string, unknown> = {}, matcher?: string): Promise<string[]> {
    return this.fire(event, extra, matcher);
  }

  isBusy(): boolean {
    return this.busy;
  }

  liveWaiters(): number {
    return this.waiters.size;
  }

  async quit(): Promise<void> {
    await this.turnChain;
    await this.fire("SessionEnd", { reason: "prompt_input_exit" });
    this.quitting = true;
    for (const proc of this.waiters) proc.kill("SIGKILL");
    await this.opts.onQuit?.();
  }

  /** Stop background waiters without the session ending (test cleanup). */
  kill(): void {
    this.quitting = true;
    for (const proc of this.waiters) proc.kill("SIGKILL");
  }
}
