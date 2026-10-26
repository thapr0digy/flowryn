/**
 * The daemon's environment for a command it runs on the user's behalf (a
 * verify step, the notify command): minus anything that would point it at
 * this Flowryn (FLOWRYN_*), make it a child of a Claude session, or hand it a
 * GitHub token (a token is only ever sent to GitHub's own API host).
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith("FLOWRYN_") || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "GH_TOKEN" || key === "GITHUB_TOKEN") continue;
    env[key] = value;
  }
  return env;
}
