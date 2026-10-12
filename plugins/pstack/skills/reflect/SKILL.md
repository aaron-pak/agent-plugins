---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript. Don't pass `--all-workspaces` or glob transcript directories by hand. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
<pstack>/scripts/pstack transcripts current
```

It prints this chat's transcript file from the harness's session id. Where it can't (Cursor), run `transcripts list --kind session --limit 10` and take the entry whose first prompt is the conversation's opening user prompt. If none matches, pass a tight digest of the session instead. "Transcripts and state" in the [harness reference](../../references/harness.md) covers the output format.

## 2. Spawn three reviewers in parallel

One message, three writable general subagents (see "Subagents" in the harness reference). Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, so they spawn natively (step 7 of "Models per role" in the harness reference), and read-only in Cursor strips MCPs.

Each reviewer and the synthesizer name a role. Resolve its model with `<pstack>/scripts/pstack models get '<role>'` and spawn per "Models per role" in the harness reference. If a slug fails to start, follow step 6 there.

| Lens | Role | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked and the plugin root for `<pstack>`. Reviewers return findings as their final report.

## 3. Synthesize

One writable general subagent on the `reflect judgment, divergent, synthesizer` role's model. It spot-verifies citations through MCP, and read-only in Cursor strips MCPs. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the harness's skill-authoring skill (see the harness reference) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to the skill-authoring skill and run its description-optimization loop.
- `new skill via skill-authoring: <kebab-name>`: hand creation to the skill-authoring skill. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
