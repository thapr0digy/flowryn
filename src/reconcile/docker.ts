import { findOpenRunItem, openItem } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { getRun, isTerminal, recordEvidence, taskTitle } from "../lifecycle/runs.ts";
import { runBounded } from "../runtime/bounded.ts";
import { openDivergence } from "./divergence.ts";

/**
 * Docker label evidence (design sections 11 and 16). A worker labels every
 * container it starts `flowryn.run=<run id>`; the reconciler lists them with
 * `docker ps --filter label=flowryn.run` on its pass. An environment is one
 * compose project (a container outside compose counts as one on its own).
 * A live run running more environments than its docker_env leases allow is
 * a divergence; containers of a run that ended, or holds no lease, are
 * listed in a P1 and never removed automatically.
 */

export const RUN_LABEL = "flowryn.run";
export const DOCKER_POOL = "docker_env";
const COMPOSE_LABEL = "com.docker.compose.project";
const DOCKER_TIMEOUT_MS = 10_000;

export interface LabelledContainer {
  id: string;
  name: string;
  run: string;
  project: string;
}

/** Parse `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Label "flowryn.run"}}\t{{.Label "com.docker.compose.project"}}'`. */
export function parseDockerPs(text: string): LabelledContainer[] {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 3 && cols[0]!.trim() !== "" && cols[2]!.trim() !== "")
    .map((cols) => ({ id: cols[0]!.trim(), name: cols[1]!.trim(), run: cols[2]!.trim(), project: (cols[3] ?? "").trim() }));
}

/** The labelled containers, or null when Docker cannot be asked (not installed, daemon not running). */
export async function listLabelled(docker: string, timeoutMs = DOCKER_TIMEOUT_MS): Promise<LabelledContainer[] | null> {
  // A cut-off or over-cap listing is a non-zero code: Docker unknown, never "no containers". Stderr is never read.
  const result = await runBounded([docker, "ps", "--filter", `label=${RUN_LABEL}`, "--format", `{{.ID}}\t{{.Names}}\t{{.Label "${RUN_LABEL}"}}\t{{.Label "${COMPOSE_LABEL}"}}`], {
    label: "docker ps",
    timeoutMs,
    stderr: "ignore",
  });
  return result.code === 0 ? parseDockerPs(result.stdout) : null;
}

/** Environments: distinct compose projects, and each container outside compose on its own. */
export function environments(containers: LabelledContainer[]): number {
  return new Set(containers.map((c) => (c.project ? `compose:${c.project}` : `container:${c.id}`))).size;
}

export interface DockerFindings {
  over: string[];
  leftover: string[];
}

/** Compare what runs with what the leases allow; record evidence, divergences and leftovers. */
export function applyDocker(db: Db, containers: LabelledContainer[], now: number): DockerFindings {
  const byRun = new Map<string, LabelledContainer[]>();
  for (const c of containers) byRun.set(c.run, [...(byRun.get(c.run) ?? []), c]);
  const findings: DockerFindings = { over: [], leftover: [] };
  for (const [runId, list] of byRun) {
    const run = getRun(db, runId);
    // Another Flowryn home's containers, or a stray label: not ours to judge.
    if (!run) continue;
    const leased = (db.query("SELECT COUNT(*) AS n FROM pool_leases WHERE run_id = ?1 AND pool = ?2 AND released_at IS NULL").get(runId, DOCKER_POOL) as { n: number }).n;
    const envs = environments(list);
    const names = list.map((c) => c.name).toSorted();
    tx(db, () => {
      recordEvidence(db, runId, "docker", 2, { containers: names, environments: envs, leased }, now);
      if (envs <= leased) return;
      if (isTerminal(run.state) || run.liveness === "dead" || leased === 0) {
        findings.leftover.push(runId);
        if (findOpenRunItem(db, "docker_leftover", runId)) return;
        const event = appendEvent(db, { source: "reconciler", kind: "docker.leftover", runId, taskId: run.task_id, payload: { containers: names, state: run.state }, ts: now });
        openItem(db, {
          kind: "docker_leftover",
          eventSeq: event.seq,
          taskId: run.task_id,
          runId,
          line: `Docker containers left by ${taskTitle(db, run.task_id)} (${run.state}, no environment lease): ${names.join(", ")}; never removed automatically: docker rm -f ${names.join(" ")}`,
          now,
        });
        return;
      }
      findings.over.push(runId);
      openDivergence(db, "reconciler", { runId, taskId: run.task_id, higher: "docker", lower: "run", summary: `run ${runId} runs ${envs} Docker environments (${names.join(", ")}) but holds ${leased} docker_env lease(s)` }, now);
    });
  }
  return findings;
}
