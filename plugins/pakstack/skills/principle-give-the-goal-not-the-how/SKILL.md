---
name: principle-give-the-goal-not-the-how
description: "Write prompts that give a model the outcome, the reasons and the limits, and leave the method to its judgment. Use when writing or revising a prompt, skill, instruction file, tool description, a ticket an agent will work from, or a brief for a subagent or another thread."
disable-model-invocation: true
---

# Give the Goal, Not the How

Whoever reads your prompt is a capable model. Give the model judgement. Tell it the outcome you want and why, the necessary context and constraints it needs, and let it work out how. It may find a better way than the one you would have written down, and a prescribed method takes that chance away.

Guidance has a cost. Extra guidance does nothing at best and limits the model at worst, and guidance pointed slightly in the wrong direction is worse than none, because the model follows it anyway. When you can't say why a line is needed, leave it out.

Where prompts go wrong:

- Examples become checklists and templates. A model tends to use every example listed, or copy the closest one. Keep examples general and few, and present them as options.
- Specifics written early become the spec. A later agent follows them literally after the real need has moved on. Point at the live source instead of copying from it; copies go stale.
- Context gets over-weighted. Past decisions, notes and earlier conversation are leads, not facts; say so when you pass them on.
- A line that restates what the model would do anyway is noise, and naming a behavior to forbid it can bring it on. Cut the line, or say what you want instead.

When you brief another agent:

- Include the user's own words for the task, quoted, next to your context. A brief rewritten entirely in your words loses intent, and your misreading reaches every worker.
- Don't narrow the goal into a method the user didn't specify. "Validate what you changed" is not "run the tests you touched."
- Don't add requirements or steps the user didn't ask for. When you want an independent judgment, give the goal and the options without your own lean.

Before you finish, read the prompt as its reader would. If it reads like a checklist for a weaker model, rewrite it to carry the intent instead.
