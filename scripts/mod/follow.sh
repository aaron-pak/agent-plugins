#!/bin/sh
# follow.sh <checkout> [seconds]: keeps a checkout of a mod's branch on the branch's latest push,
# fast-forward only, looking every <seconds> (default 5). A session that loads the mod from that
# checkout (named in CLAUDE_CODE_PLUGIN_DIRS, with CLAUDE_CODE_PLUGIN_DIR_WATCH=1 for the desktop
# app's sessions) reloads it as each push lands, so a change pushed from anywhere is on screen with no
# restart. Stops when the checkout can't fast-forward (local changes, or a rewritten branch).
set -eu
cd "$1"
every=${2:-5}
branch=$(git symbolic-ref --short HEAD)
echo "Following origin/$branch in $(pwd); Ctrl-C stops."
while :; do
  if git fetch -q origin "$branch" 2>/dev/null && [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
    if ! git merge -q --ff-only FETCH_HEAD; then
      echo "Can't fast-forward to origin/$branch; stopping."
      exit 1
    fi
    echo "$(date +%T) now at $(git log -1 --format='%h %s')"
  fi
  sleep "$every"
done
