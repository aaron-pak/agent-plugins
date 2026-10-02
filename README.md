# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each plugin is installed on its own, so each harness gets only the plugins you pick for it.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace catalog, named `agent-plugins`. Claude Code and Codex both read it.
- `plugins/<name>/`: one plugin per tool or workflow. `plugin.json` at the plugin root follows the open [Agent Plugins 1.0.0](https://agent-plugins.org) format, which Codex reads natively, and `skills/<skill>/` holds each skill with its references and license. Claude Code takes the plugin's name and description from the marketplace entry and finds `skills/` on its own, so plugins carry no `.claude-plugin/plugin.json`.
- `instructions/`: the global agent instructions. Nothing installs these; link them by hand (see below).

Current plugins: `artifact-design`, `eli5`, `frontend-skill`, `implement-with-notes`, `show-me`, and `verification` (`create-verification-skill` and `maintain-verification-skill` together).

To add a plugin, create `plugins/<name>/plugin.json` and `skills/`, then add a matching entry with the same name and description to `.claude-plugin/marketplace.json`.

Plugin manifests leave `version` unset. Claude Code uses the Git commit as the version. Codex shows every plugin as `1.0.0` but still pulls new commits when the marketplace is upgraded.

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

Codex installs plugins for the user and records them in `~/.codex/config.toml`. Pull new commits with `codex plugin marketplace upgrade agent-plugins`, which also refreshes installed plugins. Codex has no auto-update. Remove one with `codex plugin remove eli5@agent-plugins`.

While editing a plugin, add the local checkout instead (`claude plugin marketplace add ~/projects/agent-plugins`, `codex plugin marketplace add ~/projects/agent-plugins`) so changes show up without pushing.

## Global instructions

`instructions/AGENTS.md` holds the shared global instructions and `instructions/CLAUDE.md` imports them for Claude. Link them manually:

```sh
ln -s ~/projects/agent-plugins/instructions/AGENTS.md ~/.codex/AGENTS.md
ln -s ~/projects/agent-plugins/instructions/CLAUDE.md ~/.claude/CLAUDE.md
```

`CLAUDE.md` imports `~/.codex/AGENTS.md`, so both links are needed for Claude to see the shared text.

## Adding an MCP server plugin

An MCP server gets its own plugin directory so it installs separately from any skill:

```
plugins/example-mcp/
  plugin.json   # {"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "example-mcp"}
  mcp.json      # Agent Plugins format for Codex: {"$schema": ".../mcp.schema.json", "mcpServers": {"example": {"type": "stdio", "command": "npx", "args": ["-y", "example-mcp"]}}}
  .mcp.json     # Claude Code format: {"mcpServers": {"example": {"command": "npx", "args": ["-y", "example-mcp"]}}}
```

Add a matching entry to `.claude-plugin/marketplace.json`. Pass secrets through environment variables such as `${EXAMPLE_API_KEY}` and keep the values out of this repository. The two files describe the same servers in each harness's format. Agent Plugins `mcp.json` requires `type` and exposes `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` to the server. Confirm with `claude mcp list` and `codex mcp list` that each harness starts the server.

## Mods

A mod is a Claude Code plugin of function hooks: one TypeScript module that hooks the session's events and draws into its interface (status line, toasts, a band above the prompt, panes, slash commands). Mods are Claude Code only, so they stay out of `marketplace.json`, which Codex also reads.

A mod folder holds `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the module (`{ "modules": ["./register.ts"] }`), the module itself, and `tests/*.test.ts`. Claude Code lays the API types into `.claude-plugin/types/` when it loads the mod (ignored there by its own `.gitignore`), and the mod's `tsconfig.json` extends them.

Current mods:

- `context-meter`: a status line entry with the context window's fill and the session's cost, a toast when context passes 80% (the `warnAt` option in `/config`), and `/meter` for the details.

Try one in a session, check it, and run its tests:

```sh
claude --plugin-dir ~/projects/agent-plugins/plugins/context-meter
claude plugin validate plugins/context-meter
claude plugin test plugins/context-meter
```

The session reloads the mod when its files change, so edits show up without a restart.

## Credits

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
