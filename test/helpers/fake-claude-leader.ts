import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeDriver } from "../../src/contracts/bridge-suite.ts";
import { claudeProjectSlug } from "../../src/policy/grants.ts";

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
 *   - A Bash tool call obeys the settings' permissions (deny beats ask beats
 *     allow) and a PreToolUse hook's permissionDecision; "ask" puts a prompt
 *     in front of you, in auto mode and under bypass alike (c08), and the
 *     command runs only if you say yes. A hook's "allow" never overrides an
 *     ask rule (c15).
 *   - AskUserQuestion (c15, Claude 2.1.296): PreToolUse sees the questions; a
 *     deny stops it with no dialog; your answers come back in PostToolUse as
 *     tool_input and tool_response {questions, answers, annotations}; the
 *     transcript holds the tool use and, with a timestamp, its result with
 *     toolUseResult.answers (written here after PostToolUse, the latest it
 *     can be). The transcript lives where Claude keeps it, in the folder named
 *     for its startup cwd: <dir>/claude-projects/<slug of cwd>/<session>.jsonl, and each entry (and
 *     each hook input) names the current cwd, which follows a `cd` (`cd()`), as Claude's do.
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
  /** Claude's projects folder for the transcript (default <dir>/claude-projects): an account's <config dir>/projects. */
  projectsDir?: string;
  cwd: string;
  /** Called when the session quits, the way `flowryn lead` closes it. */
  onQuit?: () => Promise<void>;
}

const MAX_CONTINUATIONS = 8;

function isoNow(): string {
  return new Date().toISOString();
}

export class FakeClaudeLeader implements BridgeDriver {
  readonly harness = "claude" as const;
  readonly seen: { text: string; via: string }[] = [];
  private readonly settings: { hooks: Record<string, HookGroup[]>; permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } };
  /** Every permission prompt Claude showed you, with the hook's reason when it gave one. */
  readonly prompts: string[] = [];
  /** The session's permission mode, as its hooks see it (M0 c09). */
  permissionMode = "auto";
  /**
   * Fail-open: the PreToolUse hooks still run (so flowrynd records what they
   * report), but their decisions never reach Claude, as when the hook's reply
   * times out after the daemon answered. Only the settings' rules apply.
   */
  hookDecisionsLost = false;
  private readonly opts: FakeClaudeOptions;
  private readonly transcript: string;
  private readonly sessionId = crypto.randomUUID();
  /** The session's current directory: hook inputs and transcript entries name it; the transcript folder stays the startup one. */
  private cwd: string;
  private readonly waiters = new Set<ReturnType<typeof Bun.spawn>>();
  private sessionName = "";
  private busy = false;
  private quitting = false;
  private turnChain: Promise<void> = Promise.resolve();

  constructor(opts: FakeClaudeOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.settings = JSON.parse(readFileSync(opts.settingsPath, "utf8"));
    const projectDir = join(opts.projectsDir ?? join(opts.dir, "claude-projects"), claudeProjectSlug(opts.cwd));
    mkdirSync(projectDir, { recursive: true });
    this.transcript = join(projectDir, `${this.sessionId}.jsonl`);
    writeFileSync(this.transcript, "");
    this.sessionName = opts.env.FLOWRYN_LEADER_SESSION ?? "";
  }

  session(): string {
    return this.sessionName;
  }

  private input(event: string, extra: Record<string, unknown>): string {
    return JSON.stringify({ session_id: this.sessionId, transcript_path: this.transcript, cwd: this.cwd, permission_mode: this.permissionMode, hook_event_name: event, ...extra });
  }

  /** A matcher is a regular expression over the whole value, as Claude's are (`Edit|Write`, `idle_prompt|quota_...`). */
  private groups(event: string, matcher?: string): HookCommand[] {
    const matches = (pattern: string) => pattern === "*" || (matcher !== undefined && new RegExp(`^(?:${pattern})$`).test(matcher));
    return (this.settings.hooks[event] ?? []).filter((g) => !g.matcher || matches(g.matcher)).flatMap((g) => g.hooks);
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

  /**
   * A Bash `cd` in the session: Claude's later hook inputs and transcript entries name the new
   * directory, but the transcript stays in the folder named for the startup one.
   */
  cd(dir: string): void {
    this.cwd = dir;
  }

  async compact(): Promise<void> {
    await this.turnChain;
    await this.fire("SessionStart", { source: "compact" });
  }

  async saw(marker: string): Promise<number> {
    return this.seen.filter((s) => s.text.includes(marker)).length;
  }

  /** `Bash(pattern)` rules: * matches anything, the rest literally, over the whole command. */
  private matches(rules: string[] | undefined, command: string): boolean {
    return (rules ?? []).some((rule) => {
      const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (inner === undefined) return false;
      const pattern = new RegExp(`^${inner.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return pattern.test(command);
    });
  }

  /**
   * The model runs a Bash command. PreToolUse runs first; a deny rule blocks
   * it; a hook "ask" or an ask rule prompts you (`approve` is your answer);
   * otherwise it runs. Returns what happened and the command's output.
   */
  async runBash(command: string, answer: { approve: boolean }): Promise<{ denied: boolean; prompted: boolean; ran: boolean; code: number; stdout: string; stderr: string }> {
    const toolInput = { command };
    const toolUseId = `toolu_${crypto.randomUUID().slice(0, 12)}`;
    const input = this.input("PreToolUse", { tool_name: "Bash", tool_input: toolInput, tool_use_id: toolUseId });
    let decision: string | null = null;
    let reason = "";
    for (const hook of this.groups("PreToolUse", "Bash")) {
      const proc = Bun.spawn(["sh", "-c", hook.command], { env: this.opts.env, cwd: this.opts.cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "") as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (parsed.hookSpecificOutput?.permissionDecision) {
          decision = parsed.hookSpecificOutput.permissionDecision;
          reason = parsed.hookSpecificOutput.permissionDecisionReason ?? "";
        }
      } catch {
        // no decision
      }
    }
    if (this.hookDecisionsLost) {
      decision = null;
      reason = "";
    }
    const perms = this.settings.permissions ?? {};
    if (decision === "deny" || this.matches(perms.deny, command)) return { denied: true, prompted: false, ran: false, code: -1, stdout: "", stderr: "" };
    const ask = decision === "ask" || this.matches(perms.ask, command) || (!this.matches(perms.allow, command) && decision !== "allow");
    if (ask) {
      this.prompts.push(reason || `Bash(${command})`);
      if (!answer.approve) return { denied: false, prompted: true, ran: false, code: -1, stdout: "", stderr: "" };
    }
    const proc = Bun.spawn(["sh", "-c", command], { env: this.opts.env, cwd: this.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    await this.fire("PostToolUse", { tool_name: "Bash", tool_input: toolInput, tool_use_id: toolUseId }, "Bash");
    return { denied: false, prompted: ask, ran: true, code, stdout, stderr };
  }

  /** The transcript file, for tests that check (or tamper with) what Claude recorded. */
  transcriptPath(): string {
    return this.transcript;
  }

  /** A PreToolUse decision from the hooks for one tool call. */
  private async preDecision(tool: string, toolInput: unknown, toolUseId: string): Promise<{ decision: string | null; reason: string }> {
    const input = this.input("PreToolUse", { tool_name: tool, tool_input: toolInput, tool_use_id: toolUseId });
    let decision: string | null = null;
    let reason = "";
    for (const hook of this.groups("PreToolUse", tool)) {
      const proc = Bun.spawn(["sh", "-c", hook.command], { env: this.opts.env, cwd: this.opts.cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "") as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (parsed.hookSpecificOutput?.permissionDecision) {
          decision = parsed.hookSpecificOutput.permissionDecision;
          reason = parsed.hookSpecificOutput.permissionDecisionReason ?? "";
        }
      } catch {
        // no decision
      }
    }
    return { decision, reason };
  }

  /**
   * The model calls AskUserQuestion and you answer. `prefill` makes the model pass its own answers
   * in the tool input. A deny stops it before any dialog. Otherwise your `answers` (question text to
   * the label or text you chose) and `notes` come back through PostToolUse, whose context lines
   * (the grants) are returned, and the transcript records the call and its result.
   */
  async ask(
    questions: unknown[],
    answer: { answers: Record<string, string>; notes?: Record<string, string> },
    opts: { prefill?: Record<string, string>; toolUseId?: string } = {},
  ): Promise<{ denied: boolean; reason: string; contexts: string[]; toolUseId: string }> {
    const toolUseId = opts.toolUseId ?? `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const preInput = opts.prefill ? { questions, answers: opts.prefill } : { questions };
    const pre = await this.preDecision("AskUserQuestion", preInput, toolUseId);
    if (pre.decision === "deny") return { denied: true, reason: pre.reason, contexts: [], toolUseId };
    appendFileSync(this.transcript, JSON.stringify({ type: "assistant", sessionId: this.sessionId, cwd: this.cwd, timestamp: isoNow(), message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } }) + "\n");
    const annotations = Object.fromEntries(Object.entries(answer.notes ?? {}).map(([q, notes]) => [q, { notes }]));
    const result = { questions, answers: answer.answers, annotations };
    const contexts = await this.fire("PostToolUse", { tool_name: "AskUserQuestion", tool_input: result, tool_response: result, tool_use_id: toolUseId }, "AskUserQuestion");
    const text = Object.entries(answer.answers).map(([q, a]) => `"${q}"="${a}"`).join(", ");
    appendFileSync(
      this.transcript,
      JSON.stringify({ type: "user", sessionId: this.sessionId, cwd: this.cwd, timestamp: isoNow(), toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Your questions have been answered: ${text}.` }] } }) + "\n",
    );
    return { denied: false, reason: "", contexts, toolUseId };
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
