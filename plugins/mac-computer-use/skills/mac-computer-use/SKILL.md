---
name: mac-computer-use
description: >-
  Use before any computer use on Aaron's Mac mini through cua-driver. Adapter
  for running the official cua-driver skill and CLI on that Mac from Grok Bot.
---
# cua-driver on Aaron's Mac mini (adapter)

This is only an adapter. How to use cua-driver lives in its official skill on the Mac, which cua-driver keeps current itself. Read it live every time, never copy it, and follow it. This file covers only what changes because the Mac is a different computer from yours, plus a few facts about how this Mac is set up.

## Reaching the Mac
- The Mac is "Aarons-Mac-mini.local", machineId `8a686262-4364-43d9-ab03-fc28cd56bd1b`. Run every cua-driver command with Shell and that machineId, and read Mac files with Read and that machineId. Your own computer has no cua-driver.
- If `cua-driver` isn't on the PATH, use `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`.

## Load the official skill
- Read `~/.cua-driver/skills/cua-driver/SKILL.md` on the Mac, plus any file next to it that it points to and the task needs. Follow it.
- If that folder is missing, run `cua-driver skills install` on the Mac, then read it.

## Differences from running locally
- Every Mac command is a separate remote call, so use the batched forms the official skill offers instead of one command per action.
- Files cua-driver writes, such as screenshots, stay on the Mac. Copy them to your computer with CopyToBox before you open them.

## This Mac's setup
- Several of Aaron's bots share one cua-driver daemon, the LaunchAgent `com.trycua.cua-driver`. Don't stop or restart it during normal work. A restart kills other bots' sessions and drops Chrome's approved connection.
- Aaron turns on Chrome remote debugging himself, so cua doesn't turn it off when sessions end. If a `browser_prepare` result shows `side_effects.enabled_remote_debugging: true`, cua turned it on instead. Tell Aaron to tick the box at `chrome://inspect/#remote-debugging` once.
- The old raw-CDP helper `~/flightshots/cdpd.mjs` and direct port 9222 access are retired. Use cua's browser tools. If a job truly needs a network log, tell Aaron first, because a raw DevTools client can make Chrome prompt and jump to the front.
