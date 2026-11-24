import { errorReply, okReply, type Reply } from "../api/envelope.ts";
import type { VerbSpec } from "../api/verbs.ts";
import { loadConfig } from "../config/config.ts";
import { openerMode, reviewConfig } from "../config/leader.ts";
import { flowrynHome } from "../config/paths.ts";
import { recordOpen, runOpen } from "../lavish/opener.ts";
import { exitCodeOf, renderReply } from "../cli/render.ts";
import { ping } from "../cli/commands/daemon.ts";

/** What `ping` says of the dashboard (src/daemon/system-verbs.ts). */
interface PingDashboard {
  dashboard?: string | null;
  dashboard_why?: string | null;
}

/** Open the page as review pages open (src/lavish/opener.ts): your browser, the test recorder, or not at all. */
async function openPage(env: NodeJS.ProcessEnv, url: string): Promise<string> {
  const mode = openerMode(env);
  if (mode.kind === "off") return `not opened (${mode.why})`;
  const browser = reviewConfig(loadConfig(flowrynHome(env)).config).browser;
  const result = mode.kind === "record" ? recordOpen(mode.path, browser, url) : await runOpen(browser, url);
  return result.ok ? `opened in ${browser}` : `not opened (${result.why}); open the URL by hand`;
}

/**
 * `flowryn dashboard` (docs/notes/2026-11-24-a-live-build-t8.md): prints the URL of the daemon's
 * live build page and opens it. The daemon serves the page; this verb only finds and opens it.
 */
const dashboard: VerbSpec = {
  name: "dashboard",
  summary: "Open the live build page: running verifies with estimates, the verify queue, landing lines, batches, pools",
  positionals: [],
  flags: {},
  kind: "local",
  roles: ["human", "leader"],
  scope: { kind: "none" },
  async local(_args, io) {
    const pinged = await ping(io.env);
    let reply: Reply;
    if (!pinged?.ok) {
      reply = errorReply({ code: "daemon_unavailable", message: "the daemon is not running, so there is no dashboard", help: "flowryn daemon start" });
    } else {
      const data = pinged.data as PingDashboard;
      if (data.dashboard) reply = okReply({ url: data.dashboard, browser: await openPage(io.env, data.dashboard) }, ["leave it open: it updates every 2 s and reconnects after a daemon restart"]);
      else if (data.dashboard === undefined) reply = errorReply({ code: "not_ready", message: "the running daemon predates the dashboard", help: "flowryn daemon restart" });
      else reply = errorReply({ code: "not_ready", message: `the daemon serves no dashboard: ${data.dashboard_why ?? "unknown"}`, help: "the daemon log in the state directory says more" });
    }
    io.stdout(renderReply(reply, { json: io.json }));
    return exitCodeOf(reply);
  },
};

export const DASHBOARD_VERBS: VerbSpec[] = [dashboard];
