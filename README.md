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

The `artifact-design` plugin carries Anthropic's built-in Claude Code `artifact-design`, `artifact-diagramming`, and `dataviz` skills, captured from Claude Code 2.1.293. `artifact-diagramming` and `dataviz` are unchanged. `artifact-design` keeps Claude Code's wording; only what nothing outside claude.ai can do is removed, and the plugin's `UPSTREAM.md` lists each change, outside the skills so the model reads only Claude Code's text. The plugin's `artifact` MCP server (`mcp/server.mjs`, bundled from the TypeScript in `src/`) stands in for the Artifact tool, as Claude Code pairs these skills with it: its `quickstart` returns the same page guidance, `publish` wraps the page in the claude.ai skeleton, adds the Mermaid runtime Claude Code adds to pages with diagrams (the same Mermaid 11.16.1 build, loaded from jsDelivr instead of claude.ai), and writes it to `~/artifacts` (or `ARTIFACTS_DIR`), and `preview` renders it with `ArtifactCheck`'s widths, themes, content policy, step timeouts, checks and report, and returns the captures as images, sized as `ArtifactCheck` sizes them. Like `ArtifactCheck`, it loads only the page, its Mermaid runtime and Google Fonts, so CDN scripts are reported as blocked and the page's own files are listed in a note. A Markdown file is published as Claude Code publishes one: rendered into Claude Code's own document template (`scripts/markdown-template.html`, its plan template copied verbatim from the 2.1.294 CLI), with the eyebrow "Markdown · <file>", the file name as the tab title and the opening heading as the page heading, and ```` ```mermaid ```` fences drawn as diagrams; `preview` declines a Markdown file with `ArtifactCheck`'s own words. Publishing a file unwraps only a page skeleton it or claude.ai added (keeping its `lang` and safe-area choice, as Claude Code does); any other full HTML document goes inside the skeleton as it is. The page's name is read as Claude Code reads it: the first `<title>` in 8,192 characters, ignoring any after an `<svg>`. Like the Artifact tool's file-to-artifact map, which lasts one session, publishing the same path again updates the same artifact only within one server process; a later session's publish makes a new artifact and names the earlier one. Its tool description is adapted from the Artifact tool's, including the rule that a new artifact starts with a `quickstart` call and its full name, and its `quickstart` result matches Claude Code's for an account without Artifact types. Claude Code cuts an MCP tool's description at 2,048 characters and defers MCP tools behind tool search, so the server sends the first paragraph as the tool description and the rest, in order, as its input schema's description, and asks Claude Code to load the tool up front, as Claude Code's own Artifact tool is. Where the server isn't connected, `scripts/publish.mjs` and `scripts/preview.mjs` do the same from the shell.

Where a local machine can't do what claude.ai does, the server differs from the Artifact tool, as follows. The link is a `file://` page on this machine, so the publish result says to share the published `index.html` (not the source file), and says when the page was not opened. The published page carries a Content-Security-Policy meta that mirrors the viewer: Claude Code's own model of it (its preview's policy) plus the five script CDNs the page contract allows, without that policy's `webrtc 'block'`, which Chromium logs as an error on every load. Markdown is rendered by a small renderer of the plugin's own (`src/render-markdown.ts`) instead of marked, and neither Markdown nor HTML pages get the highlight.js runtime Claude Code inlines (about 600 KB). The Mermaid runtime is skipped for a page that loads Mermaid itself with a `<script src>`. A file that was a full HTML document gets a note asking for page content only next time. `read` returns the page without its skeleton, and says publishing adds it. Paths must be absolute, because Codex starts the server in the plugin's folder; links are accepted percent-encoded or not, as a folder or as its `index.html`; an unknown parameter is refused by name; supporting files are all checked before anything is written; publishing a page from inside the artifacts folder updates that artifact; a new artifact never takes a folder that is already on disk; and an unreadable `index.json` is set aside and rebuilt from the artifact folders. Because the page opens from a `file://` link, the description's supporting-files paragraph and the skill's page contract say what such a page can't do with its own files (`fetch()`, module scripts, Workers, canvas export) and that local pages may share one storage origin. Because Claude Code lists a scratchpad only when its own Artifact tool is on, the description and the `quickstart` result send page files to a private drafts folder per session in the system temp directory when the session has no scratchpad, and a `PreToolUse` hook approves writes inside that folder the way Claude Code approves its scratchpad. `preview` is offered only when a startup check finds Playwright and a Chromium, and `ARTIFACT_PREVIEW=0` turns it off; it finds Playwright beside the script or installed globally, never in the project (the startup check would otherwise run the project's code), launches Playwright's full Chromium or an installed browser from Claude Code's own list when Playwright's headless browser is missing, and resizes captures in that browser instead of with `sharp`. It also runs two checks Claude Code's preview lacks, for layout bugs that test pages from both tools shipped: running text that a grid or flex parent splits into separate rows or columns, and an SVG whose labels draw too small to read at phone width (under 7.5 px). Codex shows at most 1,000 bytes of a plugin MCP tool's description and drops every description from an input schema over 5,000 bytes, so when the client is Codex the server sends a compact tool with the lead, the first-call rule, the calls and the page contract's essentials, and leaves the rest to `quickstart`.

`create-verification-skill` and `maintain-verification-skill` come from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/pstack), revision `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, under the MIT licenses included in their directories. The hardcoded Cursor skill paths are generalized to the project's skills directory, and `disable-model-invocation` is set to `false`; the remaining skill text and feature-map examples match upstream.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
