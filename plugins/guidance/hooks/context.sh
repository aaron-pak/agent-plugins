#!/bin/sh
# Prints instructions.md as additionalContext for the hook event named in $1.
# SubagentStart only reads JSON, so both events get the same JSON shape.
text=$(sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' "$(dirname "$0")/../instructions.md" |
  awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$1" "$text"
