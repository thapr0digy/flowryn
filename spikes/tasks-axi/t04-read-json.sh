#!/usr/bin/env bash
# Design fact rechecked in M0 (design §8 "the journal re-reads tasks-axi list
# --json", §15 "init runs tasks-axi list --file … --json"): the read verbs
# return JSON. Not an M0-marked claim, but the backlog watcher depends on it.
#
# Method: scratch backlog with one task; run list and show with --json, and
# record what the read verbs do support (TOON with --fields).
set -u
. "$(dirname "$0")/lib.sh"
ID=t04-read-json
taxi_init "$ID"
taxi seed add td-read "read target" --kind ship --priority 2

list_json=$(tasks-axi list --file "$BACKLOG" --json 2>&1); rc_list=$?
show_json=$(tasks-axi show td-read --file "$BACKLOG" --json 2>&1); rc_show=$?
toon=$(tasks-axi list --file "$BACKLOG" --fields priority,created,hold_kind 2>&1 | tr '\n' ' ' | cut -c1-200)
mutation_json=$(printf '%s' "$(sed -n 1p "$RUNLOG")" | cut -f2)

evidence="list --json rc=$rc_list ($(printf '%s' "$list_json" | head -n 1)); show --json rc=$rc_show ($(printf '%s' "$show_json" | head -n 1)); mutations accept --json ($mutation_json); list TOON with --fields: $toon"
if [ "$rc_list" = 0 ] && printf '%s' "$list_json" | jq -e . >/dev/null 2>&1; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$TAXI_VERSION" "$evidence"
