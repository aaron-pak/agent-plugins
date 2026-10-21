---
name: mac-computer-use
description: >-
  Use before any computer use on Aaron's Mac mini through cua-driver. Adapter
  for running the official cua-driver skill and CLI on that Mac from Grok Bot.
---
# cua-driver on Aaron's Mac mini (adapter)

This is only an adapter. How to use cua-driver lives in its official skill on the Mac, which cua-driver keeps current itself. Read it live every time, never copy it, and follow it. This file covers only what changes because the Mac is a different computer from yours.

## Reaching the Mac
- The Mac is "Aarons-Mac-mini.local", machineId `8a686262-4364-43d9-ab03-fc28cd56bd1b`. Run every cua-driver command with Shell and that machineId, and read Mac files with Read and that machineId. Your own computer has no cua-driver.
- If `cua-driver` isn't on the PATH, use `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`.

## Load the official skill
- Read `~/.cua-driver/skills/cua-driver/SKILL.md` on the Mac, plus any file next to it that it points to and the task needs. Follow it.
- If that folder is missing, run `cua-driver skills install` on the Mac, then read it.

## Differences from running locally
- Every Mac command is a separate remote call, so use the batched forms the official skill offers instead of one command per action.
- Files cua-driver writes, such as screenshots, stay on the Mac. Copy them to your computer with CopyToBox before you open them.
