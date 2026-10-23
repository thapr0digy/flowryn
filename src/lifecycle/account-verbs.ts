import { FlowrynError } from "../api/errors.ts";
import type { VerbSpec } from "../api/verbs.ts";
import { accountsConfig, projectScope, resolveAccount, type Account } from "../config/accounts.ts";
import { listProjects } from "./projects.ts";

function login(account: Account): string {
  if (account.harness === "pi") return `${account.agent_dir ?? "Pi's own (~/.pi/agent)"}${account.provider ? ` provider ${account.provider}` : ""}`;
  if (account.config_dir) return account.config_dir;
  return account.declared ? "Claude's default login (CLAUDE_CONFIG_DIR unset)" : "inherited (the pane's CLAUDE_CONFIG_DIR, else ~/.claude)";
}

/**
 * `flowryn accounts` (docs/notes/2026-10-22-multiple-ai-provider-u9.md): each
 * account with its scope and login reference, and each project with its scope
 * and the account a new run of it starts on, so the separation can be checked
 * before anything runs. A project whose scope or account cannot be resolved
 * shows why instead.
 */
const accounts: VerbSpec = {
  name: "accounts",
  summary: "The AI accounts runs start on, their scopes, and the account each project's runs use",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx) {
    let config;
    try {
      config = accountsConfig(ctx.config);
    } catch (error) {
      throw new FlowrynError("config_invalid", (error as Error).message, "flowryn config");
    }
    const open = ctx.db.query("SELECT account, COUNT(*) AS n FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') GROUP BY account").all() as { account: string | null; n: number }[];
    const running = new Map(open.map((r) => [r.account, r.n]));
    return {
      data: {
        default_scope: config.default_scope,
        accounts: Object.values(config.accounts).map((a) => ({
          account: a.id,
          harness: a.harness,
          scope: a.scope,
          login: login(a),
          model: a.model ?? "default",
          effort: a.effort ?? "default",
          source: a.declared ? "config" : `[workers.${a.harness}]`,
          open_runs: running.get(a.id) ?? 0,
        })),
        projects: listProjects(ctx.db).map((p) => {
          try {
            return { project: p.id, scope: projectScope(ctx.config, config, p), account: resolveAccount(ctx.config, p).id };
          } catch (error) {
            return { project: p.id, scope: "-", account: `refused: ${(error as Error).message}` };
          }
        }),
      },
      hints: ["flowryn dispatch <project> --account <id>", "flowryn config"],
    };
  },
};

export const ACCOUNT_VERBS: readonly VerbSpec[] = [accounts];
