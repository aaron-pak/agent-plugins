# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each plugin is installed on its own, so each harness gets only the plugins you pick for it.

Current plugins: `artifact-design` (`artifact-design`, `artifact-diagramming` and `dataviz`, plus an `artifact` MCP server), `eli5`, `frontend-skill`, `implement-with-notes`, `session-manager` (a Claude Code mod, see [Mods](#mods)), `show-me`, and `verification` (`create-verification-skill` and `maintain-verification-skill` together).

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

## Mods

A mod is a Claude Code plugin of function hooks: one TypeScript module that hooks the session's events and draws into its interface (status line, toasts, panes, slash commands) or adds tools. Mods are Claude Code only. They are listed in `marketplace.json` so Claude Code can install them like any other plugin, and their descriptions say Claude Code only for Codex, which reads the same catalog.

A mod folder holds `.claude-plugin/plugin.json` (with `version` unset, as for every plugin here), `hooks/hooks.json` naming the module (`{ "modules": ["./register.tsx"] }`), the module itself, and `tests/*.test.ts`. A mod that keeps values in `$.state` also has `types/index.d.ts` declaring them. Claude Code lays the API types into `.claude-plugin/types/` when it loads the mod (ignored there by its own `.gitignore`), and the mod's `tsconfig.json` extends them.

Current mods:

- `session-manager`: lets a session start separate, full Claude Code sessions and manage them. The model gets `spawn_session` (optionally in its own git worktree, or as a fork of the current conversation), `stop_session` and `list_sessions`. Each new session's final message of a turn comes back to the session that started it, a background session idle past `stopAfterMinutes` (15 by default, in `/config`) is stopped, and a message to a stopped one restarts it first. `/sessions` opens a pane with each session's status, last report, and Stop and Remove buttons.

Install `session-manager` for your user, so every session loads it, including the sessions it starts, which then report back on their own:

```sh
claude plugin install session-manager@agent-plugins --scope user
```

To try a mod from a checkout in one session, check it, and run its tests:

```sh
claude --plugin-dir ~/projects/agent-plugins/plugins/session-manager
claude plugin validate plugins/session-manager
claude plugin test plugins/session-manager
```

The session reloads the mod when its files change, so edits show up without a restart.

## Credits

The `artifact-design` plugin carries Anthropic's built-in Claude Code `artifact-design`, `artifact-diagramming`, and `dataviz` skills, captured from Claude Code 2.1.292. `artifact-diagramming` and `dataviz` are unchanged. `artifact-design` keeps Claude Code's wording; only what nothing outside claude.ai can do is removed, and the header comment in its `SKILL.md` lists each change. The plugin's `artifact` MCP server (`mcp/server.py`, Python 3 standard library) stands in for the Artifact tool, as Claude Code pairs these skills with it: its `quickstart` returns the same page guidance, `publish` wraps the page in the claude.ai skeleton and CDN allowlist and writes it to `~/artifacts` (or `ARTIFACTS_DIR`), and `preview` renders it the way `ArtifactCheck` does when Node and Playwright are installed. Its tool description is adapted from the Artifact tool's. Where the server isn't connected, `scripts/publish.py` and `scripts/preview.mjs` do the same from the shell.

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
