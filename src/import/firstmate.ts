/**
 * Read a Firstmate home's data files (cutover C3): projects.md, backlog.md and
 * note-archive.md, in Firstmate's own line format. Read-only; nothing here
 * writes. One item parser serves the backlog and the archive (tasks-axi's
 * markdown backend writes the same lines).
 */

export interface FmProject {
  name: string;
  mode: "no-mistakes" | "direct-PR" | "local-only" | "no-mistakes-prod-only";
  yolo: boolean;
  description: string;
}

export interface FmItem {
  id: string;
  title: string;
  checked: boolean;
  /** "in flight", "queued", "done", or "archived". */
  section: string;
  tags: Record<string, string>;
  body: string[];
  /** The `## Archived <date>` the item sits under, for note-archive.md. */
  archived: string | null;
}

export interface FmDecision {
  id: string;
  project: string;
  origin: string;
  key: string;
  question: string;
  context: string;
  archived: string | null;
}

export interface FmReview {
  id: string;
  reason: string;
}

const PROJECT_LINE = /^- ([a-z0-9][a-z0-9-]*) \[(no-mistakes-prod-only|no-mistakes|direct-PR|local-only)( \+yolo)?\] - (.+)$/;
const ITEM_LINE = /^- \[( |x)\] ([A-Za-z0-9][A-Za-z0-9._-]*) - (.+)$/;
// Firstmate writes (since <date>), (done <date>) and (merged <date>) without a colon, and the others with one.
const TAG = /\((repo|kind|since|done|merged|hold|hold-kind|hold-until|priority|pr|report):? ([^)]*)\)/g;
const BARE_BLOCKED = /\bblocked-by: ([A-Za-z0-9._-]+)/g;

/** Parse `data/projects.md`'s fleet registry lines; a non-matching line (prose, a heading) is ignored. */
export function parseProjects(text: string): FmProject[] {
  const out: FmProject[] = [];
  for (const line of text.split("\n")) {
    const m = PROJECT_LINE.exec(line.trim());
    if (m) out.push({ name: m[1]!, mode: m[2] as FmProject["mode"], yolo: m[3] !== undefined, description: m[4]!.trim() });
  }
  return out;
}

/** Firstmate's `no-mistakes-prod-only` is Flowryn's plain `no-mistakes`; the other two modes pass through. */
export function mapMode(mode: FmProject["mode"]): "no-mistakes" | "direct-PR" | "local-only" {
  return mode === "no-mistakes-prod-only" ? "no-mistakes" : mode;
}

/** Parse `backlog.md` or an archive file: one item parser for both, since tasks-axi's markdown backend writes the same line shape in each. */
export function parseItems(text: string): FmItem[] {
  const items: FmItem[] = [];
  let section = "archived";
  let archived: string | null = null;
  for (const raw of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      const name = heading[1]!.toLowerCase();
      const date = /^archived (\d{4}-\d{2}-\d{2})$/.exec(name);
      archived = date ? date[1]! : archived;
      section = date ? "archived" : name;
      continue;
    }
    const m = ITEM_LINE.exec(raw);
    if (m) {
      const rest = m[3]!;
      const tags: Record<string, string> = {};
      for (const t of rest.matchAll(TAG)) tags[t[1]!] = t[2]!.trim();
      const blocked = [...rest.matchAll(BARE_BLOCKED)].map((b) => b[1]!);
      if (blocked.length > 0) tags["blocked-by"] = blocked.join(",");
      const title = rest.replace(TAG, "").replace(BARE_BLOCKED, "").replace(/\s+/g, " ").trim();
      items.push({ id: m[2]!, title, checked: m[1] === "x", section, tags, body: [], archived });
      continue;
    }
    if (items.length > 0 && /^\s{2,}\S/.test(raw)) items[items.length - 1]!.body.push(raw.trim());
  }
  return items;
}

/** The imported project an item's `(repo: ...)` tag names, or null when it is unset or not among the imported projects (a Firstmate `org/name` tag is matched by its last segment). */
export function projectOf(repo: string | undefined, projects: Set<string>): string | null {
  if (!repo) return null;
  const name = repo.includes("/") ? repo.split("/").pop()! : repo;
  return projects.has(name) ? name : null;
}

/** A Firstmate captain or decision item: never a task, whatever section it sits in. */
export function isDecisionItem(item: FmItem): boolean {
  return item.tags.kind === "captain" || item.tags.kind === "decision";
}

function bodyField(item: FmItem, name: string): string | null {
  const line = item.body.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

/** A live backlog item (no `## Archived <date>`) is newer than any archived copy. */
function recency(decision: FmDecision): string {
  return decision.archived ?? "9999-99-99";
}

function keyOf(item: FmItem): string | null {
  return bodyField(item, "Decision key") ?? (/-decision-([a-z0-9-]+)$/.exec(item.id)?.[1] ?? null);
}

/**
 * Which Firstmate captain items become decisions. A candidate is a `(kind:
 * captain)` item with a `Decision key:` body line, keyed by `(project, key)`
 * rather than its own id, because Firstmate re-raises the same key across
 * report revisions; a key is resolved the moment any checked `(kind:
 * captain)` item anywhere shares it (`skip resolved`), and among the
 * remaining candidates for one key the live backlog copy, else the newest
 * `## Archived <date>`, wins (`skip superseded`, mapped in `supersededBy` to
 * the winner's id). A held item of another kind, or a captain item with
 * no key, is never silently dropped: it comes back as `review`.
 */
export function selectDecisions(backlog: FmItem[], archive: FmItem[], projects: Set<string>): { decisions: FmDecision[]; skipped: { id: string; reason: string }[]; review: FmReview[]; supersededBy: Map<string, string> } {
  const skipped: { id: string; reason: string }[] = [];
  const review: FmReview[] = [];
  const all = [...backlog, ...archive];
  const resolved = new Map<string, string>();
  for (const item of all) {
    if (!item.checked || item.tags.kind !== "captain") continue;
    const project = projectOf(item.tags.repo, projects);
    const key = keyOf(item);
    if (project && key) resolved.set(`${project}\n${key}`, item.id);
  }
  const candidates: FmDecision[] = [];
  for (const item of all) {
    if (item.checked || item.section === "in flight") continue;
    const project = projectOf(item.tags.repo, projects);
    if (item.tags.kind !== "captain") {
      if (item.tags.hold && item.section === "archived") review.push({ id: item.id, reason: `a held ${item.tags.kind ?? "task"}, not a decision` });
      continue;
    }
    if (!project) {
      skipped.push({ id: item.id, reason: `repo ${item.tags.repo ?? "-"} is not imported` });
      continue;
    }
    const key = bodyField(item, "Decision key");
    if (!key) {
      review.push({ id: item.id, reason: "a captain item with no Decision key" });
      continue;
    }
    const done = resolved.get(`${project}\n${key}`);
    if (done) {
      skipped.push({ id: item.id, reason: `resolved (${done} is done)` });
      continue;
    }
    candidates.push({ id: item.id, project, origin: bodyField(item, "Origin") ?? item.id, key, question: item.title, context: item.tags.hold ?? "", archived: item.archived });
  }
  const newest = new Map<string, FmDecision>();
  const losers = new Map<string, string>();
  for (const c of candidates) {
    const k = `${c.project}\n${c.key}`;
    const prev = newest.get(k);
    if (!prev || recency(c) >= recency(prev)) {
      if (prev) losers.set(prev.id, k);
      newest.set(k, c);
    } else losers.set(c.id, k);
  }
  const supersededBy = new Map<string, string>();
  for (const [id, k] of losers) {
    const winner = newest.get(k)!.id;
    supersededBy.set(id, winner);
    skipped.push({ id, reason: `superseded by ${winner}` });
  }
  return { decisions: [...newest.values()], skipped, review, supersededBy };
}
