#!/usr/bin/env bash
# p12-extension-flag: the extension load flag (-e / --extension, docs/cli.md
# 0.87.1: "Resource paths apply only to the current process") scopes the
# Flowryn extension to the one pi process that got the flag.
#
# Method: start instance a with -e and instance b without it, both in the same
# cwd and both with FLOWRYN_PROBE_LOG set. Only a may log. Then start c with
# -e and --no-extensions (-ne): explicit -e paths must still load while
# discovered/global extensions are disabled. A marker extension placed in the
# scratch agent dir's extensions/ (the user-level discovery path,
# docs/configuration.md) shows which launches load global extensions.
# No model call.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p12-extension-flag
pi_setup

GLOBAL_LOG="$WORK/global-extension.log"
mkdir -p "$AGENT_DIR/extensions"
cat > "$AGENT_DIR/extensions/flowryn-global-marker.ts" <<TS
import { appendFileSync } from "node:fs";
export default function (pi: any) {
  pi.on("session_start", () => {
    appendFileSync("$GLOBAL_LOG", \`\${process.env.FLOWRYN_PROBE_INSTANCE ?? "?"}\\n\`);
  });
}
TS
global_loaded() { grep -qx "$1" "$GLOBAL_LOG" 2>/dev/null && echo yes || echo no; }

pi_launch a
pi_launch --no-probe --no-wait b
B=$PANE
sleep 20
pane_snapshot "$B" "$WORK/b.screen.txt"
b_alive=$(grep -c . "$WORK/b.screen.txt" || true)
a_started=$(log_count a '.ev == "session_start"')
a_pid=$(log_first a '.ev == "session_start"' | jq -r '.pid')
b_lines=$( [ -s "$(plog b)" ] && wc -l < "$(plog b)" | tr -d ' ' || echo 0)
foreign=$(jq -r --arg p "$a_pid" 'select(.pid != ($p | tonumber)) | .pid' "$(plog a)" 2>/dev/null | sort -u | tr '\n' ' ')

pi_launch c -- --no-extensions
c_started=$(log_count c '.ev == "session_start"')
sleep 2

evidence="with -e: session_start=$a_started pid=$a_pid global extension loaded=$(global_loaded a); without -e: probe lines=$b_lines (pane screen lines=$b_alive) global extension loaded=$(global_loaded b); other pids in a's log=[${foreign% }]; -e with --no-extensions: session_start=$c_started global extension loaded=$(global_loaded c)"
if [ "$a_started" -ge 1 ] && [ "$b_lines" = 0 ] && [ -z "${foreign// /}" ] && [ "$c_started" -ge 1 ] && [ "$(global_loaded c)" = no ]; then
  pi_verdict confirmed "$evidence"
elif [ "$b_lines" != 0 ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
