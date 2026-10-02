# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each plugin is installed on its own, so each harness gets only the plugins you pick for it.

Current plugins: `artifact-design`, `eli5`, `frontend-skill`, `implement-with-notes`, `show-me`, and `verification` (`create-verification-skill` and `maintain-verification-skill` together).

Changing this repository? [AGENTS.md](AGENTS.md) covers the layout, adding a plugin, and the checks CI runs.

## Install a plugin

Claude Code:

```sh
claude plugin marketplace add aaron-pak/agent-plugins
claude plugin install eli5@agent-plugins --scope user   # or --scope project / local
```

Skills appear as `/<plugin>:<skill>`, for example `/eli5:eli5` or `/verification:create-verification-skill`. Pull new commits with `claude plugin marketplace update agent-plugins` and then `claude plugin update eli5@agent-plugins`, or turn on auto-update for this marketplace in `/plugin` → Marketplaces.

Codex:

```sh
codex plugin marketplace add aaron-pak/agent-plugins
codex plugin add eli5@agent-plugins
```

Codex installs plugins for the user and records them in `~/.codex/config.toml`. Pull new commits with `codex plugin marketplace upgrade agent-plugins`, which also refreshes installed plugins. Codex shows every plugin as `1.0.0` and has no auto-update. Remove one with `codex plugin remove eli5@agent-plugins`.

## Global instructions

`instructions/AGENTS.md` holds the shared global instructions and `instructions/CLAUDE.md` imports them for Claude. Link them manually:

```sh
ln -s ~/projects/agent-plugins/instructions/AGENTS.md ~/.codex/AGENTS.md
ln -s ~/projects/agent-plugins/instructions/CLAUDE.md ~/.claude/CLAUDE.md
```

`CLAUDE.md` imports `~/.codex/AGENTS.md`, so both links are needed for Claude to see the shared text.

## Credits

`artifact-design` is Anthropic's built-in Claude Code `artifact-design` skill, with its `artifact-diagramming` sibling as a reference file, captured from Claude Code 2.1.287. It is adapted to produce the same pages outside claude.ai: the Artifact tool's skeleton and rules are written out for the agent to follow, and only what nothing outside claude.ai can do is removed. The header comment in its `SKILL.md` lists each change.

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
