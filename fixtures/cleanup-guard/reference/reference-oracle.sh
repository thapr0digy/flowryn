#!/usr/bin/env bash
# reference/reference-oracle.sh - run the ORIGINAL reference logic (the previous
# orchestrator's teardown) against a built
# cleanup-guard scenario, as a cross-check of the expected verdicts.
#
# Usage: REFERENCE_REPO=<checkout> run.sh --impl reference/reference-oracle.sh
#    or: REFERENCE_REPO=<checkout> reference-oracle.sh <built-scenario-dir>
#
# Speaks the run.sh implementation contract: prints
# {"verdict": ..., "recorded_pr_head": ..., "pr_url": ...} on stdout.
#   cleanup   -> bin/fm-teardown.sh task-x1 [--force when a discard approval
#                is present]; exit 0 = allow (discard under --force),
#                exit 1 with a REFUSED line = refuse.
#   record_pr -> bin/fm-pr-check.sh task-x1 <url>; the pr_head= it wrote.
#
# Isolation (never touches the reference's real home, state, data or processes):
#   * The reference is exported with `git archive` at REFERENCE_REV (default HEAD)
#     into a cache under $TMPDIR, and run from that copy. Its host-wide
#     fm-remote-job-reap-orphans.sh sweep is replaced by a no-op there.
#   * FM_HOME/state/data/config all point into a per-run temp world.
#   * treehouse, tmux, no-mistakes and lsof are stubbed on PATH; gh is the
#     scenario's fake (bin/gh); gh-axi is a shim over the same forge.json.
# REFERENCE_REPO names the reference checkout; it is required.
set -uo pipefail

dir=$(cd "${1:?usage: reference-oracle.sh <scenario-dir>}" && pwd -P)
sc="$dir/scenario.json"
REFERENCE_REV=${REFERENCE_REV:-HEAD}

die() { printf 'reference-oracle: %s\n' "$*" >&2; exit 3; }
[ -n "${REFERENCE_REPO:-}" ] || die "set REFERENCE_REPO to the reference checkout"
command -v jq >/dev/null || die "jq is required"
[ -f "$sc" ] || die "no scenario.json in $dir"

rev=$(git -C "$REFERENCE_REPO" rev-parse --verify "$REFERENCE_REV^{commit}" 2>/dev/null) \
  || die "cannot resolve $REFERENCE_REV in $REFERENCE_REPO"
FM_COPY="${TMPDIR:-/tmp}/flowryn-fm-oracle-${rev:0:12}"
if [ ! -x "$FM_COPY/bin/fm-teardown.sh" ]; then
  staging=$(mktemp -d "${TMPDIR:-/tmp}/flowryn-fm-oracle-staging.XXXXXX") || die "mktemp failed"
  git -C "$REFERENCE_REPO" archive "$rev" | tar -x -C "$staging" || die "git archive failed"
  printf '#!/usr/bin/env bash\n# oracle: host-wide orphan sweep disabled\nexit 0\n' \
    > "$staging/bin/fm-remote-job-reap-orphans.sh"
  mv "$staging" "$FM_COPY" 2>/dev/null || rm -rf "$staging"   # lost a race: reuse the winner
fi

world=$(mktemp -d "${TMPDIR:-/tmp}/flowryn-fm-oracle-world.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$world"' EXIT
mkdir -p "$world/home" "$world/state" "$world/data" "$world/config" "$world/fakebin"
chmod 755 "$world/state"
touch "$world/state/.last-watcher-beat"

fakebin="$world/fakebin"
for stub in treehouse tmux no-mistakes; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fakebin/$stub"
done
# lsof: nothing holds anything open (the reference's add_lsof_no_holder).
cat > "$fakebin/lsof" <<'SH'
#!/usr/bin/env bash
case " $* " in *" -d cwd "*) exit 0 ;; esac
exit 1
SH
ln -s "$dir/bin/gh" "$fakebin/gh"
# gh-axi shim in the reference's TOON-ish list format, answered from forge.json.
cat > "$fakebin/gh-axi" <<SH
#!/usr/bin/env bash
forge="$dir/forge.json"
[ "\$(jq -r .reachable "\$forge")" = true ] || { echo "error: gh-axi unavailable" >&2; exit 1; }
head=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[i]}" = --head ] && head=\${args[i+1]:-}
done
case "\${1:-} \${2:-}" in
  "pr list")
    rows=\$(jq -r --arg h "\$head" '[.pull_requests[] | select(\$h == "" or .headRefName == \$h)]
      | .[] | "  \(.number),\(.state | ascii_downcase)"' "\$forge")
    n=\$(printf '%s' "\$rows" | grep -c . || true)
    printf 'count: %s (showing first %s)\n' "\$n" "\$n"
    if [ "\$n" -gt 0 ]; then printf 'pull_requests[%s]{number,state}:\n%s\n' "\$n" "\$rows"
    else printf 'pull_requests[]: []\n'; fi
    exit 0 ;;
  "pr view") echo "error: pull request not found" >&2; exit 1 ;;
esac
exit 0
SH
chmod +x "$fakebin"/*

wt=$(jq -r '.paths.worktree' "$sc")
primary=$(jq -r '.paths.primary' "$sc")
mode=$(jq -r '.delivery_mode' "$sc")
[ "$mode" != direct-PR ] || mode=pr   # the reference treats every non-local-only mode alike here
operation=$(jq -r '.operation' "$sc")
pr_url=$(jq -r '.inputs.recorded_pr_url // empty' "$sc")
pr_head=$(jq -r '.inputs.recorded_pr_head // empty' "$sc")
meta="$world/state/task-x1.meta"
{
  printf '%s\n' "window=oracle:fm-task-x1" "endpoint_task_id=task-x1" \
    "worktree=$wt" "project=$primary" "kind=ship" "mode=$mode" "spawn_gen=oracle-task-x1"
  [ -z "$pr_url" ] || printf 'pr=%s\n' "$pr_url"
  [ -z "$pr_head" ] || printf 'pr_head=%s\n' "$pr_head"
} > "$meta"

fm_env=(env FM_ROOT_OVERRIDE="$FM_COPY" FM_HOME="$world/home"
  FM_STATE_OVERRIDE="$world/state" FM_DATA_OVERRIDE="$world/data"
  FM_CONFIG_OVERRIDE="$world/config" FM_GATE_REFUSE_BYPASS=1
  PATH="$fakebin:$PATH")
unset FM_TASK_ID TASKS_AXI_FILE TASKS_AXI_BACKEND

case "$operation" in
  record_pr)
    url=$(jq -r '.inputs.pr_url_to_record' "$sc")
    "${fm_env[@]}" "$FM_COPY/bin/fm-pr-check.sh" task-x1 "$url" >"$world/out" 2>"$world/err" \
      || die "fm-pr-check failed: $(tail -3 "$world/err" | tr '\n' ' ')"
    [ "$(grep -c '^pr_head=' "$meta")" -le 1 ] || die "fm-pr-check recorded more than one pr_head"
    recorded=$(sed -n 's/^pr_head=//p' "$meta" | tail -1)
    jq -n --arg h "$recorded" --arg u "$url" \
      '{verdict: "record", recorded_pr_head: (if $h == "" then null else $h end), pr_url: $u}'
    ;;
  cleanup)
    force=()
    [ "$(jq -r '.inputs.discard_approval.action // empty' "$sc")" != discard ] || force=(--force)
    # Seed a backlog row so a completed teardown records the PR it relied on.
    if command -v tasks-axi >/dev/null; then
      printf '%s\n' '# Backlog' '' '## In flight' '' '## Queued' '' '## Done' > "$world/data/backlog.md"
      tasks-axi add task-x1 "oracle task" --kind ship --file "$world/data/backlog.md" >/dev/null 2>&1 \
        && tasks-axi start task-x1 --file "$world/data/backlog.md" >/dev/null 2>&1
    fi
    "${fm_env[@]}" "$FM_COPY/bin/fm-teardown.sh" task-x1 "${force[@]}" >"$world/out" 2>"$world/err"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      verdict=allow
      [ "${#force[@]}" -eq 0 ] || verdict=discard
    elif [ "$rc" -eq 1 ] && grep -q REFUSED "$world/err"; then
      verdict=refuse
    else
      die "fm-teardown exited $rc without a verdict: $(tail -5 "$world/err" | tr '\n' ' ')"
    fi
    used_url=$(grep -o 'https://github.com/example/repo/pull/[0-9]*' "$world/data/backlog.md" 2>/dev/null | head -1)
    [ "$verdict" != refuse ] || used_url=""
    jq -n --arg v "$verdict" --arg u "$used_url" \
      '{verdict: $v, recorded_pr_head: null, pr_url: (if $u == "" then null else $u end)}'
    ;;
  *) die "unknown operation $operation" ;;
esac
