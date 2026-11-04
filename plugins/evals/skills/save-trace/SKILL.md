---
name: save-trace
description: Bookmark a moment in a conversation that went wrong (or a good example), this one or past ones the user describes, with a note on what happened, so evals can be built from it later. Use when the user says to save or bookmark this conversation, this trace or this failure, or asks to find past conversations where something happened and save them.
---

# Save a trace

A saved trace is a bookmark: the conversation, the moment, whether it went wrong or right, and
what happened. The conversation itself stays where Claude Code keeps it, so the judgment is what's
worth recording; from the bookmark an eval can later be built in any form. The helper is
this plugin's `bin/evals` (`"${CLAUDE_PLUGIN_ROOT}/bin/evals"` in Claude Code); its `trace` and
`sessions` commands are described in
`${CLAUDE_PLUGIN_ROOT}/docs/case-format.md`. Traces are saved under `~/.claude/evals` (or
`$EVALS_HOME`), never in a repository, because they point at real conversations.

## This conversation

`evals trace save --session ${CLAUDE_SESSION_ID}` saves the current conversation. Add:

- `--moment` for each response it's about: a request id (`evals sessions turns <session>`
  lists them), or the user message that reacted to it.
- `--note`: what went wrong and what the user wanted instead. Notes are saved as your reading
  (inferred) unless you pass `--user`, which is only for the user's own words. If they only said
  to save it, infer the problem from the conversation and tell them what you think went wrong so
  they can confirm or correct it. Save a correction by saving the same `--moment` again with their
  words and `--user`, or replace your reading with `trace update <id> --set-note <text> --user`.
- `--good` only when the user says it was a good example.
- `--tag` for the skill, plugin or behavior involved.

Add `--copy` only when a frozen snapshot is wanted, such as for a session that may be deleted.

After saving, run `evals trace show <id>` and check it shows the reply the user meant. A
message moment stands for the reply it reacted to, and when task notifications or command output
arrived during that turn it picks the reply before the first of them (save warns). If it picked
the wrong one, find the right request with `sessions turns` and re-point it with
`trace update <id> --moment <request id>`.

## Past conversations

Search Claude Code sessions with `evals sessions search` (Codex threads aren't read yet):
`--since` for the window, `--used` for a skill or tool the user named, `--user-text` for words
their reaction would contain. The search only narrows the
field. Read each candidate around the match and keep the ones that fit what the user described.
Save each kept moment with a note quoting the reaction that made it a match, and `--tag`, then
check it with `trace show` as above.

Then tell the user what you saved and what you passed over, one line each with the reason, so
they can correct your reading.

Building an eval from saved traces is the **build-eval** skill.
