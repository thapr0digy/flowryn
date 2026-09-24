/**
 * The shared leader bridge contract suite (design section 17, M3): one list
 * of steps that both the Claude leader bridge and the Pi leader bridge must
 * pass. A step drives a leader through a `BridgeDriver` and checks two kinds
 * of evidence: what the model was shown (the driver's `saw`), and what
 * flowrynd recorded (the lease, presentations, notifications). The same steps
 * run against fake leaders in `bun test` and against real Claude Code and Pi
 * in a Herdr lab session (scripts/lab/m3-live.sh).
 */

export type LeaderHarness = "claude" | "pi";

/** One leader session, played by a fake or driven live in a Herdr pane. */
export interface BridgeDriver {
  readonly harness: LeaderHarness;
  /** The Flowryn leader session id (`L<n>`), known once started. */
  session(): string;
  /** Launch the leader; resolves once its session start reached the daemon. */
  start(): Promise<void>;
  /** You send a prompt and the turn runs to its end, continuations included. */
  prompt(label: string): Promise<void>;
  /** You send a prompt whose turn stays busy in a long tool call. Resolves once it is busy. */
  promptBusy(label: string): Promise<void>;
  /** The long tool call ends and the turn runs to its end. */
  finishBusy(): Promise<void>;
  /** You type into the composer without sending: you are active. */
  typeDraft(text: string): Promise<void>;
  /** You clear the composer. */
  clearDraft(): Promise<void>;
  /** You go away: Claude's idle_prompt fires, or Pi's composer stays empty and untouched. Resolves once the daemon knows. */
  goInactive(): Promise<void>;
  /** You interrupt the running turn (Escape). */
  interrupt(): Promise<void>;
  /** You compact the conversation (/compact). */
  compact(): Promise<void>;
  /** How many times text containing `marker` reached the model so far. */
  saw(marker: string): Promise<number>;
  /** Quit the leader. */
  quit(): Promise<void>;
}

export interface LeaseView {
  session: string | null;
  epoch: number;
}

export interface PresentationView {
  session_id: string;
  turn_no: number;
  path: string;
  state: string;
}

export interface SessionView {
  busy: boolean;
  inactive: boolean;
  ended: boolean;
}

export interface BridgeEnv {
  harness: LeaderHarness;
  /** Two leader sessions of the harness under test: 0 leads first, 1 is the second leader for the handover. */
  driver(index: 0 | 1): BridgeDriver;
  /** Open a P0 (a worker that cannot finish) whose line carries `marker`; returns the item id. */
  openP0(marker: string): Promise<string>;
  /** Open a P1 (a worker's non-blocking question) whose line carries `marker`; returns the item id. */
  openP1(marker: string): Promise<string>;
  lease(): LeaseView;
  presentations(item: string): PresentationView[];
  leaderSession(session: string): SessionView;
  /** Items named by the notifications flowrynd sent. */
  notifiedItems(): string[];
  /** The path a Pi extension reported delivering a pushed P0 by, or null. */
  deliveredVia(item: string): string | null;
  /** Hand the lease to a session from your own terminal (`flowryn leader claim --session`). */
  claimFor(session: string): Promise<void>;
  waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T>;
  sleep(ms: number): Promise<void>;
  /** Clocks of the run: how long a step may wait for each kind of event. */
  timeouts: { turn: number; inactive: number; busyExpiry: number; quiet: number };
  log(line: string): void;
}

export interface BridgeStep {
  name: string;
  run(env: BridgeEnv): Promise<string>;
}

/** Markers are unique per run and step, so a step never passes on another's evidence. */
export function marker(tag: string): string {
  return `FLOWRYN-MARK-${tag}-${Math.random().toString(36).slice(2, 8)}`;
}

function onePush(env: BridgeEnv, item: string): PresentationView[] {
  const pushes = env.presentations(item).filter((p) => ["continuation", "waiter", "trigger"].includes(p.path) && p.state !== "lost");
  if (pushes.length > 1) throw new Error(`P0 ${item} was pushed ${pushes.length} times: ${JSON.stringify(pushes)}`);
  return pushes;
}

async function presented(env: BridgeEnv, item: string, session: string, paths: string[]): Promise<PresentationView> {
  return env.waitFor(`${item} presented to ${session} by ${paths.join("|")}`, env.timeouts.turn, () =>
    env.presentations(item).find((p) => p.session_id === session && p.state === "presented" && paths.includes(p.path)),
  );
}

async function sawAtLeast(env: BridgeEnv, driver: BridgeDriver, mark: string, count: number): Promise<number> {
  return env.waitFor(`the ${driver.harness} leader to be shown ${mark} (${count}x)`, env.timeouts.turn, async () => {
    const n = await driver.saw(mark);
    return n >= count ? n : null;
  });
}

// State carried from one step to the next.
let briefMark = "";

export const BRIDGE_STEPS: BridgeStep[] = [
  {
    name: "session start claims the vacant lease and briefs",
    async run(env) {
      briefMark = marker("BRIEF");
      const item = await env.openP1(briefMark);
      const lead = env.driver(0);
      await lead.start();
      const lease = await env.waitFor("the lease", env.timeouts.turn, () => (env.lease().session === lead.session() ? env.lease() : null));
      await lead.prompt("first");
      await sawAtLeast(env, lead, briefMark, 1);
      await presented(env, item, lead.session(), ["briefing"]);
      return `lease ${lease.epoch} to ${lead.session()}; briefing listed ${item} and was presented at the turn end`;
    },
  },
  {
    name: "a P1 rides with your next message as the digest",
    async run(env) {
      const lead = env.driver(0);
      const mark = marker("DIGEST");
      const item = await env.openP1(mark);
      await lead.prompt("digest");
      await sawAtLeast(env, lead, mark, 1);
      await presented(env, item, lead.session(), ["digest"]);
      return `${item} carried by the digest and presented`;
    },
  },
  {
    name: "a P0 while busy is delivered after the turn",
    async run(env) {
      const lead = env.driver(0);
      const mark = marker("P0BUSY");
      await lead.promptBusy("busy");
      await env.waitFor("the leader busy", env.timeouts.turn, () => env.leaderSession(lead.session()).busy);
      const item = await env.openP0(mark);
      // Claude continues the turn at its Stop; Pi's extension queues a followUp while the run is still going.
      if (lead.harness === "pi") {
        await env.waitFor(`${item} queued as a follow-up`, env.timeouts.turn, () => env.deliveredVia(item) === "continuation");
        await env.sleep(300);
      }
      await lead.finishBusy();
      await sawAtLeast(env, lead, mark, 1);
      const p = await presented(env, item, lead.session(), ["continuation"]);
      onePush(env, item);
      return `${item} continued the busy turn (${p.path}) once, presented at the next turn end`;
    },
  },
  {
    name: "a P0 while idle and you active only notifies, then tops the digest",
    async run(env) {
      const lead = env.driver(0);
      const mark = marker("P0ACTIVE");
      await lead.typeDraft("half typed, not sent");
      const item = await env.openP0(mark);
      await env.waitFor(`a notification for ${item}`, env.timeouts.turn, () => env.notifiedItems().includes(item));
      await env.sleep(env.timeouts.quiet);
      if ((await lead.saw(mark)) > 0) throw new Error(`${item} reached an idle leader while you were active`);
      if (onePush(env, item).length > 0) throw new Error(`${item} was pushed while you were active`);
      await lead.clearDraft();
      await lead.prompt("after draft");
      await sawAtLeast(env, lead, mark, 1);
      await presented(env, item, lead.session(), ["digest"]);
      return `${item} notified, not pushed for ${Math.round(env.timeouts.quiet / 1000)}s, then carried at the top of the next digest`;
    },
  },
  {
    name: "a P0 while idle and you inactive starts a turn",
    async run(env) {
      const lead = env.driver(0);
      const mark = marker("P0WAKE");
      await lead.goInactive();
      const item = await env.openP0(mark);
      await sawAtLeast(env, lead, mark, 1);
      const p = await presented(env, item, lead.session(), ["waiter", "trigger"]);
      onePush(env, item);
      return `${item} woke the leader (${p.path}) and was presented when the woken turn ended`;
    },
  },
  {
    name: "an interrupt leaves no stuck busy",
    async run(env) {
      const lead = env.driver(0);
      await lead.promptBusy("to interrupt");
      await env.waitFor("the leader busy", env.timeouts.turn, () => env.leaderSession(lead.session()).busy);
      const started = Date.now();
      await lead.interrupt();
      await env.waitFor("busy to clear after the interrupt", env.timeouts.busyExpiry, () => !env.leaderSession(lead.session()).busy);
      return `busy cleared ${Math.round((Date.now() - started) / 1000)}s after the interrupt, with no hook from the harness required`;
    },
  },
  {
    name: "compaction re-briefs with every open actionable item",
    async run(env) {
      const lead = env.driver(0);
      const before = await lead.saw(briefMark);
      await lead.compact();
      await lead.prompt("after compact");
      const after = await sawAtLeast(env, lead, briefMark, before + 1);
      return `the briefing after compaction re-listed the open item (${briefMark} shown ${after}x)`;
    },
  },
  {
    name: "a second leader is read-only until it claims; the old one sees a banner",
    async run(env) {
      const first = env.driver(0);
      const second = env.driver(1);
      await second.start();
      await env.waitFor("the second session", env.timeouts.turn, () => (env.leaderSession(second.session()).ended ? null : true));
      if (env.lease().session !== first.session()) throw new Error("a second session took the lease without a claim");
      await second.prompt("read only");
      await sawAtLeast(env, second, "read-only", 1);
      const epoch = env.lease().epoch;
      await env.claimFor(second.session());
      await env.waitFor("the lease to move", env.timeouts.turn, () => env.lease().session === second.session() && env.lease().epoch === epoch + 1);
      await first.prompt("after handover");
      await sawAtLeast(env, first, "leadership moved", 1);
      const mark = marker("NEWLEAD");
      const item = await env.openP1(mark);
      await second.prompt("new leader");
      await sawAtLeast(env, second, mark, 1);
      await first.prompt("old leader");
      if ((await first.saw(mark)) > 0) throw new Error(`the read-only session was shown ${item}`);
      return `epoch ${epoch} → ${epoch + 1}; the old session got the banner and no digest; the new one got ${item}`;
    },
  },
  {
    name: "quitting the holder releases the lease",
    async run(env) {
      const holder = env.driver(1);
      await holder.quit();
      await env.waitFor("the lease to be vacant", env.timeouts.turn, () => env.lease().session === null);
      await env.driver(0).quit();
      await env.waitFor("the first session to end", env.timeouts.turn, () => env.leaderSession(env.driver(0).session()).ended);
      return "both sessions ended; the lease is vacant";
    },
  },
];
