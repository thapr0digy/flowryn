/**
 * What `scripts/build.sh` stamps into a compiled binary with `bun build
 * --define`: the commit it was built from, whether the tree had uncommitted
 * changes, and the checkout it was built in. The daemon's build watcher
 * applies a new installed build by itself only when it is a clean build of a
 * commit already on the remote's default branch (src/daemon/build-watch.ts).
 * A development command, or a binary from an older build.sh, has no stamp.
 */

declare const FLOWRYN_BUILD_COMMIT: string;
declare const FLOWRYN_BUILD_DIRTY: string;
declare const FLOWRYN_BUILD_SOURCE: string;

export interface BuildStamp {
  commit: string;
  dirty: boolean;
  source: string;
}

function stamped(): BuildStamp | null {
  if (typeof FLOWRYN_BUILD_COMMIT !== "string" || FLOWRYN_BUILD_COMMIT.length === 0) return null;
  return {
    commit: FLOWRYN_BUILD_COMMIT,
    dirty: typeof FLOWRYN_BUILD_DIRTY !== "string" || FLOWRYN_BUILD_DIRTY !== "false",
    source: typeof FLOWRYN_BUILD_SOURCE === "string" ? FLOWRYN_BUILD_SOURCE : "",
  };
}

export const BUILD_STAMP: BuildStamp | null = stamped();
