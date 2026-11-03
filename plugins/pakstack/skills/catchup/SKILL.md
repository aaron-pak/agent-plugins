---
name: catchup
description: Reorient the user on work they left earlier, show where it stands now, and recommend whether to continue, pivot or start over. Use when the user says "catch me up", "where was I", or wants to pick up earlier work again.
---

# Catch up

Catch the user up on work they left earlier, and leave them one choice away from continuing it.
They run many long threads at once and often switch to other work before coming back, so they
don't remember where it stood.

## Find the work

If this thread already holds the work, use what's here. After a compaction, trust the summary
for the goal and the decisions, and go back to the transcript only when it lacks something your
recommendation depends on, such as why an approach was dropped.

In a fresh thread, find the work from the hint the user gave: a topic, branch, PR or ticket. If
they gave none, ask for one. Search their past threads for it. In T3 Code, use
`t3_thread_search` and `t3_thread_read`. Elsewhere, read the session transcripts: Claude Code's
under `~/.claude/projects/`, Codex's under `~/.codex/sessions/`. If the hint matches unrelated
pieces of work, ask which one.

Work may span several threads: attempts, restarts, pivots, earlier catchups, an orchestrator
and its workers. Don't merge them naively. Put them in order and find the current line of work: the
latest decision nothing later reversed. Earlier threads only explain what was tried and why it
was dropped. If the threads and the repo disagree, the repo wins.

If a thread on the work is still running, say so and don't take the work over.

## Check where it stands now

Things may have moved since the work stopped. Before briefing, find out how, without changing
anything local: fetch, then compare the work's branch with its remote and with the current base,
noting whether the base itself has changed. Find merge conflicts with a dry run
(`git merge-tree --write-tree <base> <branch>`). Check the PR's builds and reviews, and any
uncommitted or unpushed work in the old worktree. For work that wasn't code, check what it
touched instead.

## Brief and recommend

Keep the brief short:

- Where it left off: the goal, what got done, what was in progress or blocked.
- What changed since.
- Which thread the brief is based on, and the earlier attempts you set aside, one line each.
- Your call, **continue**, **pivot** or **start over**, with a one-line reason. The user has no
  attachment to the old work, so pick whatever is genuinely best.
- Two or three next steps, yours first. The first step includes any prep the work now needs,
  such as rebasing, resolving conflicts or moving to a new base.

Then stop and wait for the user to pick. Continue in this thread, in the old worktree if it's
still usable.
