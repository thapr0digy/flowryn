import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { isUlid } from "../util/ulid.ts";
import { PROTO } from "../version.ts";
import { PROTO_EXEMPT_VERBS } from "../daemon/system-verbs.ts";
import { authorize, resolveCaller } from "./auth.ts";
import { errorReply, okReply, parseEnvelope, type Envelope, type Reply } from "./envelope.ts";
import { FlowrynError, toErrorBody } from "./errors.ts";
import { validateArgs, type Args, type DaemonServices, type HandlerCtx, type HandlerResult, type VerbSpec } from "./verbs.ts";

/** Replies are kept this long, so a retried mutation returns its original result (design section 12). */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Via = "socket" | "spool";

export interface GatewayOptions {
  services: DaemonServices;
  lookup: (verb: string) => VerbSpec | undefined;
  /** Resolves once startup (replay, spool ingest) is done; calls wait for it. */
  ready?: Promise<void>;
}

/**
 * The API gateway: the one entry for every socket call and spooled call.
 * Order: protocol check (the handshake and restart verbs are exempt), verb lookup, token to role, role check, argument
 * validation, idempotency, then the verb. It decides no policy and changes no
 * lifecycle state itself.
 */
export class Gateway {
  private readonly opts: GatewayOptions;
  /** Mutations in flight by ULID: a second call with the same key awaits the first one's reply rather than running again. */
  private readonly inFlight = new Map<string, Promise<Reply>>();

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  async handle(raw: unknown, via: Via = "socket"): Promise<Reply> {
    const parsed = parseEnvelope(raw);
    if (typeof parsed === "string") return errorReply({ code: "bad_envelope", message: parsed });
    const env = parsed;
    if (env.proto !== PROTO && !PROTO_EXEMPT_VERBS.has(env.verb)) {
      const info = this.opts.services.info();
      return errorReply(
        {
          code: "protocol_mismatch",
          message: `this CLI speaks protocol ${env.proto}; the daemon speaks ${PROTO}`,
          help: `use the daemon's binary: ${info.execPath}`,
        },
        { proto: PROTO },
      );
    }
    // Socket calls wait for startup; spool ingest is part of startup, so it must not.
    if (this.opts.ready && via === "socket") await this.opts.ready;
    try {
      return await this.dispatch(env, via);
    } catch (error) {
      if (!(error instanceof FlowrynError)) this.opts.services.log(`gateway: ${env.verb} failed: ${(error as Error).stack ?? String(error)}`);
      return errorReply(toErrorBody(error));
    }
  }

  private async dispatch(env: Envelope, via: Via): Promise<Reply> {
    const services = this.opts.services;
    const spec = this.opts.lookup(env.verb);
    if (!spec || spec.kind === "local") throw new FlowrynError("unknown_verb", `unknown verb: ${env.verb}`, "flowryn help");
    const caller = resolveCaller(services.db, env.token, env.channel);
    authorize(spec, caller, services.db);
    const args = validateArgs(spec, env.args);
    const ctx: HandlerCtx = { ...services, caller, ulid: env.ulid, via };

    if (spec.kind === "read") {
      const result = spec.read!({ db: services.db, config: services.config(), now: services.now(), caller, info: services.info(), configStatus: services.configStatus?.() }, args);
      const recorded = spec.afterRead ? this.afterRead(spec, ctx, result) : result;
      return okReply(recorded.data, recorded.hints);
    }

    if (!isUlid(env.ulid)) throw new FlowrynError("bad_envelope", "a mutation needs a ULID idempotency key");
    const running = this.inFlight.get(env.ulid);
    if (running) {
      const reply = await running;
      // The same call spooled while its first copy was still being handled: the spool copy is a duplicate.
      if (via === "spool") tx(services.db, () => this.markSpoolIngested(env.ulid, caller.runId));
      return reply;
    }
    const attempt = this.mutate(spec, ctx, args, env, via);
    this.inFlight.set(env.ulid, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(env.ulid);
    }
  }

  /**
   * A read's recorded effect, in its own transaction. Its failure never fails
   * the read: the reply says what was not recorded, and the daemon logs why.
   */
  private afterRead(spec: VerbSpec, ctx: HandlerCtx, result: HandlerResult): HandlerResult {
    try {
      return tx(ctx.db, () => spec.afterRead!(ctx, result));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.opts.services.log(`gateway: ${spec.name} afterRead failed: ${error instanceof Error ? (error.stack ?? reason) : reason}`);
      return { data: { ...result.data, read: `not closed (${reason})` }, hints: result.hints };
    }
  }

  /**
   * One mutation: prepare, then apply with its stored reply in one transaction,
   * then settle. A replay settles the stored reply again: settlement drives
   * the operation it names by its recorded phase (src/lifecycle/operations.ts),
   * so it finishes interrupted work and never issues an effect twice.
   */
  private async mutate(spec: VerbSpec, ctx: HandlerCtx, args: Args, env: Envelope, via: Via): Promise<Reply> {
    const services = this.opts.services;
    const { caller } = ctx;
    if (spec.ephemeral) {
      if (via === "spool") throw new FlowrynError("bad_envelope", `${spec.name} is never spooled`);
      const prepared = spec.prepare ? await spec.prepare(ctx, args) : undefined;
      const applied = this.applyTx(() => spec.apply!(ctx, args, prepared));
      services.journal.kick();
      const settled = spec.settle ? await spec.settle(ctx, applied) : applied;
      return okReply(settled.data, settled.hints);
    }
    const stored = this.storedReply(env.ulid, via, caller.runId);
    if (stored) return this.settleStored(spec, ctx, stored);

    const prepared = spec.prepare ? await spec.prepare(ctx, args) : undefined;
    const result = this.applyTx((): { stored: Reply } | { applied: HandlerResult } => {
      // Checked again inside the committing transaction: a reply stored meanwhile is this call's, applied once.
      const raced = services.db.query("SELECT reply FROM idempotency WHERE ulid = ?1").get(env.ulid) as { reply: string } | null;
      if (raced) {
        if (via === "spool") this.markSpoolIngested(env.ulid, caller.runId);
        return { stored: JSON.parse(raced.reply) as Reply };
      }
      const applied = spec.apply!(ctx, args, prepared);
      const reply = okReply(applied.data, applied.hints);
      services.db
        .query("INSERT INTO idempotency (ulid, verb, reply, created_at) VALUES (?1, ?2, ?3, ?4)")
        .run(env.ulid, env.verb, JSON.stringify(reply), services.now());
      if (via === "spool") this.markSpoolIngested(env.ulid, caller.runId);
      return { applied };
    });
    if ("stored" in result) return this.settleStored(spec, ctx, result.stored);
    services.journal.kick();
    const settled = spec.settle ? await spec.settle(ctx, result.applied) : result.applied;
    return okReply(settled.data, settled.hints);
  }

  /**
   * The committing transaction of a mutation. A refusal that names an event
   * (a stale observation, src/lifecycle/observed.ts) rolls back the apply and
   * then appends that event in its own transaction, so the refusal is on record.
   */
  private applyTx<T>(fn: () => T): T {
    const { db } = this.opts.services;
    try {
      return tx(db, fn);
    } catch (error) {
      const event = error instanceof FlowrynError ? error.refusalEvent : undefined;
      if (event) tx(db, () => appendEvent(db, event));
      throw error;
    }
  }

  private storedReply(ulid: string, via: Via, runId: string | null): Reply | null {
    const { db } = this.opts.services;
    const row = db.query("SELECT reply FROM idempotency WHERE ulid = ?1").get(ulid) as { reply: string } | null;
    if (!row) return null;
    // The call reached the daemon before the CLI gave up and spooled it; the spool copy is a duplicate.
    if (via === "spool") tx(db, () => this.markSpoolIngested(ulid, runId));
    return JSON.parse(row.reply) as Reply;
  }

  private async settleStored(spec: VerbSpec, ctx: HandlerCtx, stored: Reply): Promise<Reply> {
    if (!stored.ok || !spec.settle) return { ...stored, hints: stored.hints };
    const settled = await spec.settle(ctx, { data: stored.data as HandlerResult["data"], hints: stored.hints });
    return okReply(settled.data, settled.hints);
  }

  private markSpoolIngested(ulid: string, runId: string | null): void {
    this.opts.services.db
      .query("INSERT OR IGNORE INTO spool_ingested (ulid, run_id, ingested_at) VALUES (?1, ?2, ?3)")
      .run(ulid, runId, this.opts.services.now());
  }

  /** Record a spooled call that was refused, so it is never ingested twice and its reason is kept. */
  recordSpoolRejection(ulid: string, runId: string | null, reason: unknown): void {
    const { db } = this.opts.services;
    tx(db, () => {
      this.markSpoolIngested(ulid, runId);
      appendEvent(db, { source: "cli", kind: "spool.rejected", runId, payload: { ulid, reason } });
    });
  }

  /** Drop stored replies older than the retention window. */
  sweepIdempotency(now: number): number {
    return this.opts.services.db.query("DELETE FROM idempotency WHERE created_at < ?1").run(now - IDEMPOTENCY_TTL_MS).changes;
  }
}
