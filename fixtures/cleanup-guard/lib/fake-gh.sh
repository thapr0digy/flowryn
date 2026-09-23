#!/usr/bin/env bash
# Fake `gh` for the cleanup-guard fixtures: a minimal, read-only subset of the
# GitHub CLI answered from forge.json (the source of truth). Copied to
# <scenario>/bin/gh by lib/build-common.sh.
#
# Supported:
#   gh pr view [<number>|<url>|<branch>] [--json f1,f2] [-q|--jq <expr>]
#   gh pr list [--head <branch>] [--state open|closed|merged|all]
#              [--limit n] [--json f1,f2] [-q|--jq <expr>]
# -R/--repo is accepted and ignored. JSON field names follow gh (number, url,
# state, headRefName, headRefOid, mergedAt, mergeCommit). An unreachable forge
# fails every call with exit 1, like gh without network.
# forge.json is <script-dir>/../forge.json unless FLOWRYN_FAKE_FORGE is set.
set -uo pipefail

forge=${FLOWRYN_FAKE_FORGE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/forge.json}
[ -f "$forge" ] || { echo "fake gh: forge data not found at $forge" >&2; exit 2; }

if [ "$(jq -r '.reachable' "$forge")" != true ]; then
  echo "error connecting to api.github.com" >&2
  echo "check your internet connection or https://githubstatus.com" >&2
  exit 1
fi

[ "${1:-}" = pr ] || { echo "fake gh: unsupported command: $*" >&2; exit 2; }
sub=${2:-}
shift 2 || true

target="" fields="" jq_expr="" head="" state=open limit=30
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) fields=${2:-}; shift 2 ;;
    --json=*) fields=${1#--json=}; shift ;;
    -q|--jq) jq_expr=${2:-}; shift 2 ;;
    --jq=*) jq_expr=${1#--jq=}; shift ;;
    --head|-H) head=${2:-}; shift 2 ;;
    --state|-s) state=${2:-}; shift 2 ;;
    --limit|-L) limit=${2:-}; shift 2 ;;
    -R|--repo) shift 2 ;;
    -*) echo "fake gh: unsupported flag $1" >&2; exit 2 ;;
    *) target=$1; shift ;;
  esac
done

# Project each PR onto the requested gh fields (all known fields when none).
project='def pick($f): if $f == "" then . else
  (. as $pr | reduce ($f | split(",")[]) as $k ({}; . + {($k): $pr[$k]})) end;'

emit() {
  local json=$1
  if [ -n "$jq_expr" ]; then
    jq -r "$jq_expr" <<<"$json"
  elif [ -n "$fields" ]; then
    printf '%s\n' "$json"
  else
    jq -r 'if type == "array" then .[] else . end
      | "\(.number)\t\(.state)\t\(.headRefName)\t\(.url)"' <<<"$json"
  fi
}

case "$sub" in
  view)
    if [ -z "$target" ]; then
      target=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    fi
    number=""
    case "$target" in
      *"/pull/"*) number=${target##*/pull/}; number=${number%%[!0-9]*} ;;
      [0-9]*) number=${target%%[!0-9]*} ;;
    esac
    pr=$(jq -c --arg n "$number" --arg b "$target" '
      [.pull_requests[] | select(if $n != "" then (.number | tostring) == $n
                                 else .headRefName == $b end)] | first // empty' "$forge")
    if [ -z "$pr" ]; then
      echo "no pull requests found for $target" >&2
      exit 1
    fi
    emit "$(jq -c --arg f "$fields" "$project pick(\$f)" <<<"$pr")"
    ;;
  list)
    emit "$(jq -c --arg h "$head" --arg s "$state" --argjson l "$limit" --arg f "$fields" "$project"'
      [.pull_requests[]
        | select($h == "" or .headRefName == $h)
        | select($s == "all"
            or ($s == "open" and .state == "OPEN")
            or ($s == "closed" and (.state == "CLOSED" or .state == "MERGED"))
            or ($s == "merged" and .state == "MERGED"))
        | pick($f)][:$l]' "$forge")"
    ;;
  *) echo "fake gh: unsupported pr subcommand: $sub" >&2; exit 2 ;;
esac
