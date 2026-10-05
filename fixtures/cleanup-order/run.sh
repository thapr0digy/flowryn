#!/usr/bin/env bash
# fixtures/cleanup-order/run.sh - the second cleanup-guard fixture set (design
# section 14, "a second fixture set, for M4"): the reference's index-lock,
# parked-run-abort, process-reap and ordering cases.
#
# Usage:
#   run.sh                     validate every case: manifest, build, setup and teardown
#   run.sh --impl '<command>'  also run `<command> <scenario-dir>` per case (a full
#                              cleanup, not just a verdict) and check what it did
#   run.sh --case <name>       limit to one case (repeatable)
#   run.sh --keep              keep the temp build directories
#
# Every process a case starts is killed when the case ends (and on any exit).
# Requires bash, git (>= 2.38), jq and perl.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
IMPL=""
KEEP=0
ONLY=()
IMPL_TIMEOUT_S=120

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --impl) IMPL=${2:?--impl needs a command}; shift 2 ;;
    --case) ONLY+=("${2:?--case needs a name}"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for tool in git jq perl; do
  command -v "$tool" >/dev/null || { echo "run.sh: $tool is required" >&2; exit 2; }
done

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_COMMON_DIR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
# Nothing a fixture run starts posts a notification to your Mac.
export FLOWRYN_NOTIFY=off

# The ported cases (docs: README.md): name -> expected outcome.
EXPECTED_CASES='stale_index_lock_cleared_and_cleanup_succeeds removed
live_index_lock_is_never_removed refused
lsof_error_never_clears_index_lock refused
stale_index_lock_cleanup_rechecks_dirty_worktree refused
transient_index_lock_clears_on_retry removed
persistent_index_lock_refuses refused
parked_own_run_is_aborted_before_cleanup removed
parked_run_advanced_head_locally_fetched_is_aborted removed
another_branchs_parked_run_is_never_touched removed
own_autonomous_run_is_left_alone removed
terminal_status_with_gate_is_never_aborted removed
parked_own_run_refuses_when_abort_is_unconfirmed refused
mismatched_run_after_abort_refuses_unconfirmed refused
empty_status_after_abort_refuses_unconfirmed refused
not_found_status_after_abort_confirms_completion removed
leaked_worktree_process_is_reaped removed
lsof_error_refuses_before_removal refused
reused_pid_identity_is_not_force_killed removed
persistent_scan_refuses_after_bounded_retries refused
process_exit_during_identity_lookup_does_not_refuse removed
process_spawned_during_grace_is_reaped_on_later_pass removed
exec_changed_process_is_still_reaped removed
run_abort_precedes_process_reap_precedes_worktree_removal removed'
EXPECTED_COUNT=$(printf '%s\n' "$EXPECTED_CASES" | grep -c .)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cleanup-order-fixtures.XXXXXX") || exit 2

# Kill every process any case started: tracked pids, and children they recorded.
kill_case_processes() {
  local dir=$1 pid
  for f in "$dir/runtime/pids" "$dir/runtime/child-pid"; do
    [ -f "$f" ] || continue
    while IFS= read -r pid; do
      case "$pid" in ''|*[!0-9]*) continue ;; esac
      kill -KILL "$pid" 2>/dev/null || true
    done < "$f"
  done
}

cleanup() {
  local d
  for d in "$WORK"/*/s; do [ -d "$d" ] && kill_case_processes "$d"; done
  [ "$KEEP" = 1 ] || rm -rf "${WORK:?}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

FAILURES=0
suite_fail() { printf 'FAIL  suite: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

CASES=()
for d in "$HERE"/*/; do
  name=$(basename "$d")
  [ "$name" = lib ] && continue
  if [ -f "$d/manifest.json" ] && [ -f "$d/build.sh" ]; then CASES+=("$name")
  else suite_fail "directory $name has no manifest.json/build.sh"; fi
done
[ "${#CASES[@]}" -eq "$EXPECTED_COUNT" ] || suite_fail "expected $EXPECTED_COUNT cases, found ${#CASES[@]}"
listed=$(printf '%s\n' "$EXPECTED_CASES" | awk '{print $1}' | sort)
present=$(printf '%s\n' "${CASES[@]}" | sort)
[ "$listed" = "$present" ] || suite_fail "case set differs from the list in run.sh"

manifest_errors() {
  local name=$1 file=$2
  jq -r --arg name "$name" '
    def str: type == "string" and length > 0;
    [
      (["name","ported_from","description","delivery_mode","inputs","expected"][] | select(. as $k | $root | has($k) | not) | "missing key \(.)"),
      (if .name != $name then "name \(.name) does not match directory \($name)" else empty end),
      (if (.ported_from | str and test("^tests/fm-teardown\\.test\\.sh:test_[a-z0-9_]+$")) | not then "ported_from must be tests/fm-teardown.test.sh:<test function>" else empty end),
      (if .expected.outcome | IN("removed","refused") | not then "expected.outcome must be removed or refused" else empty end),
      (if (.expected.reason_class | str and test("^[a-z][a-z0-9_]*$")) | not then "expected.reason_class must be a snake_case slug" else empty end),
      (if .expected.lock | IN(null,"absent","present") | not then "expected.lock must be absent, present or null" else empty end),
      (if (.expected.abort | type) != "boolean" then "expected.abort must be a boolean" else empty end),
      (if .expected.processes | IN(null,"dead","alive") | not then "expected.processes must be dead, alive or null" else empty end)
    ][]' --argjson root "$(cat "$file")" "$file" 2>&1 || echo "manifest is not valid JSON"
}

# Run the implementation with a hard timeout (macOS has no timeout(1)).
run_impl() {
  local dir=$1 out=$2
  (
    cd "$dir" || exit 97
    PATH="$dir/bin:$PATH" FLOWRYN_SCENARIO="$dir/scenario.json" FLOWRYN_TUNING="$dir/tuning.json" \
      perl -e 'alarm shift; exec @ARGV' "$IMPL_TIMEOUT_S" bash -c "$IMPL"' "$1"' _ "$dir"
  ) > "$out.out" 2> "$out.err"
}

alive() { kill -0 "$1" 2>/dev/null; }

# Post-conditions every case shares, from its manifest's expectations.
state_errors() {
  local dir=$1 exp=$2 out=$3 wt head lock pid want
  wt=$(jq -r '.paths.worktree' "$dir/scenario.json")
  head=$(jq -r '.refs.local_head' "$dir/scenario.json")
  if [ "$(jq -r '.outcome' "$exp")" = refused ]; then
    if [ ! -d "$wt" ]; then echo "worktree was removed after a refusal"
    else
      [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)" = fm/task-x1 ] || echo "task branch was dropped"
      [ "$(git -C "$wt" rev-parse HEAD 2>/dev/null)" = "$head" ] || echo "worktree HEAD moved off local_head"
    fi
  else
    [ ! -e "$wt" ] || echo "worktree still exists after removal"
    ! git -C "$(jq -r '.paths.primary' "$dir/scenario.json")" rev-parse --verify --quiet refs/heads/fm/task-x1 >/dev/null || echo "task branch still exists after removal"
  fi
  want=$(jq -r '.lock // empty' "$exp")
  if [ -n "$want" ]; then
    lock=$(cat "$dir/runtime/lock-path" 2>/dev/null)
    if [ "$want" = present ] && [ ! -e "$lock" ]; then echo "the index.lock was removed"; fi
    if [ "$want" = absent ] && [ -e "$lock" ]; then echo "the index.lock is still there"; fi
  fi
  if [ "$(jq -r '.abort' "$exp")" = true ]; then
    grep -Fxq "abort --run 01RUN" "$dir/nm/abort.log" 2>/dev/null || echo "no-mistakes axi abort --run 01RUN was not called"
  else
    [ ! -s "$dir/nm/abort.log" ] || echo "no-mistakes axi abort was called: $(tr '\n' ' ' < "$dir/nm/abort.log")"
  fi
  want=$(jq -r '.processes // empty' "$exp")
  if [ -n "$want" ]; then
    for pid in $(cat "$dir/runtime/watch-pids" 2>/dev/null) $(cat "$dir/runtime/child-pid" 2>/dev/null); do
      if [ "$want" = dead ] && alive "$pid"; then echo "process $pid survived"; fi
      if [ "$want" = alive ] && ! alive "$pid"; then echo "process $pid was killed"; fi
    done
  fi
  want=$(jq -r '.impl_lock // empty' "$exp")
  if [ -n "$want" ] && [ "$(jq -r '.lock // empty' "$out")" != "$want" ]; then echo "the implementation reported lock $(jq -r '.lock // "none"' "$out"), expected $want"; fi
  for want in $(jq -r '(.order // [])[]' "$exp"); do
    grep -Fxq "$want" "$dir/runtime/order.log" 2>/dev/null || echo "order: $want was not true when the worktree was removed"
  done
}

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
  outcome=$(jq -r '.expected.outcome // "?"' "$manifest" 2>/dev/null || echo "?")
  errors=$(manifest_errors "$name" "$manifest")
  listed_outcome=$(printf '%s\n' "$EXPECTED_CASES" | awk -v n="$name" '$1 == n {print $2}')
  [ "$outcome" = "$listed_outcome" ] || errors+=$'\n'"outcome $outcome differs from the list's ${listed_outcome:-<unlisted>}"
  detail=""
  if [ -z "${errors//$'\n'/}" ]; then
    case_dir="$WORK/$name"
    dir="$case_dir/s"
    mkdir -p "$case_dir"
    if ! bash "$HERE/$name/build.sh" "$dir" > "$case_dir/build.log" 2>&1; then
      errors="build.sh failed: $(tail -3 "$case_dir/build.log" | tr '\n' ' ')"
    else
      for f in scenario.json tuning.json bin/no-mistakes; do [ -s "$dir/$f" ] || errors+=$'\n'"build produced no $f"; done
      jq '.expected' "$manifest" > "$case_dir/expected.json"
      rm -f "$dir/expected.json"
      if [ -z "${errors//$'\n'/}" ] && [ -x "$HERE/$name/setup.sh" ]; then
        bash "$HERE/$name/setup.sh" "$dir" > "$case_dir/setup.log" 2>&1 || errors="setup.sh failed: $(tail -3 "$case_dir/setup.log" | tr '\n' ' ')"
      fi
      detail="built and set up"
      if [ -z "${errors//$'\n'/}" ] && [ -n "$IMPL" ]; then
        run_impl "$dir" "$case_dir/impl"
        rc=$?
        if [ "$rc" -ne 0 ]; then errors="implementation exited $rc: $(tail -3 "$case_dir/impl.err" | tr '\n' ' ')"
        elif ! jq -e 'type == "object" and (.outcome | type == "string")' "$case_dir/impl.out" >/dev/null 2>&1; then
          errors="implementation stdout is not a JSON object with an outcome: $(head -c 200 "$case_dir/impl.out")"
        else
          got=$(jq -r '.outcome' "$case_dir/impl.out")
          [ "$got" = "$outcome" ] || errors+=$'\n'"outcome $got, expected $outcome ($(jq -r '.detail // ""' "$case_dir/impl.out"))"
          got=$(jq -r '.reason_class // empty' "$case_dir/impl.out")
          want=$(jq -r '.reason_class' "$case_dir/expected.json")
          [ -z "$got" ] || [ "$got" = "$want" ] || errors+=$'\n'"reason_class $got, expected $want"
          errors+=$'\n'"$(state_errors "$dir" "$case_dir/expected.json" "$case_dir/impl.out")"
          detail="impl said $(jq -r '.outcome' "$case_dir/impl.out")"
        fi
      fi
      kill_case_processes "$dir"
    fi
  fi
  errors=$(printf '%s\n' "$errors" | sed '/^$/d')
  if [ -z "$errors" ]; then
    PASSED=$((PASSED + 1))
    printf 'PASS  %-8s %-58s %s\n' "$outcome" "$name" "$detail"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL  %-8s %s\n' "$outcome" "$name"
    printf '%s\n' "$errors" | sed 's/^/        - /'
  fi
done

mode="fixtures"
[ -z "$IMPL" ] || mode="implementation: $IMPL"
printf '\n%s cases run (%s): %s passed, %s failed; suite checks: %s failed\n' "$RUN" "$mode" "$PASSED" "$FAILED" "$FAILURES"
[ "$KEEP" = 0 ] || printf 'builds kept in %s\n' "$WORK"
[ "$FAILED" -eq 0 ] && [ "$FAILURES" -eq 0 ]
