# Upstream

The sources, tests and commits this note names (`src/`, `tests/`) are in Aaron's private source repository, which builds the plugin; this one carries the built plugin.

`auto-memory` ports Claude Code 2.1.318's auto memory to harnesses that don't have it, Codex first. The text in `src/text/` was captured from that release and committed verbatim first ("Add Claude Code 2.1.318's auto memory text, verbatim"), so `git diff` from that commit shows every edit below.

## Where each piece comes from

- `src/text/section.md` is the `# Memory` section Claude Code puts in its system prompt for a session with auto memory and no team memory (the lean variant), with the memory folder as `{dir}`.
- `src/text/memory_list.md`, `memory_read.md` and `memory_write.md` are the descriptions of Claude Code's `memory_list`, `memory_read` and `memory_write` tools, which it offers when its memory is a store it reaches through tools rather than a folder. The input schemas in `src/server.ts` are Claude Code's too.
- `src/prompt.ts` loads `MEMORY.md` as Claude Code loads it: "Contents of <path> (user's auto-memory, persists across conversations):", cut past 200 lines or 25,000 bytes with Claude Code's warning.
- `src/store.ts` names a project's folder as Claude Code does: the real path of the Git repository's main working tree (so subfolders and worktrees share it; a worktree of a bare repository belongs to the bare repository's folder), or of the folder outside a repository, with every character other than a letter or digit turned into `-`, and Claude Code's hash after the first 200 characters. Version tokens (the first 12 hex digits of the content's SHA-256), the 102,400-byte read and write cap, 50-entry list pages, the path rules, the reserved folder names a write may not use and the content cleaning follow Claude Code's tools, and so do the tools' results and refusals. Claude Code also refuses a list of config file names as path parts; the plugin leaves that list out, since a memory path must end in .md, .txt, .json or .jsonl anyway.
- `src/secrets.ts` refuses the common credential shapes, named as in gitleaks; Claude Code checks against a longer gitleaks rule set.

## Edits to Claude Code's text

- `section.md`: "write to it directly with the Write tool" becomes "write to it directly with the memory_write tool, as the store `personal`", followed by a new sentence, "Store paths start at that directory, so its index is `/MEMORY.md`." Codex has no Write tool, the server's write keeps Claude Code's version and secret checks, and the tools take paths within the store, not the folder's full path.
- `section.md`: "delete memories that turn out to be wrong" becomes "rewrite or retire memories that turn out to be wrong". The tools can't delete a document; `memory_write.md` says how to retire one.
- `section.md`: "(code structure, past fixes, git history, CLAUDE.md)" adds AGENTS.md, the file Codex reads in its place.
- `section.md`: "Recalled memories appearing inside `<system-reminder>` blocks are background context" becomes "Memories are background context". Codex has no system reminders, and nothing recalls memories into a turn yet (see below).
- `memory_write.md`: "not what CLAUDE.md, the code, …" adds AGENTS.md.
- `memory_write.md`: "Never write secrets or credentials into a memory — project stores are shared with every collaborator, and such writes are refused in every store." becomes "Never write secrets or credentials into a memory — such writes are refused." The plugin has one private store, not shared project stores.

## How the plugin differs from Claude Code

- One store, `personal`: the project's memory folder under `~/.agents/memory` (or `AGENT_MEMORY_DIR`). `memory_list` with no arguments lists only that store; Claude Code's team and project stores aren't ported.
- The server's MCP `instructions` are the plugin's own short pointer to the section, for a session that starts without it.
- Codex runs one server for every session of its app server, so the server takes each call's folder from Codex's metadata: `_meta["codex/sandbox-state"].sandboxCwd`, which Codex sends because the server asks for it (`codex/sandbox-state-meta`), else the Git root in `x-codex-turn-metadata.workspaces`, else a `PWD` its client set. A call with none of them is refused rather than saved under the wrong project.
- The secrets refusal leaves out Claude Code's "Memory is synced to your account", which isn't so here.
- Claude Code keeps its own auto memory; the plugin's hook there only checks that `CLAUDE_CODE_REMOTE_MEMORY_DIR` points at the shared store.
- Not ported: the background extraction agent that saves memories after a turn ("You are now acting as the memory extraction subagent"), recall of relevant memories into a turn (a side query that picks up to five, or a BM25 index), and consolidation ("# Dream: Memory Consolidation"). Claude Code 2.1.318 turns them on only behind flags.

## Re-syncing

Capture the four texts from the newer Claude Code (the section from a session's system prompt with auto memory on, the tool descriptions from a session whose memory is a tool store), commit them verbatim over `src/text/`, then reapply the edits above in a second commit. Compare the index loading, project key and tool behavior in `src/prompt.ts`, `src/store.ts` and `src/server.ts` with the release too.
