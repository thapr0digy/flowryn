#!/bin/zsh -f
# What zsh's Tab offers for a command line, one candidate per line ("word -- description").
# usage: zsh-complete.zsh <completion script, or a directory to put on $fpath> <line>
# A fresh interactive zsh in a pty loads compinit and the script, wraps compadd to print what it
# is given, then completes the line once (after Valodim's zsh-capture-completion).
zmodload zsh/zpty || exit 3
local script=$1 line=$2 out
zpty z zsh -f -i
local setup_fpath= load_script="source ${(q)script}"
if [[ -d $script ]]; then
  setup_fpath="fpath=(${(q)script} \$fpath)"
  load_script=
fi
local setup=${TMPDIR:-/tmp}/zsh-complete-setup.$$
cat > $setup <<SETUP
PROMPT=
$setup_fpath
autoload -Uz compinit && compinit -u -D
bindkey '^M' undefined
bindkey '^J' undefined
bindkey '^I' complete-word
null-line () { echo -E - \$'\0' }
compprefuncs=( null-line )
comppostfuncs=( null-line exit )
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' insert-tab false
zstyle ':completion:*' list-separator ''
zmodload zsh/zutil
compadd () {
  if [[ \${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
    builtin compadd "\$@"
    return \$?
  fi
  typeset -a __hits __dscr __tmp
  if (( \$@[(I)-d] )); then
    __tmp=\${@[\$[\${@[(i)-d]}+1]]}
    if [[ \$__tmp == \(* ]]; then
      eval "__dscr=\$__tmp"
    else
      __dscr=( "\${(@P)__tmp}" )
    fi
  fi
  builtin compadd -A __hits -D __dscr "\$@"
  setopt localoptions norcexpandparam extendedglob
  typeset -A apre hpre hsuf asuf
  zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
  if [[ -n \$__hits ]]; then
    local dscr
    for i in {1..\$#__hits}; do
      (( \$#__dscr >= \$i )) && dscr=" -- \${\${__dscr[\$i]}##\$__hits[\$i] #}" || dscr=
      echo -E - \$IPREFIX\$apre\$hpre\$__hits[\$i]\$hsuf\$asuf\$dscr
    done
  fi
}
$load_script
echo ok
SETUP
zpty -w z "source ${(q)setup}"
repeat 8; do
  zpty -r z out
  [[ $out == ok* ]] && break
done
[[ $out == ok* ]] || { rm -f $setup; echo "zsh-complete: setup failed: $out" >&2; exit 2 }
zpty -w z "$line"$'\t'
integer tog=0 found=0
# Candidates come between the two NUL lines the pre and post hooks print; the post hook exits the shell.
while zpty -r z; do :; done | while IFS= read -r out; do
  if [[ $out == *$'\0\r' ]]; then
    (( tog++ )) && { found=1; break } || continue
  fi
  (( tog )) && echo -E - ${out%$'\r'}
done
rm -f $setup
(( found )) || exit 2
