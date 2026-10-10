# Working on agent-plugins

This repository is a plugin marketplace that Claude Code and Codex both install from. README.md is for people installing plugins; this file is for changing the repository.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace catalog, named `agent-plugins`. Claude Code and Codex both read it.
- `plugins/<name>/`: one plugin per tool or workflow. `plugin.json` at the plugin root follows the open [Agent Plugins 1.0.0](https://agent-plugins.org) format, which Codex reads natively, and `skills/<skill>/` holds each skill with its references and license. Claude Code takes the plugin's name and description from the marketplace entry and finds `skills/` on its own, so plugins carry no `.claude-plugin/plugin.json`. Plugins that work only in Claude Code, such as the mod `session-manager`, are the exception: their manifest is `.claude-plugin/plugin.json` beside `hooks/` (see Mods in README.md), which is also where `claude plugin validate` looks for a plugin without `skills/`. A plugin may also carry command hooks in `hooks/hooks.json`, as `artifact-design` does; Claude Code and Codex both load that file, and Codex also runs a hook matching `Write` or `Edit` for its `apply_patch` tool.
- `instructions/`: Aaron's global agent instructions, linked by hand into `~/.codex` and `~/.claude` (see README.md). They are not instructions for this repository.
- `scripts/validate.py`: the consistency check CI runs.
- `package.json`, `tsconfig.json` and `scripts/build.ts`: the TypeScript toolchain for plugin code (see TypeScript below).

## Adding or changing a plugin

1. Create `plugins/<name>/plugin.json` and `skills/<skill>/SKILL.md`. Each skill's frontmatter `name` matches its directory, and every skill has a `description`.
2. Add an entry to `.claude-plugin/marketplace.json` with the same name and description as `plugin.json`, and source `./plugins/<name>`.
3. Add the plugin to the "Current plugins" list in README.md, one line each in alphabetical order.
4. Leave `version` unset in every manifest. Claude Code uses the Git commit as the version, and Codex pulls new commits when the marketplace is upgraded.

## Plugins from elsewhere

When a skill comes from someone else, credit them the same way everywhere:

- `plugin.json` `author.name` is the upstream author, and `license` is set when the upstream has one.
- The license file sits in the skill's directory.
- The plugin description ends with "From <author>." in both `plugin.json` and the marketplace entry.
- README.md's Credits section names the source (with a pinned revision when there is one) and every deviation from upstream.

The `artifact-design` plugin copies Claude Code's built-in `artifact-design`, `artifact-diagramming`, and `dataviz` skills. To re-sync, first commit the current Claude Code text verbatim, then reapply the edits listed in `plugins/artifact-design/UPSTREAM.md` in a second commit, so the diff between the two shows every deviation. Keep notes like that out of the `SKILL.md` files: Claude Code passes HTML comments in a skill to the model. `artifact-diagramming` and `dataviz` stay verbatim. The page contract and guidance should also match what the Artifact tool's `quickstart` (intent `other`) returns for a plain page, since that is the text the model reads when it makes an artifact; the plugin's `quickstart` result for intent `other` should differ from Claude Code's only by those edits. `src/publish.ts` holds the Artifact tool's publish skeleton and CDN allowlist; on a re-sync, compare them with the skeleton of a freshly published claude.ai artifact and with the skill's page contract, and compare `src/text/description.md` with the Artifact tool's own description. Keep its first paragraph short: it is the only part sent as the tool description, because Claude Code cuts MCP tool descriptions at 2,048 characters, and the rest goes in the input schema's description. The compact tool the server sends Codex (`src/text/codex-lead.md` and `codex-rest.md`) must stay within Codex's limits for plugin MCP tools: a description of at most 1,000 bytes and an input schema of at most 5,000 bytes as compact JSON, or Codex drops every description in it; `bun run test` checks both. `scripts/markdown-template.html` is Claude Code's plan template, which it pours published Markdown into; keep it verbatim and compare it, and `src/render-markdown.ts`'s fill rules, with the CLI's on a re-sync. `scripts/preview.mjs` ports `ArtifactCheck`: compare its constants, content policy, checks and report text with the CLI's too.

## Checks

CI (`.github/workflows/validate.yml`) runs on every push to `main` and every pull request:

- `python3 scripts/validate.py` checks that marketplace entries, `plugin.json` files, skill frontmatter, MCP config pairs, and the README plugin list agree.
- `claude plugin validate --strict` checks the marketplace and each plugin the way Claude Code loads them. CI allows one warning, a missing version, which every mod's `.claude-plugin/plugin.json` gets because versions stay unset.
- `bun run lint`, `bun run typecheck` and `bun run test` check the TypeScript, and `bun run build` must leave the committed bundles unchanged.

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

Edit `src/`, never a bundle. `scripts/build.ts` bundles each entry point, with its packages and the text files it imports `with { type: "text" }`, into one `.mjs` file that `node` runs, so installing a plugin needs nothing else; the bundles are committed, and CI fails when one differs from a fresh build. `artifact-design` has three: `mcp/server.mjs`, `skills/artifact-design/scripts/publish.mjs` and `hooks/allow-drafts.mjs`. `tsconfig.json` checks the sources against Node's types only, so a Bun-only API fails there; tests and `scripts/` may use Bun's.

`bun run dev:artifact` runs the `artifact` server from source and restarts it when a file in `src/` is saved. To try it in Claude Code, start a session with that server under another name, such as `claude --mcp-config '{"mcpServers":{"artifact-dev":{"command":"bun","args":["--cwd","/path/to/agent-plugins/plugins/artifact-design/src","--watch","server.ts"]}}}'`; Claude Code keeps the connection across restarts, so the next call runs the new code. Keep the `--cwd`: Claude Code's Edit and Write save by replacing the file, and Bun's watcher misses a replaced file outside its working folder. It misses one in `src/text/` too, so after editing those, save a `.ts` file to restart.

## Trying changes locally

Add the local checkout as the marketplace so changes show up without pushing:

```sh
claude plugin marketplace add ~/projects/agent-plugins
codex plugin marketplace add ~/projects/agent-plugins
```

## Adding an MCP server plugin

An MCP server gets its own plugin directory so it installs separately from any skill, unless the skills are written around its tools, as `artifact-design`'s are around its `artifact` server; then the server ships in that plugin with the same two files:

```
plugins/example-mcp/
  plugin.json   # same manifest as any plugin: $schema, name, description, author
  mcp.json      # Agent Plugins format for Codex: {"$schema": ".../mcp.schema.json", "mcpServers": {"example": {"type": "stdio", "command": "npx", "args": ["-y", "example-mcp"]}}}
  .mcp.json     # Claude Code format: {"mcpServers": {"example": {"command": "npx", "args": ["-y", "example-mcp"]}}}
```

Add a matching entry to `.claude-plugin/marketplace.json`. Pass secrets through environment variables such as `${EXAMPLE_API_KEY}` and keep the values out of this repository. The two files describe the same servers in each harness's format. Agent Plugins `mcp.json` requires `type` and exposes `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` to the server. Confirm with `claude mcp list` and `codex mcp list` that each harness starts the server.
