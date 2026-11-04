# Working on pak-tools

pak-tools is Aaron's private monorepo for plugins, MCP servers and tools. Its public part is published to pak-plugins, the plugin marketplace Claude Code, Codex and Cursor install from (it was called agent-plugins, and GitHub still redirects that name). Work happens here; pak-plugins is written only by the export (see Public and private). `public/README.md` is for people installing plugins; this file is for changing the repository, and pak-plugins carries a copy of it, where the files in `public/` sit at the root.

## Public and private

A path's folder decides whether it is published:

- Public: `plugins/`, `instructions/`, `scripts/`, the root config files and this file, plus everything in `public/`, which lands at the root of pak-plugins (the public catalogs and README). The list is `PUBLIC_PATHS` in `scripts/export.ts`; anything not on it stays private.
- Private: `private/plugins/<name>/` for plugins only Aaron installs, listed in the root `.claude-plugin/marketplace.json` (the `pak-tools` marketplace), and `private/tools/<name>/` for everything else, such as MCP servers, CLIs and backups that aren't plugins. `private/DENYLIST` (one string per line) names anything else that must never be published.

On every push to `main`, CI exports each new first-parent commit to pak-plugins as one commit with the same author, date and message, ending in an `Exported-from: aaron-pak/pak-tools@<sha>` trailer. A commit that changes nothing public adds nothing there. The export refuses a tree that contains a `private/` path or names a private plugin, tool or DENYLIST line, and a commit message that does is published as "Update from pak-tools". `bun scripts/export.ts build <dir>` writes the public tree of `HEAD` so you can look at it. Moving a plugin from `plugins/` to `private/plugins/` stops it being published from then on; what pak-plugins already holds stays in its history.

A private tool keeps its own `package.json` and tooling until it is moved onto the shared TypeScript toolchain below.

The export pushes with a deploy key: pak-plugins has the public half with write access, and pak-tools has the private half in the `PAK_PLUGINS_DEPLOY_KEY` secret. Without the secret the job skips with a warning. Nothing else may commit to pak-plugins: the export stops when pak-plugins has commits after its last export, and says how to recover. So pull requests, including the weekly drift routine's, go to pak-tools. Older commits whose tree would leak are skipped; when `HEAD` would leak, the export stops until a new commit fixes it. Author emails other than the public ones in `scripts/export.ts` are published as Aaron's GitHub noreply address, and `#12` in a message becomes `aaron-pak/pak-tools#12`. pak-plugins runs its own copy of the checks, from `public/.github/workflows/validate.yml`.

## Layout

- `public/.claude-plugin/marketplace.json`: the public marketplace catalog, named `agent-plugins` (the name installs use, kept when the repository was renamed). Claude Code and Codex both read it.
- `.claude-plugin/marketplace.json`: the private catalog, named `pak-tools`, listing `private/plugins/`. Aaron's Macs add it beside the public one.
- `plugins/<name>/`: one plugin per tool or workflow. `plugin.json` at the plugin root follows the open [Agent Plugins 1.0.0](https://agent-plugins.org) format, which Codex reads natively, and `skills/<skill>/` holds each skill with its references and license. Claude Code takes the plugin's name and description from the marketplace entry and finds `skills/` on its own, so plugins carry no `.claude-plugin/plugin.json`. Plugins that work only in Claude Code, such as the mod `session-band`, are the exception: their manifest is `.claude-plugin/plugin.json` beside `hooks/` (see Mods in `public/README.md`), which is also where `claude plugin validate` looks for a plugin without `skills/`. `artifact-design` is the other exception: its manifest is Codex's own `.codex-plugin/plugin.json`, with its MCP server inline, because only that format lets a plugin ask Codex to load a tool up front (`omit_tools_from`) instead of behind tool search. Its `skills` also names `codex-skills/`, for `dataviz`, which Claude Code has built in and so doesn't need from the plugin. Codex reads a root `plugin.json` with the Agent Plugins `$schema` before `.codex-plugin/`, so that plugin has none, and its server runs `mcp/server.mjs` from `cwd: "."` because Codex expands `${PLUGIN_ROOT}` only in the Agent Plugins format. A plugin may also carry command hooks in `hooks/hooks.json`. Only Claude Code loads them: Codex (checked on 0.162.1) skips the hooks of a plugin with a root `plugin.json`, and a Codex `PreToolUse` hook can't approve a call anyway.
- `public/.cursor-plugin/marketplace.json`: the catalog Cursor and Grok Bot read. Cursor reads `.cursor-plugin/marketplace.json` for multi-plugin repos (https://cursor.com/docs/reference/plugins), so this file lists every public plugin meant for Cursor and Grok Bot: every plugin from the public Claude catalog except plugins whose description says Claude Code only, with the same name and description and with `source` `plugins/<name>` (no leading `./`). `minClientVersions` is set only on `mac-computer-use`, as `{"cursor": "never"}`, which hides that plugin from Cursor. Team marketplaces, including Auto Refresh, are on Teams and Enterprise plans (https://cursor.com/docs/plugins). Aaron is on Pro, so this repository is a personal marketplace, and Cursor's docs describe no refresh for those.
- `instructions/`: Aaron's global agent instructions, linked by hand into `~/.codex` and `~/.claude` (see `public/README.md`). They are not instructions for this repository.
- `scripts/validate.py`: the consistency check CI runs.
- `scripts/export.ts`: publishes the public part to pak-plugins (see Public and private).
- `package.json`, `bunfig.toml`, `tsconfig.base.json`, `tsconfig.json`, `.oxlintrc.json`, `vitest.config.ts` and `scripts/build.ts`: the TypeScript toolchain for plugin code (see TypeScript below).

## Adding or changing a plugin

1. Create `plugins/<name>/plugin.json` and `skills/<skill>/SKILL.md`. Each skill's frontmatter `name` matches its directory, and every skill has a `description`.
2. Add an entry to `public/.claude-plugin/marketplace.json` with the same name and description as `plugin.json`, source `./plugins/<name>`, and `"strict": false`. A plugin without `.claude-plugin/plugin.json` gets its Claude Code manifest from that entry: the CLI loads it either way, but the Claude desktop app's marketplace sync skips it unless `strict` is false. A mod with its own `.claude-plugin/plugin.json` leaves `strict` out.
3. Add the same name and description to `public/.cursor-plugin/marketplace.json` with source `plugins/<name>` (no leading `./`), unless the description says Claude Code only. See Layout.
4. Add the plugin to the "Current plugins" list in `public/README.md`, one line each in alphabetical order.
5. Leave `version` unset in every manifest. Claude Code uses the Git commit as the version, and Codex pulls new commits when the marketplace is upgraded.

A private plugin goes in `private/plugins/<name>/` and in the root `.claude-plugin/marketplace.json` with source `./private/plugins/<name>`, and skips steps 3 and 4. A plugin is in one catalog, never both.

## Plugins from elsewhere

When a skill comes from someone else, credit them the same way everywhere:

- `plugin.json` `author.name` is the upstream author, and `license` is set when the upstream has one.
- The license file sits in the skill's directory.
- The plugin description ends with "From <author>." in both `plugin.json` and the marketplace entry.
- `public/README.md`'s Credits section names the source (with a pinned revision when there is one) and every deviation from upstream, or points to a note in the plugin that lists them, as `artifact-design`'s `UPSTREAM.md` does.

The `artifact-design` plugin copies Claude Code's built-in `artifact-design`, `artifact-diagramming`, and `dataviz` skills. To re-sync, first commit the current Claude Code text verbatim, then reapply the edits listed in `plugins/artifact-design/UPSTREAM.md` in a second commit, so the diff between the two shows every deviation. `bun run drift` does the comparing: it fetches the Claude Code release `UPSTREAM.md` names and the latest one, reports which verbatim copies differ and which strings changed between the two releases in the code the plugin ports with edits, and `--write` refreshes the verbatim copies. A weekly routine runs it and opens a pull request when Claude Code moves. Keep notes like that out of the `SKILL.md` files: Claude Code passes HTML comments in a skill to the model. `artifact-diagramming` and `dataviz` stay verbatim, less the claude.ai-only sentences `UPSTREAM.md` lists, which `bun run drift` leaves out. Model-facing text names no tool, type or service the plugin doesn't have: where Claude Code's text does, leave it out or name the plugin's own equivalent, and list the edit in `UPSTREAM.md`. The page contract and guidance should also match what the Artifact tool's `quickstart` (intent `other`) returns for a plain page, since that is the text the model reads when it makes an artifact; the plugin's `quickstart` result, which takes no intent, should differ from Claude Code's for intent `other` only by those edits. Paths from here on are in `plugins/artifact-design/`. `src/publish.ts` holds the Artifact tool's publish skeleton and CDN allowlist; on a re-sync, compare them with the skeleton of a freshly published claude.ai artifact and with the skill's page contract, and compare `src/text/description.md` with the Artifact tool's own description. Claude Code cuts MCP tool descriptions at 4,096 characters (2,048 before 2.1.296), so the server sends the paragraphs that fit as the tool description and the rest as the input schema's description; keep the first paragraph and the first-call rule after it within 2,048 characters. The compact tool the server sends Codex (`src/text/codex-lead.md` and `codex-rest.md`; the Codex manifest starts the server with `--client=codex`, since a tool's description is fixed for the session) must keep its input schema within 5,000 bytes as compact JSON, or Codex drops every description in it, and its description within the 1,000 bytes Codex allows a tool from an Agent Plugins manifest; `bun run test` checks both. `skills/artifact-design/scripts/markdown-template.html` is Claude Code's plan template, which it pours published Markdown into, and `skills/artifact-design/scripts/hljs-runtime.html` the highlight.js runtime it inlines in a page with a language-tagged code block; keep both verbatim, and compare `src/render-markdown.ts`'s fill rules and marked version with the CLI's on a re-sync. `skills/artifact-design/scripts/preview.mjs` ports `ArtifactCheck`: compare its constants, content policy, checks and report text with the CLI's too.

## Checks

CI (`.github/workflows/validate.yml`) runs on every push to `main` and every pull request, and after a push to `main` passes, its `export` job publishes to pak-plugins:

- `python3 scripts/validate.py` checks, for the public catalogs and the private one, that marketplace entries, `plugin.json` files (including Codex's `.codex-plugin/plugin.json`), skill frontmatter, MCP config pairs, and the README plugin list agree, and that `public/.cursor-plugin/marketplace.json` lists every plugin from the Claude catalog except those whose description says Claude Code only, with the same name and description.
- `claude plugin validate --strict` checks the marketplace and each plugin the way Claude Code loads them. CI allows one warning, a missing version, which every mod's `.claude-plugin/plugin.json` gets because versions stay unset.
- The public tree that `bun scripts/export.ts build` writes must pass the leak check, `validate.py` and `claude plugin validate --strict` on its own, as pak-plugins will hold it.
- `bun run lint`, `bun run typecheck` and `bun run test` check the TypeScript, and `bun run build` must leave the committed bundles unchanged.
- `bun run mod test` runs the tests of each mod the change touches (all of them when `scripts/mod/` changes).

Run them locally before pushing.

## TypeScript

Plugin code other than a mod's is TypeScript in `plugins/<name>/src/`, with tests in `plugins/<name>/tests/`. Bun installs, builds and formats it, and runs the scripts; plugins run it on Node, and so do the tests.

```sh
bun install        # also patches tsrs with Effect's diagnostics (postinstall)
bun run build      # bundle src/ into the committed .mjs files
bun run lint       # bun fmt --check, then oxlint with type-aware rules; bun run fmt formats
bun run typecheck  # tsrs, with Effect's language service
bun run test       # vitest, on Node
```

- Code that is a real program, such as an MCP server, is written in [Effect](https://effect.website) v4: services as `Context.Service` classes with a `layer`, `Effect.gen` and `Effect.fn` for effects, `Schema` to decode anything from outside (JSON, files, tool arguments that have a schema), tagged errors, and the `FileSystem`, `Path` and `ChildProcessSpawner` services rather than `node:fs` and `node:child_process`. An MCP server uses `effect/ai`'s `McpServer`. Pure helpers (parsing, formatting, text) stay plain functions. A short script, such as those in `scripts/`, needn't use Effect.
- `tsconfig.base.json` holds the compiler options and the `@effect/language-service` plugin, whose diagnostics `tsrs` reports as errors (`bun run typecheck`, and the editor through the same plugin). Each plugin with TypeScript has a `tsconfig.json` that extends it with Node's types only, so a Bun-only API fails in its sources and tests; the root `tsconfig.json` covers `scripts/` and the Vitest config, which may use Bun's. Editors and Oxlint read the `tsconfig.json` nearest each file; `bun run typecheck` checks each.
- `.oxlintrc.json` turns on typescript-eslint's recommended-type-checked rules as Oxlint names them, with Oxlint's correctness category; `--deny-warnings` makes any of them fail CI. `bun fmt` formats (its settings are `[fmt]` in `bunfig.toml`); `src/text/` and test fixtures are left as written.
- Vitest reads `vitest.config.ts`, which loads the `with { type: "text" }` imports as the build does; `@effect/vitest`'s `it.effect` runs an Effect test.

Edit `src/`, never a bundle. `scripts/build.ts` bundles each entry point, with its packages and the text files it imports `with { type: "text" }`, into one `.mjs` file that `node` runs, so installing a plugin needs nothing else; the bundles are committed, and CI fails when one differs from a fresh build. `artifact-design` has one, `mcp/server.mjs`.

`bun run dev:artifact` runs the `artifact` server from source and restarts it when a file in `src/` is saved. To try it in Claude Code, start a session with that server under another name, such as `claude --mcp-config '{"mcpServers":{"artifact-dev":{"command":"bun","args":["--cwd","/path/to/agent-plugins/plugins/artifact-design/src","--watch","server.ts"]}}}'`; Claude Code keeps the connection across restarts, so the next call runs the new code. Keep the `--cwd`: Claude Code's Edit and Write save by replacing the file, and Bun's watcher misses a replaced file outside its working folder. It misses one in `src/text/` too, so after editing those, save a `.ts` file to restart.

## Developing a mod

`bun run mod` is the loop for a mod (a plugin of function hooks). Each command works on a copy of the folder it names, so it runs on any mod, including one on another branch or outside the repository, and leaves the folder as it was. `bun run mod help <command>` lists the options.

```sh
bun run mod check plugins/<mod>                # validate --strict, tsrs against this build's API, every test
bun run mod test plugins/<mod> --grep splash   # the tests whose names match; without --grep, all of them
bun run mod preview plugins/<mod> --styles tide,hearth   # play a band through a session and check its layout
bun run mod preview plugins/<mod> --png        # and paint both surfaces, dark and light; --gifs animates them
bun run mod preview plugins/<mod> --strips --frames 48   # each moment frame by frame at 2x, the desktop paused in time
```

- `mod test` cuts each test file into runs of neighbouring tests that run side by side, balanced by each test's last time. Iterate with `--grep` on what changed and run everything before pushing: on session-band's 503 tests in a 4-core container, a few named tests take seconds and the whole suite about 6 minutes, against 9 for `claude plugin test`. A test that leans on the one before it stays beside it unless a cut falls between them; name such pairs "(1 of 2)" and "(2 of 2)" and no cut does, and `--grep` brings a later part's earlier ones along.
- `mod preview` plays fresh, idle, cheer, working, reading, thinking, oops, high, nap, pet and compact through the mod's `AbovePrompt` hook on both surfaces at 64, 100 and 140 columns, then writes `report.txt` and `frames.txt` (the terminal band as text, each animation's distinct frames). Read those before painting, and paint for what text can't show: color and the desktop. Each style plays its moments in a session of its own, switched to as it starts. `claude plugin test` runs in UTC whatever `TZ` says, where a session keeps the machine's zone, so `--at` picks the hour a preview plays at (for the beach's night, say). `--strips` paints each moment at the animated width, twice the pixels: the band alone in each distinct terminal frame, and the desktop's pictures paused every quarter second, which is how to judge pixel art and motion. The report fails on a height that changes, a row past the band's edge, an emoji-capable glyph, block characters in desktop Text, or an element a surface refuses, and warns on rows within 2 columns of the edge, glyphs outside the safe set, space-aligned desktop Text and more than 4 frame changes a second. When a round of looking finds a fault of a new kind, add it to `scripts/mod/preview/lint.ts` or to the mod's tests, so no later round has to look for it. The desktop paint approximates the real page.
- `mod types` uses the `.claude-plugin/types/` an interactive session lays beside a mod it loads from its folder; elsewhere it uses the declarations the plugin-authoring skill writes each time it loads, so load that skill first in a cloud session.

## Trying changes locally

Load one plugin straight from the checkout with `claude --plugin-dir plugins/<name>`. To try the public marketplace as pak-plugins will hold it, build `HEAD`'s public tree into an empty folder and add that; the public catalog's `./plugins/` sources only resolve from that root. The checkout's own root is the private marketplace:

```sh
rm -rf /tmp/pak-plugins && bun scripts/export.ts build /tmp/pak-plugins
claude plugin marketplace add /tmp/pak-plugins
codex plugin marketplace add /tmp/pak-plugins
claude plugin marketplace add ~/projects/pak-tools   # the private plugins
```

## Adding an MCP server plugin

An MCP server gets its own plugin directory so it installs separately from any skill, unless the skills are written around its tools, as `artifact-design`'s are around its `artifact` server; then the server ships in that plugin, with the same two files unless it has Codex's manifest:

```
plugins/example-mcp/
  plugin.json   # same manifest as any plugin: $schema, name, description, author
  mcp.json      # Agent Plugins format for Codex: {"$schema": ".../mcp.schema.json", "mcpServers": {"example": {"type": "stdio", "command": "npx", "args": ["-y", "example-mcp"]}}}
  .mcp.json     # Claude Code format: {"mcpServers": {"example": {"command": "npx", "args": ["-y", "example-mcp"]}}}
```

Add a matching entry to the public or private catalog. Pass secrets through environment variables such as `${EXAMPLE_API_KEY}` and keep the values out of this repository. The two files describe the same servers in each harness's format. Agent Plugins `mcp.json` requires `type` and exposes `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` to the server. Confirm with `claude mcp list` and `codex mcp list` that each harness starts the server. Codex hides plugin MCP tools until the model searches for them; when the model should reach for a tool unprompted, give the plugin Codex's manifest instead, as `artifact-design` does (see Layout).
