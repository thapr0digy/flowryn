#!/usr/bin/env bash
# fixtures/cleanup-guard/lib/build-common.sh - shared builders for the
# cleanup-guard fixtures.
#
# Sourced by every <case>/build.sh. Mirrors the helpers in the reference's
# tests/fm-teardown.test.sh (make_case, wt_commit, wt_commit_file,
# add_fork_with_pushed_branch, land_on_origin_main, commit_tree_from_wt_head,
# land_equivalent_patch_on_origin_branch, setup_squash_rebased_history) so each
# case reproduces the same git topology. The reference's gh/gh-axi shell mocks are
# replaced by DATA: fx_finish renders the manifest's "forge" block into
# forge.json, and bin/gh is a tiny gh-compatible server over that file.
#
# Scenario layout under <out-dir>:
#   origin.git/    bare upstream ("origin"), HEAD -> refs/heads/main
#   primary/       clone of origin (the reference's "project" checkout)
#   worktree/      linked worktree of primary on the task branch fm/task-x1
#   fork.git/      optional second bare remote, registered as "fork" on primary
#   scenario.json  concrete paths, inputs and symbolic-ref -> SHA table
#   forge.json     the fake forge's concrete answers (source of truth)
#   expected.json  the manifest's expectation with symbols resolved
#   bin/gh         optional gh-compatible fake serving forge.json
#
# Determinism: host git config is ignored, identity is fixed, signing is off,
# and every commit takes its dates from a per-scenario clock that advances one
# minute per commit. Commit SHAs are therefore identical on every build and
# independent of <out-dir>.

set -euo pipefail
umask 022

FX_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

# --- git isolation ----------------------------------------------------------
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_COMMON_DIR \
  GIT_CEILING_DIRECTORIES GIT_AUTHOR_DATE GIT_COMMITTER_DATE
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=init.defaultBranch GIT_CONFIG_VALUE_0=main
export GIT_CONFIG_KEY_1=commit.gpgsign GIT_CONFIG_VALUE_1=false
export GIT_CONFIG_KEY_2=tag.gpgsign GIT_CONFIG_VALUE_2=false
export GIT_CONFIG_KEY_3=core.autocrlf GIT_CONFIG_VALUE_3=false
export GIT_AUTHOR_NAME="Flowryn Fixture" GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME="Flowryn Fixture" GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_TERMINAL_PROMPT=0 LC_ALL=C TZ=UTC

FX_TASK_BRANCH=fm/task-x1
FX_DEFAULT_BRANCH=main
FX_PR_NUMBER=7
FX_PR_URL="https://github.com/example/repo/pull/$FX_PR_NUMBER"
FX_CLOCK_BASE=1782432000   # 2026-06-26T00:00:00Z, the reference's fake mergedAt

fx_die() {
  printf 'build error: %s\n' "$*" >&2
  exit 1
}

# Next deterministic epoch second; the counter lives in a file so helpers
# called inside $(...) subshells still advance the shared clock.
fx_tick() {
  local clock="$FX_ROOT/.fx/clock" n
  n=$(cat "$clock")
  n=$((n + 1))
  printf '%s\n' "$n" > "$clock"
  printf '%s\n' "$((FX_CLOCK_BASE + n * 60))"
}

# git with the deterministic clock applied; use for every commit-creating call.
fx_git() {
  local t
  t=$(fx_tick)
  GIT_AUTHOR_DATE="@$t +0000" GIT_COMMITTER_DATE="@$t +0000" git "$@"
}

# fx_init <out-dir> <case-dir>: the reference's make_case, git part only.
fx_init() {
  local out=$1 case_dir=$2 seed
  [ -n "$out" ] || fx_die "usage: build.sh <out-dir>"
  mkdir -p "$out"
  [ -z "$(ls -A "$out")" ] || fx_die "out-dir $out is not empty"
  FX_ROOT=$(cd "$out" && pwd -P)
  FX_CASE_DIR=$(cd "$case_dir" && pwd -P)
  FX_MANIFEST="$FX_CASE_DIR/manifest.json"
  [ -f "$FX_MANIFEST" ] || fx_die "missing $FX_MANIFEST"
  FX_ORIGIN="$FX_ROOT/origin.git"
  FX_PRIMARY="$FX_ROOT/primary"
  FX_WT="$FX_ROOT/worktree"
  FX_FORK=""
  mkdir -p "$FX_ROOT/.fx"
  printf '0\n' > "$FX_ROOT/.fx/clock"
  : > "$FX_ROOT/.fx/refs.tsv"

  git init -q --bare "$FX_ORIGIN"
  git -C "$FX_ORIGIN" symbolic-ref HEAD "refs/heads/$FX_DEFAULT_BRANCH"
  seed="$FX_ROOT/_seed"
  git clone -q "$FX_ORIGIN" "$seed" 2>/dev/null
  fx_git -C "$seed" commit -q --allow-empty -m "origin baseline"
  git -C "$seed" push -q origin "HEAD:refs/heads/$FX_DEFAULT_BRANCH"
  rm -rf "$seed"

  git clone -q "$FX_ORIGIN" "$FX_PRIMARY"
  git -C "$FX_PRIMARY" remote set-head origin "$FX_DEFAULT_BRANCH" >/dev/null
  git -C "$FX_PRIMARY" worktree add -q -b "$FX_TASK_BRANCH" "$FX_WT" "$FX_DEFAULT_BRANCH"
}

# fx_drop_origin: a repository with no remote at all (a notes project,
# docs/notes/2026-10-30-notes-projects-non-8d.md). The primary forgets origin and
# its remote-tracking refs, and origin.git is deleted; scenario.json then has
# no origin path and no remotes, and the origin symbols are not registered.
fx_drop_origin() {
  git -C "$FX_PRIMARY" remote remove origin
  rm -rf "$FX_ORIGIN"
  FX_ORIGIN=""
}

# fx_ref <name> <commit-ish> [repo]: register a symbolic ref for the manifest.
fx_ref() {
  local name=$1 rev=$2 repo=${3:-$FX_PRIMARY} sha
  sha=$(git -C "$repo" rev-parse --verify "$rev^{commit}") \
    || fx_die "fx_ref $name: $rev is not a commit in $repo"
  printf '%s\t%s\n' "$name" "$sha" >> "$FX_ROOT/.fx/refs.tsv"
}

# Empty commit on the task branch (the reference's wt_commit).
fx_wt_commit() {
  fx_git -C "$FX_WT" commit -q --allow-empty -m "${1:-wt work}"
}

# Commit a real file change on the task branch (the reference's wt_commit_file).
fx_wt_commit_file() {
  local file=$1 content=$2 msg=${3:-add $1}
  printf '%s\n' "$content" > "$FX_WT/$file"
  git -C "$FX_WT" add -- "$file"
  fx_git -C "$FX_WT" commit -q -m "$msg"
}

# The reference's add_fork_with_pushed_branch: a second bare remote holding the
# task branch, fetched so refs/remotes/fork/fm/task-x1 exists.
fx_add_fork_with_pushed_branch() {
  FX_FORK="$FX_ROOT/fork.git"
  git init -q --bare "$FX_FORK"
  git -C "$FX_PRIMARY" remote add fork "$FX_FORK"
  git -C "$FX_WT" push -q fork "$FX_TASK_BRANCH"
  git -C "$FX_PRIMARY" fetch -q fork
}

# The reference's land_on_origin_main: a single "squash" commit on origin's default
# branch carrying <file>=<content>. The primary clone is NOT fetched afterwards,
# exactly as in the reference, so its origin/main is stale until the guard fetches.
fx_land_on_origin_main() {
  local file=$1 content=$2 tmp="$FX_ROOT/_land"
  git clone -q "$FX_ORIGIN" "$tmp"
  printf '%s\n' "$content" > "$tmp/$file"
  git -C "$tmp" add -- "$file"
  fx_git -C "$tmp" commit -q -m "squash $file"
  git -C "$tmp" push -q origin "HEAD:refs/heads/$FX_DEFAULT_BRANCH"
  rm -rf "$tmp"
}

# The reference's commit_tree_from_wt_head: a commit with <parent>'s tree whose
# parent is <parent>. It exists only as an unreferenced object in the shared
# object store (a forge-side follow-up commit the worktree never pulled).
fx_commit_tree_from_wt_head() {
  local parent=$1 msg=$2 tree
  tree=$(git -C "$FX_WT" rev-parse "$parent^{tree}")
  printf '%s\n' "$msg" | fx_git -C "$FX_WT" commit-tree "$tree" -p "$parent"
}

# The reference's land_equivalent_patch_on_origin_branch: an origin branch whose
# tip replays <file>=<content> on origin's default branch; fetched into primary.
# Echoes the new branch tip.
fx_land_equivalent_patch_on_origin_branch() {
  local branch=$1 file=$2 content=$3 msg=$4 tmp="$FX_ROOT/_equiv"
  git clone -q "$FX_ORIGIN" "$tmp"
  printf '%s\n' "$content" > "$tmp/$file"
  git -C "$tmp" add -- "$file"
  fx_git -C "$tmp" commit -q -m "$msg"
  git -C "$tmp" push -q origin "HEAD:refs/heads/$branch"
  git -C "$FX_PRIMARY" fetch -q origin "$branch"
  rm -rf "$tmp"
  git -C "$FX_PRIMARY" rev-parse "refs/remotes/origin/$branch"
}

# Mirror GitHub's refs/pull/<n>/head on origin for a PR head the fake forge
# reports. The primary's default refspec never fetches refs/pull/*, so this
# does not make the commit reachable from any remote-tracking branch.
fx_publish_pull_head() {
  local sha=$1
  git -C "$FX_PRIMARY" push -q origin "$sha:refs/pull/$FX_PR_NUMBER/head"
}

# The reference's setup_squash_rebased_history. The pipeline rebased the task onto
# a main that also edited shared.txt, then squash-merged it; refs/pull/7/head
# holds the rebased PR head. local_mode picks what the worktree is left at:
#   rebased                the rebased PR head itself
#   stale                  the pre-rebase local head (different shared.txt blob)
#   rebased-plus-unlanded  the PR head plus one unlanded local commit
# Registers refs: pre_rebase_head, pr_head, squash_commit.
fx_setup_squash_rebased_history() {
  local local_mode=$1 tmp local_head pr_head
  tmp="$FX_ROOT/_shared_base"
  git clone -q "$FX_ORIGIN" "$tmp"
  printf '%s\n' base > "$tmp/shared.txt"
  git -C "$tmp" add -- shared.txt
  fx_git -C "$tmp" commit -q -m "shared base"
  git -C "$tmp" push -q origin "HEAD:refs/heads/$FX_DEFAULT_BRANCH"
  git -C "$FX_WT" fetch -q origin
  git -C "$FX_WT" reset -q --hard "origin/$FX_DEFAULT_BRANCH"
  rm -rf "$tmp"

  fx_wt_commit_file feature.txt hello "add feature"
  printf '%s\n' base feature-edit > "$FX_WT/shared.txt"
  git -C "$FX_WT" add -- shared.txt
  fx_git -C "$FX_WT" commit -q -m "edit shared from feature"
  local_head=$(git -C "$FX_WT" rev-parse HEAD)

  tmp="$FX_ROOT/_main_move"
  git clone -q "$FX_ORIGIN" "$tmp"
  printf '%s\n' base main-edit > "$tmp/shared.txt"
  git -C "$tmp" add -- shared.txt
  fx_git -C "$tmp" commit -q -m "main edits shared"
  git -C "$tmp" push -q origin "HEAD:refs/heads/$FX_DEFAULT_BRANCH"
  rm -rf "$tmp"

  tmp="$FX_ROOT/_pipeline"
  git clone -q "$FX_ORIGIN" "$tmp"
  git -C "$tmp" checkout -q -b "$FX_TASK_BRANCH"
  printf '%s\n' hello > "$tmp/feature.txt"
  git -C "$tmp" add -- feature.txt
  fx_git -C "$tmp" commit -q -m "add feature"
  printf '%s\n' base main-edit feature-edit > "$tmp/shared.txt"
  git -C "$tmp" add -- shared.txt
  fx_git -C "$tmp" commit -q -m "edit shared from feature"
  pr_head=$(git -C "$tmp" rev-parse HEAD)
  git -C "$tmp" push -q origin "HEAD:refs/pull/$FX_PR_NUMBER/head"
  git -C "$tmp" checkout -q "$FX_DEFAULT_BRANCH"
  git -C "$tmp" merge -q --squash "$FX_TASK_BRANCH" >/dev/null
  fx_git -C "$tmp" commit -q -m "feat: squash (#$FX_PR_NUMBER)"
  git -C "$tmp" push -q origin "HEAD:refs/heads/$FX_DEFAULT_BRANCH"
  rm -rf "$tmp"

  git -C "$FX_PRIMARY" fetch -q origin
  git -C "$FX_WT" fetch -q origin "refs/pull/$FX_PR_NUMBER/head:refs/fm-test/pr-head"
  case "$local_mode" in
    rebased) git -C "$FX_WT" reset -q --hard "$pr_head" ;;
    stale) git -C "$FX_WT" reset -q --hard "$local_head" ;;
    rebased-plus-unlanded)
      git -C "$FX_WT" reset -q --hard "$pr_head"
      fx_wt_commit_file later.txt local-only "local follow-up"
      ;;
    *) fx_die "fx_setup_squash_rebased_history: unknown local_mode $local_mode" ;;
  esac
  fx_ref pre_rebase_head "$local_head"
  fx_ref pr_head "$pr_head"
  fx_ref squash_commit "$FX_DEFAULT_BRANCH" "$FX_ORIGIN"
}

# Symbols a manifest may reference: forge PR heads/merge commits, recorded PR
# heads, expected recorded heads, and invariant operands.
fx_manifest_symbols() {
  jq -r '
    [ (.forge.pull_requests // [])[] | (.head, .merge_commit) ] +
    [ .inputs.recorded_pr_head, .expected.recorded_pr_head ] +
    [ (.invariants // [])[] | (.ref, .of, .a, .b) ]
    | map(select(type == "string")) | unique[]' "$FX_MANIFEST"
}

# fx_finish: register the automatic refs, check every manifest symbol resolves,
# and write scenario.json, forge.json, expected.json and bin/gh.
fx_finish() {
  local refs_json sym missing=""
  fx_ref local_head HEAD "$FX_WT"
  fx_ref primary_main "refs/heads/$FX_DEFAULT_BRANCH"
  if [ -n "$FX_ORIGIN" ]; then
    fx_ref tracked_origin_main "refs/remotes/origin/$FX_DEFAULT_BRANCH"
    fx_ref origin_main "refs/heads/$FX_DEFAULT_BRANCH" "$FX_ORIGIN"
  fi

  refs_json=$(jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add' < "$FX_ROOT/.fx/refs.tsv")
  while IFS= read -r sym; do
    [ -n "$sym" ] || continue
    jq -e --arg s "$sym" 'has($s)' <<<"$refs_json" >/dev/null || missing="$missing $sym"
  done < <(fx_manifest_symbols)
  [ -z "$missing" ] || fx_die "manifest symbols not registered by build.sh:$missing"

  jq -n --slurpfile m "$FX_MANIFEST" --argjson refs "$refs_json" \
    --arg branch "$FX_TASK_BRANCH" --arg url_base "${FX_PR_URL%/*}" '
    $m[0].forge as $f
    | def sym: if type == "string" then $refs[.] else null end;
    {
      schema: "flowryn.cleanup-guard.forge.v1",
      provider: "github",
      repo: "example/repo",
      reachable: $f.reachable,
      error: (if $f.reachable then null else ($f.error // "unreachable") end),
      pull_requests: [ ($f.pull_requests // [])[] | {
        number: .number,
        url: "\($url_base)/\(.number)",
        headRefName: (.head_ref_name // $branch),
        state: .state,
        headRefOid: (.head | sym),
        mergedAt: (if .state == "MERGED" then "2026-06-26T00:00:00Z" else null end),
        mergeCommit: (if .merge_commit then {oid: (.merge_commit | sym)} else null end)
      } ]
    }' > "$FX_ROOT/forge.json"

  jq -n --slurpfile m "$FX_MANIFEST" --argjson refs "$refs_json" \
    --arg root "$FX_ROOT" --arg origin "$FX_ORIGIN" --arg primary "$FX_PRIMARY" \
    --arg wt "$FX_WT" --arg fork "$FX_FORK" --arg branch "$FX_TASK_BRANCH" \
    --arg default "$FX_DEFAULT_BRANCH" '
    $m[0] as $man
    | def sym: if type == "string" then $refs[.] else null end;
    {
      schema: "flowryn.cleanup-guard.scenario.v1",
      name: $man.name,
      operation: $man.inputs.operation,
      delivery_mode: $man.delivery_mode,
      task_branch: $branch,
      default_branch: $default,
      paths: {
        root: $root,
        origin: (if $origin == "" then null else $origin end),
        primary: $primary,
        worktree: $wt,
        fork: (if $fork == "" then null else $fork end),
        forge: "\($root)/forge.json",
        bin: "\($root)/bin"
      },
      remotes: ((if $origin == "" then {} else {origin: $origin} end) + (if $fork == "" then {} else {fork: $fork} end)),
      inputs: ($man.inputs | .recorded_pr_head |= sym),
      refs: $refs
    }' > "$FX_ROOT/scenario.json"

  jq -n --slurpfile m "$FX_MANIFEST" --argjson refs "$refs_json" '
    $m[0].expected
    | .recorded_pr_head_symbol = .recorded_pr_head
    | .recorded_pr_head = (if .recorded_pr_head then $refs[.recorded_pr_head] else null end)
    | .local_head = $refs.local_head' > "$FX_ROOT/expected.json"

  mkdir -p "$FX_ROOT/bin"
  cp "$FX_LIB_DIR/fake-gh.sh" "$FX_ROOT/bin/gh"
  chmod +x "$FX_ROOT/bin/gh"
  rm -rf "$FX_ROOT/.fx"
}
