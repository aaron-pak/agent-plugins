# Agent plugins

Aaron's personal skills, packaged as a plugin marketplace that both Claude Code and Codex can install from. Each plugin is installed on its own, so each harness gets only the plugins you pick for it.

Current plugins:

- `artifact-design` (`artifact-design`, `artifact-diagramming` and, in Codex, `dataviz`, plus an `artifact` MCP server)
- `deeper-task` (Felix Rieseberg's prompt, see [Credits](#credits))
- `eli5`
- `frontend-skill`
- `implement-with-notes`
- `mac-computer-use` (Grok Bot only, see [Grok Bot](#grok-bot))
- `session-band` (a Claude Code mod, see [Mods](#mods))
- `show-me`

Changing this repository? [AGENTS.md](AGENTS.md) covers the layout, adding a plugin, and the checks CI runs.

## Install a plugin

Claude Code:

```sh
claude plugin marketplace add aaron-pak/agent-plugins
claude plugin install eli5@agent-plugins --scope user   # or --scope project / local
```

Skills appear as `/<plugin>:<skill>`, for example `/eli5:eli5` or `/artifact-design:artifact-diagramming`. Pull new commits with `claude plugin marketplace update agent-plugins` and then `claude plugin update eli5@agent-plugins`, or turn on auto-update for this marketplace in `/plugin` → Marketplaces.

Codex:

```sh
codex plugin marketplace add aaron-pak/agent-plugins
codex plugin add eli5@agent-plugins
```

Codex installs plugins for the user and records them in `~/.codex/config.toml`. Pull new commits with `codex plugin marketplace upgrade agent-plugins`, which also refreshes installed plugins. Codex shows a plugin without a version as `1.0.0` or `local` and has no auto-update. Remove one with `codex plugin remove eli5@agent-plugins`.

### Grok Bot

Grok Bot installs plugins from Cursor's marketplaces. Cursor reads `.cursor-plugin/marketplace.json` for multi-plugin repos ([Plugins reference](https://cursor.com/docs/reference/plugins)), so this file lists every plugin meant for Cursor and Grok Bot: the Claude Code catalog, except plugins whose description says Claude Code only (`session-band`). `mac-computer-use` is the one entry with `minClientVersions.cursor` set to `never`, which hides it from Cursor.

Team marketplaces are available on Teams and Enterprise plans. Add one from Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace, using Import from Repo. Auto Refresh is a Marketplace Setting there: on a GitHub import it re-indexes when commits are pushed to the tracked branch, which requires the Cursor GitHub App, and Cursor re-indexes at most once every 10 minutes. On a marketplace created with Import from Repo, Auto Refresh re-reads the full manifest on each push. See [Plugins](https://cursor.com/docs/plugins). Aaron is on Pro, so this repository is a personal marketplace, and Cursor's docs describe no refresh for those.

### The `artifact` server

`artifact-design` runs its `artifact` MCP server with `node` (20 or later), so that command must be on `PATH`. The server is one bundled file, so there is nothing to install. The server reads these environment variables:

- `ARTIFACTS_DIR`: where published artifacts go, one folder each (default `~/artifacts`). A relative path is taken from the folder the server starts in.
- `ARTIFACT_OPEN=0`: don't open a first publish in the browser; the publish result then says the page was not opened.
- `ARTIFACT_PREVIEW=0`: leave out the `ArtifactCheck` tool, which previews a page before publishing. Without it, `ArtifactCheck` is offered only when Playwright and a Chromium are found: Playwright's own, or an installed Chrome or Chromium (also Edge on macOS and Windows, and Brave on macOS). Playwright isn't bundled, so install it once, globally: with Chrome installed, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright` is enough. Each start lists the answer its last start found and checks again for the next one, and when preview is off the server says why on its stderr, which Claude Code keeps in its MCP logs (`claude --debug`).
- `ARTIFACT_PREVIEW_CA`: a PEM CA certificate for previews behind a TLS-inspecting proxy.

Claude Code passes its own environment to the server, so set them in your shell or in Claude Code's `env` setting. Codex starts plugin MCP servers with only a fixed list of variables (`HOME`, `PATH`, `TMPDIR`, `LANG` and a few others) plus those the plugin names, and `artifact-design` names these four, `PLAYWRIGHT_BROWSERS_PATH` and the desktop variables a browser needs on Linux (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` and a few more), so set them in the shell you start Codex from. Page files the model writes go to a private folder of the session's own under `artifact-drafts-<uid>` in the system temp directory (`artifact-drafts` on Windows), so they stay out of your project. That folder is outside the project, so writing there gets Claude Code's usual check: auto mode's reviewer approves it without asking, while the other permission modes ask before each page. Codex's sandbox already lets it write to the temp directory in a project you've trusted.

In a Claude Code session that has its own Artifact tool (signed in to claude.ai, where artifacts are on), that tool publishes to claude.ai and the plugin's adds nothing: Claude Code then lists two `Artifact` tools and both sets of skills, while the plugin's text assumes its tool is the only one. Turn the plugin off there, or start Claude Code with `CLAUDE_CODE_ARTIFACT=0` to keep pages local with the plugin.

Codex keeps plugin MCP tools out of the model's sight until it searches for them, so it wouldn't think of the `Artifact` tool unless you named the plugin. `artifact-design` asks Codex to load the tool up front instead (`omit_tools_from` in its `.codex-plugin/plugin.json`). If a Codex release stops honoring that, this line in `~/.codex/config.toml` does the same:

```toml
[features.code_mode]
direct_only_tool_namespaces = ["mcp__artifact"]
```

Publishing asks too. Claude Code asks before the plugin's `Artifact` and `ArtifactCheck` tools run, and its "don't ask again" lasts for the project. Codex asks before every call until you answer "always", and `codex exec` refuses the call until then.

## Global instructions

`instructions/AGENTS.md` holds the shared global instructions and `instructions/CLAUDE.md` imports them for Claude. Link them manually:

```sh
ln -s ~/projects/agent-plugins/instructions/AGENTS.md ~/.codex/AGENTS.md
ln -s ~/projects/agent-plugins/instructions/CLAUDE.md ~/.claude/CLAUDE.md
```

`CLAUDE.md` imports `~/.codex/AGENTS.md`, so both links are needed for Claude to see the shared text.

## Mods

A mod is a Claude Code plugin of function hooks: one TypeScript module that hooks the session's events and draws into its interface (status line, toasts, a band above the prompt, panes, slash commands) or adds tools. Mods are Claude Code only. They are listed in `.claude-plugin/marketplace.json` so Claude Code can install them like any other plugin, and their descriptions say Claude Code only for Codex, which reads the same catalog. The Cursor catalog leaves out a plugin whose description says that.

A mod folder holds `.claude-plugin/plugin.json` (with `version` unset, as for every plugin here), `hooks/hooks.json` naming the module (`{ "modules": ["./register.tsx"] }`), the module itself, and `tests/*.test.ts`. A mod that keeps values in `$.state` also has `types/index.d.ts` declaring them. Claude Code lays the API types into `.claude-plugin/types/` when it loads the mod (ignored there by its own `.gitignore`), and the mod's `tsconfig.json` extends them.

Current mods:

- `session-band`: Clawd and your session at a glance in the band above the prompt, in two looks. `tide`, the default, puts him on a little beach where the tide comes in as your context fills, beside three short lines: what Claude is doing, how full the context is (with the cost and whichever usage limit is closest to running out), and where you are (project, branch, uncommitted changes, model). `hearth` sets him beside three calm lines instead, with context and limit meters. Pick the look in the "Band look" row of `/config`, or with `/band tide` and `/band hearth`. On the terminal he is Claude Code's own Clawd in the theme's colors, and on the desktop a vector Clawd. He strolls the sand or blinks at rest, reads along while Claude works, cheers when a turn lands, gets splashed by a wave (or flinches, by the hearth) when a tool fails, sweats by the hearth as the context runs high, naps when you're away and shows a heart when you pet him. On the beach the stars come out at night, by your own clock, and a compaction leaves a starfish on the sand where the tide stood. A toast says when the context passes 80% (the `warnAt` option in `/config`). `/band still` keeps either look still, as reduced motion does, and `/band lively` brings the motion back. In the terminal's fullscreen layout the band gives up its rows while a `/` command or `@` file menu is up, so the menu sits right above the prompt, and takes one row whenever a tall draft leaves it less room; "Band size" in `/config` can keep it to one row, with no pet. `DESIGN.md` explains both looks.

Install a mod for your user, so every session loads it:

```sh
claude plugin install session-band@agent-plugins --scope user
```

To try a mod from a checkout in one session, check it, and run its tests:

```sh
claude --plugin-dir ~/projects/agent-plugins/plugins/session-band
claude plugin validate plugins/session-band
claude plugin test plugins/session-band
```

The session reloads the mod when its files change, so edits show up without a restart.

## Credits

The `artifact-design` plugin carries Anthropic's built-in Claude Code `artifact-design`, `artifact-diagramming`, and `dataviz` skills, its Markdown page template and its highlight.js runtime, captured from Claude Code 2.1.304. Its `artifact` MCP server stands in for Claude Code's Artifact tool and `ArtifactCheck`. `artifact-diagramming` and `dataviz` are unchanged except for one sentence each about claude.ai-only features, and only Codex gets `dataviz` (from `codex-skills/`), since Claude Code always has its own; [`UPSTREAM.md`](plugins/artifact-design/UPSTREAM.md) lists every change to `artifact-design` and every way the server differs from the Artifact tool. The server's bundles include [marked](https://github.com/markedjs/marked), [Zod](https://github.com/colinhacks/zod) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), all under the MIT license, and the highlight.js runtime keeps its BSD license notice.

`deeper-task` is the depth prompt from Felix Rieseberg's post [How to be more ambitious](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/), word for word as the skill's body. The post gives no license.

`frontend-skill` is OpenAI's frontend design skill, originally installed through Codex's skill installer, under the Apache 2.0 license in its directory.

`show-me` is HumanLayer's visual explanation skill, under the MIT license in its directory.
