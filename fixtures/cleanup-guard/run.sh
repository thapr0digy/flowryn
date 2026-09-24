#!/usr/bin/env bash
# fixtures/cleanup-guard/run.sh - validate the cleanup-guard fixtures and,
# optionally, run an implementation against them.
#
# Usage:
#   run.sh                     validate every fixture (manifest, build,
#                              symbol resolution, topology invariants,
#                              deterministic rebuild)
#   run.sh --impl '<command>'  additionally run `<command> <scenario-dir>` per
#                              case and compare its JSON verdict (README.md)
#   run.sh --case <name>       limit building/running to one case (repeatable)
#   run.sh --keep              keep the temp build directories
#
# Requires bash, git (>= 2.38, for merge-tree --write-tree) and jq.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
IMPL=""
KEEP=0
ONLY=()

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --impl) IMPL=${2:?--impl needs a command}; shift 2 ;;
    --case) ONLY+=("${2:?--case needs a name}"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for tool in git jq; do
  command -v "$tool" >/dev/null || { echo "run.sh: $tool is required" >&2; exit 2; }
done

# Host git config must not leak into validation or the implementation run.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_COMMON_DIR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
# Nothing a fixture run starts posts a notification to your Mac.
export FLOWRYN_NOTIFY=off

# The design's case list (docs/design-v3.html section 14): name -> verdict.
EXPECTED_CASES='local_only_fork_remote allow
local_only_truly_unpushed refuse
local_only_merged_to_local_main allow
no_mistakes_origin_remote allow
no_mistakes_truly_unpushed refuse
squash_merged_branch_deleted allow
squash_merged_pr_when_head_ancestor_of_pr_head allow
no_pr_recorded_discovers_merged_pr_by_branch allow
squash_merged_pr_replayed_unpushed_patch allow
merged_pr_with_later_local_commit refuse
squash_merged_rebased_branch allow
squash_merged_same_file_different_content refuse
squash_merged_rebased_local_with_unlanded_commit refuse
squash_merged_stale_local_when_forge_unreachable refuse
pr_check_does_not_refresh_stale_pr_head record
pr_check_records_remote_head_when_local_lags record
content_in_default_fallback allow
content_fallback_refreshes_stale_origin_ref allow
dirty_worktree refuse
gh_error_and_content_absent refuse
local_only_force_overrides_unpushed discard'
EXPECTED_TALLY="allow=10 discard=1 record=2 refuse=8"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cleanup-guard-fixtures.XXXXXX") || exit 2
cleanup() { [ "$KEEP" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT

FAILURES=0
suite_fail() { printf 'FAIL  suite: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# --- suite-level structure --------------------------------------------------
CASES=()
for d in "$HERE"/*/; do
  name=$(basename "$d")
  case "$name" in lib|reference) continue ;; esac
  if [ -f "$d/manifest.json" ] && [ -f "$d/build.sh" ]; then
    CASES+=("$name")
  else
    suite_fail "directory $name has no manifest.json/build.sh"
  fi
done

[ "${#CASES[@]}" -eq 21 ] || suite_fail "expected 21 cases, found ${#CASES[@]}"
listed=$(printf '%s\n' "$EXPECTED_CASES" | awk '{print $1}' | sort)
present=$(printf '%s\n' "${CASES[@]}" | sort)
[ "$listed" = "$present" ] || suite_fail "case set differs from the design list:
$(diff <(printf '%s\n' "$listed") <(printf '%s\n' "$present") | sed -n 's/^[<>]/  &/p')"
tally=$(for c in "${CASES[@]}"; do jq -r '.expected.verdict' "$HERE/$c/manifest.json" 2>/dev/null; done \
  | sort | uniq -c | awk '{printf "%s%s=%s", sep, $2, $1; sep=" "}')
[ "$tally" = "$EXPECTED_TALLY" ] || suite_fail "verdict counts are '$tally', expected '$EXPECTED_TALLY'"

# --- manifest validation ----------------------------------------------------
# Echoes one error per line; empty output means the manifest is valid.
manifest_errors() {
  local name=$1 file=$2
  jq -r --arg name "$name" '
    def str: type == "string" and length > 0;
    def symbol_or_null: . == null or str;
    [
      (["name","ported_from","description","delivery_mode","inputs","forge","expected"][]
        | select(. as $k | $root | has($k) | not) | "missing key \(.)"),
      (if .name != $name then "name \(.name) does not match directory \($name)" else empty end),
      (if (.ported_from | str and test("^tests/fm-teardown\\.test\\.sh:test_[a-z0-9_]+$")) | not
        then "ported_from must be tests/fm-teardown.test.sh:<test function>" else empty end),
      (if (.description | str) | not then "description must be a non-empty string" else empty end),
      (if .delivery_mode | IN("local-only","no-mistakes","direct-PR") | not
        then "delivery_mode \(.delivery_mode) not in local-only|no-mistakes|direct-PR" else empty end),
      (.expected as $e
        | (if $e.verdict | IN("allow","refuse","record","discard") | not
            then "expected.verdict \($e.verdict) not in allow|refuse|record|discard" else empty end),
          (if ($e.reason_class | str and test("^[a-z][a-z0-9_]*$")) | not
            then "expected.reason_class must be a snake_case slug" else empty end),
          (if $e.verdict == "record" and ($e.recorded_pr_head | str | not)
            then "record verdict needs expected.recorded_pr_head" else empty end),
          (if $e.verdict != "record" and ($e | has("recorded_pr_head"))
            then "only record verdicts carry expected.recorded_pr_head" else empty end)),
      (.inputs as $i
        | (if $i.operation | IN("cleanup","record_pr") | not
            then "inputs.operation must be cleanup or record_pr" else empty end),
          (if ($i.operation == "record_pr") != ($root.expected.verdict == "record")
            then "inputs.operation record_pr iff expected.verdict record" else empty end),
          (if $i.task_branch != "fm/task-x1" then "inputs.task_branch must be fm/task-x1" else empty end),
          (if ($i.recorded_pr_head | symbol_or_null) | not then "inputs.recorded_pr_head must be a symbol or null" else empty end),
          (if $i.operation == "record_pr" and ($i.pr_url_to_record | str | not)
            then "record_pr needs inputs.pr_url_to_record" else empty end),
          (if $root.expected.verdict == "discard"
            then (if ($i.discard_approval.action != "discard" or $i.discard_approval.channel != "human")
                    then "discard verdict needs a human-channel discard approval" else empty end)
            else (if $i.discard_approval != null then "only discard cases carry a discard approval" else empty end)
            end)),
      (.forge as $f
        | (if ($f.reachable | type) != "boolean" then "forge.reachable must be boolean" else empty end),
          (if ($f.pull_requests | type) != "array" then "forge.pull_requests must be an array" else empty end),
          (($f.pull_requests // [])[]
            | (if (.number | type) != "number" then "forge PR needs a number" else empty end),
              (if .state | IN("OPEN","CLOSED","MERGED") | not then "forge PR state \(.state) invalid" else empty end),
              (if (.head | str) | not then "forge PR head must be a symbol" else empty end))),
      ((.invariants // [])[]
        | (if .check | IN("on_remote_tracking","remote_branch","ancestor","same","content_in","patches_in","dirty") | not
            then "unknown invariant check \(.check)" else empty end),
          (if (.expect | type) != "boolean" then "invariant \(.check) needs boolean expect" else empty end))
    ][]' --argjson root "$(cat "$file")" "$file" 2>&1 || echo "manifest is not valid JSON"
}

# --- invariant evaluation on a built scenario -------------------------------
# Object reads span primary, origin and fork; object writes (merge-tree) land in
# a throwaway directory so the built repos are never modified.
declare -A REF
SC_DIR="" PRIMARY="" ORIGIN="" FORK="" WT="" SCRATCH_OBJ=""

load_scenario() {
  local dir=$1 k v
  SC_DIR=$dir
  PRIMARY=$(jq -r '.paths.primary' "$dir/scenario.json")
  ORIGIN=$(jq -r '.paths.origin' "$dir/scenario.json")
  FORK=$(jq -r '.paths.fork // ""' "$dir/scenario.json")
  WT=$(jq -r '.paths.worktree' "$dir/scenario.json")
  REF=()
  while IFS=$'\t' read -r k v; do REF[$k]=$v; done \
    < <(jq -r '.refs | to_entries[] | "\(.key)\t\(.value)"' "$dir/scenario.json")
  SCRATCH_OBJ=$(mktemp -d "$WORK/objects.XXXXXX")
}

gitx() {
  local alternates="$PRIMARY/.git/objects:$ORIGIN/objects"
  [ -z "$FORK" ] || alternates="$alternates:$FORK/objects"
  GIT_OBJECT_DIRECTORY="$SCRATCH_OBJ" GIT_ALTERNATE_OBJECT_DIRECTORIES="$alternates" \
    git -C "$PRIMARY" "$@"
}

is_commit_anywhere() {
  local sha=$1 repo
  for repo in "$PRIMARY" "$ORIGIN" ${FORK:+"$FORK"}; do
    git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null && return 0
  done
  return 1
}

patch_id() { gitx show --pretty=medium --no-ext-diff "$1" | git patch-id --stable | awk 'NR==1{print $1}'; }

# Firstmate's unpushed_patches_are_in_pr_head, evaluated on the fixture.
patches_in() {
  local target=$1 head=${REF[local_head]} base ids c unpushed
  base=$(gitx merge-base "$head" "$target") || return 1
  ids=$(gitx log --format=%H "$base..$target" | while read -r c; do patch_id "$c"; done | sort -u)
  [ -n "$ids" ] || return 1
  unpushed=$(gitx rev-list "$head" --not --remotes)
  [ -n "$unpushed" ] || return 1
  for c in $unpushed; do
    printf '%s\n' "$ids" | grep -qxF "$(patch_id "$c")" || return 1
  done
}

content_in() {
  local target=$1 tree merged
  tree=$(gitx rev-parse "$target^{tree}") || return 1
  merged=$(gitx merge-tree --write-tree "$target" "${REF[local_head]}" 2>/dev/null) || return 1
  [ "$(printf '%s\n' "$merged" | head -1)" = "$tree" ]
}

# eval_invariant <json> -> exit 0 when the observed fact equals .expect
eval_invariant() {
  local inv=$1 check expect observed=false a b remote path
  check=$(jq -r '.check' <<<"$inv")
  expect=$(jq -r '.expect' <<<"$inv")
  case "$check" in
    on_remote_tracking)
      a=${REF[$(jq -r '.ref' <<<"$inv")]}
      [ -n "$(gitx rev-list -n1 "$a" --not --remotes)" ] || observed=true ;;
    remote_branch)
      remote=$(jq -r '.remote' <<<"$inv")
      path=$(git -C "$PRIMARY" remote get-url "$remote" 2>/dev/null) || path=""
      [ -n "$path" ] && git -C "$path" show-ref --verify --quiet \
        "refs/heads/$(jq -r '.branch' <<<"$inv")" && observed=true ;;
    ancestor)
      a=${REF[$(jq -r '.ref' <<<"$inv")]}; b=${REF[$(jq -r '.of' <<<"$inv")]}
      gitx merge-base --is-ancestor "$a" "$b" && observed=true ;;
    same)
      a=${REF[$(jq -r '.a' <<<"$inv")]}; b=${REF[$(jq -r '.b' <<<"$inv")]}
      [ "$a" = "$b" ] && observed=true ;;
    content_in) content_in "${REF[$(jq -r '.ref' <<<"$inv")]}" && observed=true ;;
    patches_in) patches_in "${REF[$(jq -r '.ref' <<<"$inv")]}" && observed=true ;;
    dirty) [ -n "$(git -C "$WT" status --porcelain)" ] && observed=true ;;
  esac
  [ "$observed" = "$expect" ]
}

# Echoes one error per line for a freshly built scenario.
scenario_errors() {
  local name=$1 dir=$2 manifest=$3 sym inv
  for f in scenario.json forge.json expected.json bin/gh; do
    [ -s "$dir/$f" ] || { echo "build produced no $f"; return; }
  done
  jq -e . "$dir/scenario.json" "$dir/forge.json" "$dir/expected.json" >/dev/null 2>&1 \
    || { echo "generated JSON does not parse"; return; }
  load_scenario "$dir"
  for sym in "${!REF[@]}"; do
    is_commit_anywhere "${REF[$sym]}" || echo "ref $sym=${REF[$sym]} is not a commit in the built repos"
  done
  while IFS= read -r sym; do
    [ -n "${REF[$sym]:-}" ] || echo "manifest symbol $sym does not resolve"
  done < <(jq -r '[ (.forge.pull_requests // [])[] | .head, .merge_commit ]
      + [ .inputs.recorded_pr_head, .expected.recorded_pr_head ]
      + [ (.invariants // [])[] | .ref, .of, .a, .b ]
      | map(select(type == "string")) | unique[]' "$manifest")
  [ -d "$WT" ] && [ -f "$WT/.git" ] || echo "worktree $WT is not a linked worktree"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)" = fm/task-x1 ] \
    || echo "worktree is not on fm/task-x1"
  [ "$(git -C "$WT" rev-parse HEAD 2>/dev/null)" = "${REF[local_head]}" ] \
    || echo "local_head does not match the worktree HEAD"
  [ "$(git -C "$PRIMARY" remote get-url origin)" = "$ORIGIN" ] || echo "primary's origin is not origin.git"
  [ "$(git -C "$ORIGIN" symbolic-ref HEAD)" = refs/heads/main ] || echo "origin HEAD is not main"
  jq -e --slurpfile m "$manifest" '.reachable == $m[0].forge.reachable
      and (.pull_requests | length) == ($m[0].forge.pull_requests | length)' "$dir/forge.json" >/dev/null \
    || echo "forge.json disagrees with the manifest's forge block"
  while IFS= read -r inv; do
    eval_invariant "$inv" || echo "invariant failed: $inv"
  done < <(jq -c '(.invariants // [])[]' "$manifest")
}

# --- implementation run -----------------------------------------------------
# run_impl <dir> <out-prefix>: runs the implementation, leaves stdout/stderr in
# <out-prefix>.out/.err, echoes errors.
run_impl() {
  local dir=$1 prefix=$2 rc
  (
    cd "$dir" || exit 97
    PATH="$dir/bin:$PATH" FLOWRYN_FAKE_FORGE="$dir/forge.json" \
      FLOWRYN_SCENARIO="$dir/scenario.json" \
      bash -c "$IMPL"' "$1"' _ "$dir"
  ) > "$prefix.out" 2> "$prefix.err"
  rc=$?
  [ "$rc" -eq 0 ] || { echo "implementation exited $rc: $(tail -3 "$prefix.err" | tr '\n' ' ')"; return; }
  jq -e 'type == "object" and (.verdict | type == "string")' "$prefix.out" >/dev/null 2>&1 \
    || echo "implementation stdout is not a JSON object with a verdict: $(head -c 200 "$prefix.out")"
}

# compare_verdict <prefix> <expected-verdict> <expected-reason> -> errors
compare_verdict() {
  local prefix=$1 want=$2 reason=$3 got got_reason
  got=$(jq -r '.verdict' "$prefix.out")
  [ "$got" = "$want" ] || echo "verdict $got, expected $want"
  got_reason=$(jq -r '.reason_class // empty' "$prefix.out")
  [ -z "$got_reason" ] || [ "$got_reason" = "$reason" ] \
    || echo "reason_class $got_reason, expected $reason"
}

# A refusal (or a record) must leave every recovery route intact.
retained_errors() {
  local dir=$1 wt head
  wt=$(jq -r '.paths.worktree' "$dir/scenario.json")
  head=$(jq -r '.refs.local_head' "$dir/scenario.json")
  [ -d "$wt" ] || { echo "worktree was removed"; return; }
  [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)" = fm/task-x1 ] || echo "task branch was dropped"
  [ "$(git -C "$wt" rev-parse HEAD 2>/dev/null)" = "$head" ] || echo "worktree HEAD moved off local_head"
}

# with_scenario <dir> <jq-filter> <arg-json>: rewrite scenario.json in place.
with_scenario() {
  local dir=$1 filter=$2 arg=${3:-null}
  jq --argjson arg "$arg" "$filter" "$dir/scenario.json" > "$dir/scenario.json.tmp" \
    && mv "$dir/scenario.json.tmp" "$dir/scenario.json"
}

impl_errors() {
  local name=$1 dir=$2 exp=$3 base="$WORK/$name/impl" want reason errs recorded original
  want=$(jq -r '.verdict' "$exp")
  reason=$(jq -r '.reason_class' "$exp")
  original=$(cat "$dir/scenario.json")

  # A discard case must refuse first without its approval (non-destructive).
  if jq -e '.without_discard_approval' "$exp" >/dev/null; then
    with_scenario "$dir" '.inputs.discard_approval = null'
    errs=$(run_impl "$dir" "$base-noapproval")
    [ -n "$errs" ] || errs=$(compare_verdict "$base-noapproval" \
      "$(jq -r '.without_discard_approval.verdict' "$exp")" \
      "$(jq -r '.without_discard_approval.reason_class' "$exp")"; retained_errors "$dir")
    [ -z "$errs" ] || printf 'without discard approval: %s\n' "$errs"
    printf '%s\n' "$original" > "$dir/scenario.json"
  fi

  errs=$(run_impl "$dir" "$base")
  [ -z "$errs" ] || { printf '%s\n' "$errs"; return; }
  compare_verdict "$base" "$want" "$reason"
  recorded=$(jq -r '.recorded_pr_head // empty' "$base.out")
  if [ "$want" = record ]; then
    [ "$recorded" = "$(jq -r '.recorded_pr_head' "$exp")" ] \
      || echo "recorded_pr_head ${recorded:-null}, expected $(jq -r '.recorded_pr_head_symbol' "$exp") ($(jq -r '.recorded_pr_head' "$exp"))"
  else
    [ -z "$recorded" ] || echo "recorded_pr_head must be null for a $want verdict"
  fi
  if jq -e '.pr_url' "$exp" >/dev/null; then
    [ "$(jq -r '.pr_url // empty' "$base.out")" = "$(jq -r '.pr_url' "$exp")" ] \
      || echo "pr_url $(jq -r '.pr_url // "null"' "$base.out"), expected $(jq -r '.pr_url' "$exp")"
  fi
  case "$want" in refuse|record) retained_errors "$dir" ;; esac

  # A record case may be followed by a cleanup that uses what was recorded.
  if [ "$want" = record ] && jq -e '.then_cleanup' "$exp" >/dev/null; then
    with_scenario "$dir" '.operation = "cleanup" | .inputs.operation = "cleanup"
      | .inputs.recorded_pr_url = .inputs.pr_url_to_record
      | .inputs.pr_url_to_record = null | .inputs.recorded_pr_head = $arg' \
      "$(jq -n --arg r "$recorded" 'if $r == "" then null else $r end')"
    errs=$(run_impl "$dir" "$base-then")
    [ -n "$errs" ] || errs=$(compare_verdict "$base-then" \
      "$(jq -r '.then_cleanup.verdict' "$exp")" "$(jq -r '.then_cleanup.reason_class' "$exp")"
      [ "$(jq -r '.then_cleanup.verdict' "$exp")" != refuse ] || retained_errors "$dir")
    [ -z "$errs" ] || printf 'then_cleanup: %s\n' "$errs"
  fi
}

# --- main loop --------------------------------------------------------------
selected() {
  local n=$1 o
  [ "${#ONLY[@]}" -eq 0 ] && return 0
  for o in "${ONLY[@]}"; do [ "$o" = "$n" ] && return 0; done
  return 1
}

PASSED=0 FAILED=0 RUN=0
for name in "${CASES[@]}"; do
  selected "$name" || continue
  RUN=$((RUN + 1))
  manifest="$HERE/$name/manifest.json"
  verdict=$(jq -r '.expected.verdict // "?"' "$manifest" 2>/dev/null || echo "?")
  errors=$(manifest_errors "$name" "$manifest")
  listed_verdict=$(printf '%s\n' "$EXPECTED_CASES" | awk -v n="$name" '$1 == n {print $2}')
  [ "$verdict" = "$listed_verdict" ] \
    || errors+=$'\n'"verdict $verdict differs from the design's ${listed_verdict:-<unlisted>}"
  detail=""
  if [ -z "${errors//$'\n'/}" ]; then
    mkdir -p "$WORK/$name"
    if ! bash "$HERE/$name/build.sh" "$WORK/$name/a" > "$WORK/$name/a.log" 2>&1; then
      errors="build.sh failed: $(tail -3 "$WORK/$name/a.log" | tr '\n' ' ')"
    else
      errors=$(scenario_errors "$name" "$WORK/$name/a" "$manifest")
      if [ -z "$errors" ]; then
        if ! bash "$HERE/$name/build.sh" "$WORK/$name/b" > "$WORK/$name/b.log" 2>&1; then
          errors="second build failed: $(tail -3 "$WORK/$name/b.log" | tr '\n' ' ')"
        elif [ "$(jq -S .refs "$WORK/$name/a/scenario.json")" != "$(jq -S .refs "$WORK/$name/b/scenario.json")" ]; then
          errors="rebuild produced different SHAs (non-deterministic build)"
        fi
      fi
      detail="$(jq '(.invariants // []) | length' "$manifest") invariants, deterministic"
      if [ -z "$errors" ] && [ -n "$IMPL" ]; then
        # The implementation never sees the expectation.
        mv "$WORK/$name/b/expected.json" "$WORK/$name/expected.json"
        errors=$(impl_errors "$name" "$WORK/$name/b" "$WORK/$name/expected.json")
        detail="impl said $(jq -r '.verdict' "$WORK/$name/impl.out" 2>/dev/null || echo '?')"
      fi
    fi
  fi
  errors=$(printf '%s\n' "$errors" | sed '/^$/d')
  if [ -z "$errors" ]; then
    PASSED=$((PASSED + 1))
    printf 'PASS  %-8s %-50s %s\n' "$verdict" "$name" "$detail"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL  %-8s %s\n' "$verdict" "$name"
    printf '%s\n' "$errors" | sed 's/^/        - /'
  fi
done

mode="fixtures"
[ -z "$IMPL" ] || mode="implementation: $IMPL"
printf '\n%s cases run (%s): %s passed, %s failed; suite checks: %s failed; verdicts %s\n' \
  "$RUN" "$mode" "$PASSED" "$FAILED" "$FAILURES" "$tally"
[ "$KEEP" = 0 ] || printf 'builds kept in %s\n' "$WORK"
[ "$FAILED" -eq 0 ] && [ "$FAILURES" -eq 0 ]
