# Working on agent-plugins

This repository is a plugin marketplace that Claude Code and Codex both install from. README.md is for people installing plugins; this file is for changing the repository.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace catalog, named `agent-plugins`. Claude Code and Codex both read it.
- `plugins/<name>/`: one plugin per tool or workflow. `plugin.json` at the plugin root follows the open [Agent Plugins 1.0.0](https://agent-plugins.org) format, which Codex reads natively, and `skills/<skill>/` holds each skill with its references and license. Claude Code takes the plugin's name and description from the marketplace entry and finds `skills/` on its own, so plugins carry no `.claude-plugin/plugin.json`. Plugins that work only in Claude Code, such as the mod `session-manager`, are the exception: their manifest is `.claude-plugin/plugin.json` beside `hooks/` (see Mods in README.md), which is also where `claude plugin validate` looks for a plugin without `skills/`. `artifact-design` is the other exception: its manifest is Codex's own `.codex-plugin/plugin.json`, with its MCP server inline, because only that format lets a plugin ask Codex to load a tool up front (`omit_tools_from`) instead of behind tool search. Its `skills` also names `codex-skills/`, for `dataviz`, which Claude Code has built in and so doesn't need from the plugin. Codex reads a root `plugin.json` with the Agent Plugins `$schema` before `.codex-plugin/`, so that plugin has none, and its server runs `mcp/server.mjs` from `cwd: "."` because Codex expands `${PLUGIN_ROOT}` only in the Agent Plugins format. A plugin may also carry command hooks in `hooks/hooks.json`. Only Claude Code loads them: Codex (checked on 0.162.1) skips the hooks of a plugin with a root `plugin.json`, and a Codex `PreToolUse` hook can't approve a call anyway.
- `.cursor-plugin/marketplace.json`: the catalog Cursor and Grok Bot read. Cursor reads `.cursor-plugin/marketplace.json` for multi-plugin repos (https://cursor.com/docs/reference/plugins), so this file lists every plugin meant for Cursor and Grok Bot: every plugin from `.claude-plugin/marketplace.json` except plugins whose description says Claude Code only, with the same name and description and with `source` `plugins/<name>` (no leading `./`). `minClientVersions` is set only on `mac-computer-use`, as `{"cursor": "never"}`, which hides that plugin from Cursor. Team marketplaces, including Auto Refresh, are on Teams and Enterprise plans (https://cursor.com/docs/plugins). Aaron is on Pro, so this repository is a personal marketplace, and Cursor's docs describe no refresh for those.
- `instructions/`: Aaron's global agent instructions, linked by hand into `~/.codex` and `~/.claude` (see README.md). They are not instructions for this repository.
- `scripts/validate.py`: the consistency check CI runs.
- `package.json`, `tsconfig.json` and `scripts/build.ts`: the TypeScript toolchain for plugin code (see TypeScript below).

## Adding or changing a plugin

1. Create `plugins/<name>/plugin.json` and `skills/<skill>/SKILL.md`. Each skill's frontmatter `name` matches its directory, and every skill has a `description`.
2. Add an entry to `.claude-plugin/marketplace.json` with the same name and description as `plugin.json`, and source `./plugins/<name>`.
3. Add the same name and description to `.cursor-plugin/marketplace.json` with source `plugins/<name>` (no leading `./`), unless the description says Claude Code only. See Layout.
4. Add the plugin to the "Current plugins" list in README.md, one line each in alphabetical order.
5. Leave `version` unset in every manifest. Claude Code uses the Git commit as the version, and Codex pulls new commits when the marketplace is upgraded.

## Plugins from elsewhere

When a skill comes from someone else, credit them the same way everywhere:

- `plugin.json` `author.name` is the upstream author, and `license` is set when the upstream has one.
- The license file sits in the skill's directory.
- The plugin description ends with "From <author>." in both `plugin.json` and the marketplace entry.
- README.md's Credits section names the source (with a pinned revision when there is one) and every deviation from upstream, or points to a note in the plugin that lists them, as `artifact-design`'s `UPSTREAM.md` does.

The `artifact-design` plugin copies Claude Code's built-in `artifact-design`, `artifact-diagramming`, and `dataviz` skills. To re-sync, first commit the current Claude Code text verbatim, then reapply the edits listed in `plugins/artifact-design/UPSTREAM.md` in a second commit, so the diff between the two shows every deviation. `bun run drift` does the comparing: it fetches the Claude Code release `UPSTREAM.md` names and the latest one, reports which verbatim copies differ and which strings changed between the two releases in the code the plugin ports with edits, and `--write` refreshes the verbatim copies. A weekly routine runs it and opens a pull request when Claude Code moves. Keep notes like that out of the `SKILL.md` files: Claude Code passes HTML comments in a skill to the model. `artifact-diagramming` and `dataviz` stay verbatim, less the claude.ai-only sentences `UPSTREAM.md` lists, which `bun run drift` leaves out. Model-facing text names no tool, type or service the plugin doesn't have: where Claude Code's text does, leave it out or name the plugin's own equivalent, and list the edit in `UPSTREAM.md`. The page contract and guidance should also match what the Artifact tool's `quickstart` (intent `other`) returns for a plain page, since that is the text the model reads when it makes an artifact; the plugin's `quickstart` result, which takes no intent, should differ from Claude Code's for intent `other` only by those edits. Paths from here on are in `plugins/artifact-design/`. `src/publish.ts` holds the Artifact tool's publish skeleton and CDN allowlist; on a re-sync, compare them with the skeleton of a freshly published claude.ai artifact and with the skill's page contract, and compare `src/text/description.md` with the Artifact tool's own description. Claude Code cuts MCP tool descriptions at 4,096 characters (2,048 before 2.1.296), so the server sends the paragraphs that fit as the tool description and the rest as the input schema's description; keep the first paragraph and the first-call rule after it within 2,048 characters. The compact tool the server sends Codex (`src/text/codex-lead.md` and `codex-rest.md`) must keep its input schema within 5,000 bytes as compact JSON, or Codex drops every description in it, and its description within the 1,000 bytes Codex allows a tool from an Agent Plugins manifest; `bun run test` checks both. `skills/artifact-design/scripts/markdown-template.html` is Claude Code's plan template, which it pours published Markdown into, and `skills/artifact-design/scripts/hljs-runtime.html` the highlight.js runtime it inlines in a page with a language-tagged code block; keep both verbatim, and compare `src/render-markdown.ts`'s fill rules and marked version with the CLI's on a re-sync. `skills/artifact-design/scripts/preview.mjs` ports `ArtifactCheck`: compare its constants, content policy, checks and report text with the CLI's too.

## Checks

CI (`.github/workflows/validate.yml`) runs on every push to `main` and every pull request:

- `python3 scripts/validate.py` checks that marketplace entries, `plugin.json` files (including Codex's `.codex-plugin/plugin.json`), skill frontmatter, MCP config pairs, and the README plugin list agree, and that `.cursor-plugin/marketplace.json` lists every plugin from the Claude catalog except those whose description says Claude Code only, with the same name and description.
- `claude plugin validate --strict` checks the marketplace and each plugin the way Claude Code loads them. CI allows one warning, a missing version, which every mod's `.claude-plugin/plugin.json` gets because versions stay unset.
- `bun run lint`, `bun run typecheck` and `bun run test` check the TypeScript, and `bun run build` must leave the committed bundles unchanged.
- `bun run mod test` runs the tests of each mod the change touches (all of them when `scripts/mod/` changes).

Run them locally before pushing.

## TypeScript

Plugin code other than a mod's is TypeScript in `plugins/<name>/src/`, with tests in `plugins/<name>/tests/`. Bun installs, builds and tests it; plugins run it on Node.

```sh
bun install
bun run build      # bundle src/ into the committed .mjs files
bun run lint       # oxfmt --check and oxlint; bun run fmt formats
bun run typecheck  # tsc, until bun check ships in a stable Bun
bun run test       # bun test
```

Edit `src/`, never a bundle. `scripts/build.ts` bundles each entry point, with its packages and the text files it imports `with { type: "text" }`, into one `.mjs` file that `node` runs, so installing a plugin needs nothing else; the bundles are committed, and CI fails when one differs from a fresh build. `artifact-design` has one, `mcp/server.mjs`. `tsconfig.json` checks the sources against Node's types only, so a Bun-only API fails there; tests and `scripts/` may use Bun's.

`bun run dev:artifact` runs the `artifact` server from source and restarts it when a file in `src/` is saved. To try it in Claude Code, start a session with that server under another name, such as `claude --mcp-config '{"mcpServers":{"artifact-dev":{"command":"bun","args":["--cwd","/path/to/agent-plugins/plugins/artifact-design/src","--watch","server.ts"]}}}'`; Claude Code keeps the connection across restarts, so the next call runs the new code. Keep the `--cwd`: Claude Code's Edit and Write save by replacing the file, and Bun's watcher misses a replaced file outside its working folder. It misses one in `src/text/` too, so after editing those, save a `.ts` file to restart.

## Developing a mod

`bun run mod` is the loop for a mod (a plugin of function hooks). Each command works on a copy of the folder it names, so it runs on any mod, including one on another branch or outside the repository, and leaves the folder as it was. `bun run mod help <command>` lists the options.

```sh
bun run mod check plugins/<mod>                # validate --strict, tsc against this build's API, every test
bun run mod test plugins/<mod> --grep splash   # the tests whose names match; without --grep, all of them
bun run mod preview plugins/<mod> --styles tide,hearth   # play a band through a session and check its layout
bun run mod preview plugins/<mod> --png        # and paint both surfaces, dark and light; --gifs animates them
bun run mod preview plugins/<mod> --strips --frames 48   # each moment frame by frame at 2x, the desktop paused in time
```

- `mod test` cuts each test file into runs of neighbouring tests that run side by side, balanced by each test's last time. Iterate with `--grep` on what changed and run everything before pushing: on session-band's 503 tests in a 4-core container, a few named tests take seconds and the whole suite about 6 minutes, against 9 for `claude plugin test`. A test that leans on the one before it stays beside it unless a cut falls between them; name such pairs "(1 of 2)" and "(2 of 2)" and no cut does, and `--grep` brings a later part's earlier ones along.
- `mod preview` plays fresh, idle, cheer, working, reading, thinking, oops, high, nap, pet and compact through the mod's `AbovePrompt` hook on both surfaces at 64, 100 and 140 columns, then writes `report.txt` and `frames.txt` (the terminal band as text, each animation's distinct frames). Read those before painting, and paint for what text can't show: color and the desktop. Each style plays its moments in a session of its own, switched to as it starts. `claude plugin test` runs in UTC whatever `TZ` says, where a session keeps the machine's zone, so `--at` picks the hour a preview plays at (for the beach's night, say). `--strips` paints each moment at the animated width, twice the pixels: the band alone in each distinct terminal frame, and the desktop's pictures paused every quarter second, which is how to judge pixel art and motion. The report fails on a height that changes, a row past the band's edge, an emoji-capable glyph, block characters in desktop Text, or an element a surface refuses, and warns on rows within 2 columns of the edge, glyphs outside the safe set, space-aligned desktop Text and more than 4 frame changes a second. When a round of looking finds a fault of a new kind, add it to `scripts/mod/preview/lint.ts` or to the mod's tests, so no later round has to look for it. The desktop paint approximates the real page.
- `mod types` uses the `.claude-plugin/types/` an interactive session lays beside a mod it loads from its folder; elsewhere it uses the declarations the plugin-authoring skill writes each time it loads, so load that skill first in a cloud session.

## Trying changes locally

Add the local checkout as the marketplace so changes show up without pushing:

```sh
claude plugin marketplace add ~/projects/agent-plugins
codex plugin marketplace add ~/projects/agent-plugins
```

## Adding an MCP server plugin

An MCP server gets its own plugin directory so it installs separately from any skill, unless the skills are written around its tools, as `artifact-design`'s are around its `artifact` server; then the server ships in that plugin, with the same two files unless it has Codex's manifest:

```
plugins/example-mcp/
  plugin.json   # same manifest as any plugin: $schema, name, description, author
  mcp.json      # Agent Plugins format for Codex: {"$schema": ".../mcp.schema.json", "mcpServers": {"example": {"type": "stdio", "command": "npx", "args": ["-y", "example-mcp"]}}}
  .mcp.json     # Claude Code format: {"mcpServers": {"example": {"command": "npx", "args": ["-y", "example-mcp"]}}}
```

Add a matching entry to `.claude-plugin/marketplace.json`. Pass secrets through environment variables such as `${EXAMPLE_API_KEY}` and keep the values out of this repository. The two files describe the same servers in each harness's format. Agent Plugins `mcp.json` requires `type` and exposes `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` to the server. Confirm with `claude mcp list` and `codex mcp list` that each harness starts the server. Codex hides plugin MCP tools until the model searches for them; when the model should reach for a tool unprompted, give the plugin Codex's manifest instead, as `artifact-design` does (see Layout).
