---
name: create-skill
description: Write or revise an agent skill so it gives the model only the guidance it needs. Use when the user asks to create, write, edit, revise or improve a skill or a SKILL.md.
---

# Create a skill

Write the skill so it gives the model only the guidance it needs. A capable model already does
most things well: extra guidance does nothing at best and limits the model at worst, and
guidance in a slightly wrong direction is worse than none.

Write for the user's intent: the outcome they want, at the scope they mean it, not only the
case they described. You don't have to use their phrasing; write what works best.

Start thin. The draft holds only what has a basis: something the user asked for, or a mistake
models really make. List your own ideas, including mistakes you expect models might make,
separately as proposals, each with whether you'd add it and a one-line reason, and let the user
choose.

A number makes a limit reliable, but a model tends to treat it as a target. Use one when the
limit matters, and tell the user why that number.

The skill must work on any machine and in any harness, so don't count on the user's own
instruction files to supply what it needs. The body must stand on its own, since a client may
load it without the frontmatter: open with the instruction itself, not a description of it. The
description is one concise line saying what the skill does, then "Use when" with the specific
phrases that should trigger it. Leave out the /<skill> command; it loads the skill anyway.

Write plainly: a sentence the user can't follow on the first read is unclear to the model too.

When you show the draft, give each sentence's basis in a few words, so the user can cut what
they disagree with.
