# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each plugin is installed on its own, so each harness gets only the plugins you pick for it.

Current plugins:

- `artifact-design` (`artifact-design`, `artifact-diagramming` and `dataviz`, plus an `artifact` MCP server)
- `eli5`
- `frontend-skill`
- `implement-with-notes`
- `session-manager` (a Claude Code mod, see [Mods](#mods))
- `show-me`
- `verification` (`create-verification-skill` and `maintain-verification-skill` together)

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

### The `artifact` server

`artifact-design` runs its `artifact` MCP server, its hook and its `publish.mjs` script with `node` (20 or later), so that command must be on `PATH`. Each is one bundled file, so there is nothing to install. The server reads these environment variables:

- `ARTIFACTS_DIR`: where published artifacts go, one folder each (default `~/artifacts`). A relative path is taken from the folder the server starts in.
- `ARTIFACT_OPEN=0`: don't open a first publish in the browser; the publish result then says the page was not opened.
- `ARTIFACT_PREVIEW=0`: leave out the `preview` action. Without it, `preview` is offered only when Playwright and a Chromium (Playwright's, or an installed Chrome, Chromium or Edge, or Brave on macOS) are found when the server starts.
- `ARTIFACT_PREVIEW_CA`: a PEM CA certificate for previews behind a TLS-inspecting proxy.

Claude Code passes its own environment to the server, so set them in your shell or in Claude Code's `env` setting. Codex starts plugin MCP servers with only a fixed list of variables (`HOME`, `PATH`, `TMPDIR`, `LANG` and a few others), so none of these reach the server under Codex, which always uses the defaults. Page files the model writes go to its scratchpad when Claude Code lists one, and otherwise to a private folder of the session's own under `artifact-drafts-<uid>` in the system temp directory (`artifact-drafts` on Windows), so they stay out of your project. That folder is outside the project, so Claude Code would ask before the first page each session; the plugin's `PreToolUse` hook (`hooks/allow-drafts.mjs`) lets `Write` and `Edit` into it without asking, as Claude Code does for its own scratchpad, and only when the folder is a real one you own. Every other path gets the usual permission check.

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

The `artifact-design` plugin carries Anthropic's built-in Claude Code `artifact-design`, `artifact-diagramming`, and `dataviz` skills, its Markdown page template and its highlight.js runtime, captured from Claude Code 2.1.296. Its `artifact` MCP server stands in for Claude Code's Artifact tool and `ArtifactCheck`. `artifact-diagramming` and `dataviz` are unchanged; [`UPSTREAM.md`](plugins/artifact-design/UPSTREAM.md) lists every change to `artifact-design` and every way the server differs from the Artifact tool. The server's bundles include [marked](https://github.com/markedjs/marked), [Zod](https://github.com/colinhacks/zod) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), all under the MIT license, and the highlight.js runtime keeps its BSD license notice.

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
