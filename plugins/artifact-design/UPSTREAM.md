# Upstream

The three skills are Anthropic's built-in Claude Code skills, captured from Claude Code 2.1.293 (2026-10-07); Claude Code 2.1.294 ships the same text. This note lives outside the skills so that the model reads only Claude Code's text.

- `artifact-diagramming` is verbatim.
- `dataviz` is verbatim, with its `references/` and `scripts/` unchanged.
- `artifact-design` keeps Claude Code's wording. The page contract and guidance are also what the Artifact tool's `quickstart` returns for a plain page, and the `artifact` server reads them from this `SKILL.md`. The only edits:
  1. Frontmatter: `description` and `when_to_use` are merged into one description, with example page types, so the skill loads without a tool forcing it.
  2. An "Outside claude.ai" section is added. It names the tool that stands in for the Artifact tool and maps Claude and CLAUDE.md to this harness. `quickstart` leaves it out, since its text starts at the page contract.
  3. Removed, because only claude.ai can do them: the pointers to runtime capabilities and the `db` store, the Artifact-type note, and Open viewers. The device-API sentence in the page contract takes the wording Claude Code itself uses when the `artifact-design` skill is not available in a session.
  4. The page contract's sentences on Web Workers, fetching the page's own files, canvas export and storage origin describe a page opened from a `file://` link, which is how an artifact published here opens: such a page cannot fetch its own files or start Workers from them, and may share one storage origin with every other local page.
