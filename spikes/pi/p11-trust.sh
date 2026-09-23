#!/usr/bin/env bash
# p11-trust: where Pi's trust record lives and whether trust can be settled
# before launch without answering a dialog with keys.
#
# Docs (docs/security.md, 0.87.1): Pi asks for project trust only when the cwd
# has protected project resources (.pi/settings.json, .pi/extensions, .pi/skills,
# .pi/prompts, .pi/themes, .pi/SYSTEM.md, .pi/APPEND_SYSTEM.md, .agents/skills).
# Saved decisions live in <agent-dir>/trust.json (default ~/.pi/agent/trust.json),
# a map of canonical directory -> true/false where the nearest ancestor entry
# wins (0.87.1 dist/core/trust-manager.js). ~/.agents/skills itself is ignored.
# Order: --approve/--no-approve, then a user-level or -e extension's
# project_trust answer, then trust.json, then defaultProjectTrust ("ask").
#
# Method (never answers a prompt; never writes trust.json):
#   A. plain cwd (no .pi): does project_trust fire, is there a gate?
#   B. cwd with .pi/settings.json, probe answers "undecided": does the
#      built-in prompt block startup? (pane is closed unanswered)
#   C. same cwd, probe answers "yes" without remember: startup proceeds?
#   D. same cwd, --approve: startup proceeds without project_trust?
#   trust.json is hashed before and after to prove nothing global changed.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p11-trust
pi_setup

AGENT_DIR="${FLOWRYN_PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
TRUST_FILE="$AGENT_DIR/trust.json"
trust_hash() { [ -e "$TRUST_FILE" ] && shasum -a 256 "$TRUST_FILE" | cut -d' ' -f1 || echo absent; }
hash_before=$(trust_hash)

PROJ="$WORK/cwd-project"
mkdir -p "$PROJ/.pi"
printf '%s\n' '{}' > "$PROJ/.pi/settings.json"

started() { log_has "$1" '.ev == "session_start"' && echo yes || echo no; }
trust_events() { log_count "$1" '.ev == "project_trust"'; }
trusted_flag() { log_first "$1" '.ev == "session_start"' | jq -r '.projectTrusted // "n/a"'; }

# A. plain cwd
pi_launch --no-wait a FLOWRYN_PROBE_TRUST=undecided
log_wait a 60 '.ev == "session_start"' || true
a_line="A plain cwd: started=$(started a) project_trust events=$(trust_events a) trusted=$(trusted_flag a)"
lab_pane_close "$PANE"

# B. project resources, extension undecided -> built-in prompt expected
pi_launch --no-wait --cwd "$PROJ" b FLOWRYN_PROBE_TRUST=undecided
log_wait b 30 '.ev == "project_trust"' || true
sleep 10
pane_snapshot "$PANE" "$WORK/b.trust-screen.txt"
b_started=$(started b)
b_prompt=$(grep -ciE 'trust' "$WORK/b.trust-screen.txt" || true)
b_line="B .pi/settings.json + undecided: project_trust events=$(trust_events b) started within 10 s=$b_started screen lines mentioning trust=$b_prompt"
lab_pane_close "$PANE"

# C. project resources, extension answers yes (no remember)
pi_launch --no-wait --cwd "$PROJ" c FLOWRYN_PROBE_TRUST=yes
log_wait c 60 '.ev == "session_start"' || true
c_line="C extension yes: project_trust events=$(trust_events c) started=$(started c) trusted=$(trusted_flag c)"
lab_pane_close "$PANE"

# D. project resources, --approve
pi_launch --no-wait --cwd "$PROJ" d FLOWRYN_PROBE_TRUST=undecided -- --approve
log_wait d 60 '.ev == "session_start"' || true
d_line="D --approve: project_trust events=$(trust_events d) started=$(started d) trusted=$(trusted_flag d)"
lab_pane_close "$PANE"

hash_after=$(trust_hash)
unchanged=$([ "$hash_before" = "$hash_after" ] && echo yes || echo no)
default_trust=$(jq -r '.defaultProjectTrust // "ask (default)"' "$AGENT_DIR/settings.json" 2>/dev/null || echo "ask (no settings.json)")
evidence="trust record: $TRUST_FILE (before=$hash_before, unchanged=$unchanged); defaultProjectTrust=$default_trust; $a_line; $b_line; $c_line; $d_line"

a_gate=$(trust_events a)
b_events=$(trust_events b)
if [ "$unchanged" = no ]; then
  pi_verdict refuted "a spike run changed the global trust record; $evidence"
elif [ "$b_events" = 0 ] && [ "$b_started" = yes ]; then
  pi_verdict refuted "no trust prompt at all: Pi started in a cwd with .pi/settings.json without any trust decision; $evidence"
elif [ "$b_started" = no ] && [ "$(started c)" = yes ] && [ "$(started d)" = yes ]; then
  if [ "$a_gate" = 0 ]; then
    pi_verdict partial "trust is per project-resource, not per path: a plain worktree has no gate; --approve or a -e project_trust answer settles it per process with no trust.json write; $evidence"
  else
    pi_verdict confirmed "$evidence"
  fi
else
  pi_verdict partial "$evidence"
fi
