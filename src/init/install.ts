import type { ToolName } from "../config/config.ts";
import { PINNED_TASKS_AXI } from "../version.ts";

/** How to install each tool: init prints these for a missing tool, and doctor ends its missing line with the same words. */
export const INSTALL_HINTS: Record<ToolName, string> = {
  tasks_axi: `npm install -g tasks-axi@${PINNED_TASKS_AXI}`,
  node: "brew install node",
  git: "xcode-select --install",
  gh: "brew install gh, then gh auth login",
  herdr: "install Herdr 0.7.5 or newer (protocol 17); needed from M2",
  claude: "npm install -g @anthropic-ai/claude-code",
  pi: "npm install -g @earendil-works/pi-coding-agent (or the signed Pi Launcher, found as pi-signed)",
  no_mistakes: "install no-mistakes (optional; the no-mistakes delivery mode needs it)",
  docker: "install Docker Desktop (optional; visual QA runs the app's environments in it, and the capacity check counts them)",
  lavish_axi: "npm install -g lavish-axi (optional; review pages, and the answers to a review's questions)",
  gh_axi: "npm install -g gh-axi (needs gh, signed in: gh auth login)",
  jira_axi: "npm install -g jira-axi (needs acli)",
  acli: "brew tap atlassian/homebrew-acli && brew install acli, then acli jira auth login",
  chrome_devtools_axi: "npm install -g chrome-devtools-axi chrome-devtools-mcp",
  sqlite_axi: "npm install -g sqlite-axi",
  quota_axi: "npm install -g quota-axi",
  treehouse: "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh",
};

export interface Installer {
  /** The package manager each step runs (looked up on PATH); a step whose manager is missing skips the tool. */
  needs: "npm" | "brew" | "sh";
  /** Commands run in order, no shell unless the step is `sh -c`. */
  steps: string[][];
  /** Printed after a successful install: the next thing you do yourself (it is interactive, so init never runs it). */
  then?: string;
}

/**
 * The tools init offers to install (Q5): one package-manager command each and
 * nothing to choose. The harnesses, gh, git, node, Herdr, Docker and
 * no-mistakes involve choices that are yours, so they only get a hint.
 */
export const INSTALLERS: Partial<Record<ToolName, Installer>> = {
  tasks_axi: { needs: "npm", steps: [["npm", "install", "-g", `tasks-axi@${PINNED_TASKS_AXI}`]] },
  lavish_axi: { needs: "npm", steps: [["npm", "install", "-g", "lavish-axi"]] },
  gh_axi: { needs: "npm", steps: [["npm", "install", "-g", "gh-axi"]], then: "gh-axi runs gh: sign in with gh auth login" },
  jira_axi: { needs: "npm", steps: [["npm", "install", "-g", "jira-axi"]], then: "jira-axi runs acli for every call" },
  acli: { needs: "brew", steps: [["brew", "tap", "atlassian/homebrew-acli"], ["brew", "install", "acli"]], then: "sign in with acli jira auth login" },
  // The global chrome-devtools-mcp keeps chrome-devtools-axi off `npx -y chrome-devtools-mcp@latest` on each start.
  chrome_devtools_axi: { needs: "npm", steps: [["npm", "install", "-g", "chrome-devtools-axi", "chrome-devtools-mcp"]] },
  sqlite_axi: { needs: "npm", steps: [["npm", "install", "-g", "sqlite-axi"]] },
  quota_axi: { needs: "npm", steps: [["npm", "install", "-g", "quota-axi"]] },
  treehouse: { needs: "sh", steps: [["sh", "-c", "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh"]] },
};

/** A step as you would type it: `sh -c '<script>'` shows the script quoted. */
export function commandLine(step: string[]): string {
  return step.map((part) => (/^[\w@./:=-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(" ");
}
