# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each skill is its own plugin, so each harness gets only the plugins you pick for it.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace catalog, named `agent-plugins`. Codex reads this file too.
- `plugins/<name>/`: one plugin per skill. `.claude-plugin/plugin.json` is the manifest and `skills/<name>/` holds the skill with its references and license.
- `instructions/`: the global agent instructions. Nothing installs these; link them by hand (see below).

Current plugins: `artifact-design`, `create-verification-skill`, `eli5`, `maintain-verification-skill`, `show-me`.

Plugin manifests leave `version` unset, so the Git commit decides when an installed plugin is out of date.

## Install a plugin

Claude Code:

```sh
claude plugin marketplace add aaron-pak/agent-plugins
claude plugin install eli5@agent-plugins --scope user   # or --scope project / local
```

Skills from a plugin appear as `/eli5:eli5`. Pull new commits with `claude plugin marketplace update agent-plugins` and then `claude plugin update eli5@agent-plugins`, or turn on auto-update for this marketplace in `/plugin` → Marketplaces.

Codex:

```sh
codex plugin marketplace add aaron-pak/agent-plugins
codex plugin add eli5@agent-plugins
```

Codex installs plugins for the user and records them in `~/.codex/config.toml`. Pull new commits with `codex plugin marketplace upgrade agent-plugins`. Remove one with `codex plugin remove eli5@agent-plugins`.

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
  .claude-plugin/plugin.json   # {"name": "example-mcp", "description": "..."}
  .mcp.json                    # {"mcpServers": {"example": {"command": "npx", "args": ["-y", "example-mcp"]}}}
```

Add a matching entry to `.claude-plugin/marketplace.json`. Pass secrets through environment variables such as `${EXAMPLE_API_KEY}` and keep the values out of this repository. Claude finds `.mcp.json` at the plugin root on its own. Codex's own plugins point to the same file with `"mcpServers": "./.mcp.json"` in their manifest, so add that field to `plugin.json` too, and confirm with `codex mcp list` that Codex starts the server.

## Credits

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.
