# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is an install plus a short conversation.

## Install the plugin

This fork installs from the `aaron-pak/agent-plugins` marketplace. Pick your harness.

In Claude Code, run these in a terminal:

```text
claude plugin marketplace add aaron-pak/agent-plugins
claude plugin install pstack@agent-plugins --scope user
```

In Codex:

```text
codex plugin marketplace add aaron-pak/agent-plugins
codex plugin add pstack@agent-plugins
```

In Cursor, load the fork's `plugins/pstack` directory. It keeps the `.cursor-plugin/plugin.json` manifest Cursor reads. `/add-plugin pstack` installs upstream pstack instead.

For Claude Code and Codex users, cross-family seats run through the other family's CLI. To use both default model families from either harness, install and sign in to both `claude` and `codex`.

## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, asks for a reasoning budget, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `~/.config/pstack/models`, a small config file every pstack skill reads, in every harness.

The defaults run at `xhigh` reasoning, the same as the `large` budget. `unlimited` lifts each model to its highest tier, up to `max`. Opus 5.5 and GPT-6.1 Sol both go to `max`. A model whose highest tier is below `max` stops at that tier. Some GPT models also offer `ultra`, which no budget picks. `medium` and `small` lower the reasoning and spend fewer tokens.

You only override what you care about. A role with no line in the config keeps its default. To restore a default, delete that role's line. A rerun of `/setup-pstack` keeps any role whose model differs from the default. When a default changes, a config written before the change still pins the old default, so delete those role lines, or delete the file, then run `/setup-pstack` again.

You might be wondering what happens if you use Auto. Set a role to `inherit-parent` or `auto` and pstack spawns the subagent with no model set, so it inherits your parent chat model. Both values mean the same thing, and neither is a model slug. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes a `verify-<app>` skill into your project's skill directory, such as `.cursor/skills/`, `.claude/skills/`, or `.agents/skills/`. It's a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

You don't need a new chat after setup. Skills read the config each time they spawn a subagent, so your choices apply from the next one.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. Typing the skill attaches it to one message, and it fades as the chat moves on. To keep `/poteto-mode` on for the whole chat:

- In Cursor, pick it from the `/` menu with Option+Enter (Mac) or Alt+Enter (Windows) instead of Enter. That makes it a [Custom Mode](https://cursor.com/docs/skills), which stays in context on every turn until you exit it. Custom Modes are available in the Agents Window and the CLI.
- In Claude Code, start the session with `claude --agent pstack:poteto-agent`. Every turn then runs as `poteto-agent`, which reads `poteto-mode` first.
- Codex has no mode that stays on. Start each new task with `$poteto-mode`.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
