# Running pstack in your harness

pstack runs in Cursor, Claude Code, and Codex. Skills describe each action in neutral terms (spawn, read-only, background, the role's model). This page maps those terms to the harness you are in. When a skill says "per the harness reference", look the term up here.

`<pstack>` is the plugin root, two directories above any skill's `SKILL.md`. The helper CLI is `<pstack>/scripts/pstack` (Python 3, standard library). Run it with `--help` for every subcommand.

## Skills

| | Cursor | Claude Code | Codex |
|---|---|---|---|
| Invoke a pstack skill | `/how` | `/pstack:how` | `$how` |
| Skill-authoring skill | `create-skill` (built in) | `skill-creator:skill-creator` | `$skill-creator` |

Every pstack skill except `setup-pstack` is user-invoked only. Claude Code reads `disable-model-invocation: true`, and Codex reads `agents/openai.yaml` with `allow_implicit_invocation: false`. So when one pstack skill names another, through a link such as [how](../skills/how/SKILL.md) or a bolded name such as **principle-model-the-domain**, read that skill's `SKILL.md` under `<pstack>/skills/<name>/` and follow it. Don't wait for the harness to load it.

Skill directories, used when a skill writes or searches for skills:

- Project: use the directory the repo already has (`.cursor/skills/`, `.claude/skills/`, `.agents/skills/`, or `.codex/skills/`). If it has none, use the one for the harness you are in.
- User: `~/.cursor/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`.
- Installed plugins: `~/.cursor/plugins/`, `~/.claude/plugins/`, `~/.codex/plugins/`.

## Subagents

Skills use these terms. The table says what each one means here.

| Term | Cursor | Claude Code | Codex |
|---|---|---|---|
| Spawn a subagent | `Task` tool | Agent tool | native subagent tool if this Codex has one, else a seat (below) |
| General subagent | `subagent_type: generalPurpose` | `subagent_type: general-purpose` | default |
| `poteto-agent` | `subagent_type: poteto-agent` | `subagent_type: pstack:poteto-agent` | seat whose prompt starts "Read `<pstack>/agents/poteto-agent.md` and operate as that agent." |
| `comment-sicko` | `subagent_type: comment-sicko` | `subagent_type: pstack:comment-sicko` | seat that reads `<pstack>/agents/comment-sicko.md` the same way |
| Read-only | `readonly: true` | say so in the prompt (no tool flag) | `-s read-only` (seats pass it for you) |
| Background | `run_in_background: true` | `run_in_background: true` | run the seat in a background shell |
| Isolated worktree | ask the agent to work in a new worktree | `isolation: "worktree"` | `codex exec -C <worktree>` |
| Cloud worker | `environment: "cloud"` | `isolation: "remote"` | `codex cloud` |
| Resume an agent | `Task` resume | SendMessage to the agent | `codex exec resume` |

Read-only in Cursor strips MCP tools. Skills that need MCP (for example **why** investigators) keep their spawns writable and say "don't edit" in the prompt instead.

Nesting works up to three levels in Cursor and in Claude Code. If your harness allows less, the coordinator does the deeper level's work itself.

## Models per role

Roles, such as `feature, refactoring` or `interrogate reviewers`, map to a model value. Resolve every spawn the same way:

1. Run `pstack models get '<role>'`. It prints the line from `~/.config/pstack/models`, or the role's default when the file or line is missing. Panel roles print a comma-separated list, and each entry is one seat.
2. `inherit-parent` or `auto` means the parent chat's model. Spawn natively and leave the model unset.
3. Otherwise the value is a slug, `<model>-<effort>` with an optional trailing `-fast`, for example `claude-opus-5-5-xhigh` or `gpt-6.1-sol-xhigh`. The family is the first token (`claude`, `gpt`, `grok`).
4. Spawn natively when your harness can run that model:
   - Cursor: `Task` with `model: <slug>`.
   - Claude Code, `claude-*` slugs: the Agent tool with `model` set to the family alias (`claude-opus-5-5` → `opus`, `claude-sonnet-5-5` → `sonnet`, `claude-haiku-5-5` → `haiku`, `claude-fable-5-1` → `fable`) and `effort` set to the slug's effort. Use a seat for a Claude model no alias reaches.
   - Codex, `gpt-*` slugs: the native subagent tool if it accepts a model, otherwise a seat.
5. Otherwise run a seat. Write the prompt to a file, then run `pstack seat <slug> --prompt-file <file> --out <file> [--read-only] [--cwd <dir>]` in a background shell. Several seats can run in parallel. Each out file holds that seat's final report. `claude-*` seats run through `claude -p` and `gpt-*` seats through `codex exec`. A seat reads its own harness's instructions, so put everything it needs in the prompt file, including the agent file to read when the role names `poteto-agent`. Inside T3 Code, `delegate_task` to the slug's provider does the same job and shows up in the app.
6. If a slug fails to start, run that seat on the role's default (`pstack models show` lists it) and say so. If the default fails too, use the closest available model in the same family.

Cross-family panels (interrogate, arena, architect) get their signal from model diversity. Keep at least one seat outside the parent's family when the config allows.

`/setup-pstack` writes the config. `pstack models detect` lists the models the local CLIs can reach, and `pstack models probe <slug>...` confirms specific ones.

## Asking, tracking, looping

| | Cursor | Claude Code | Codex |
|---|---|---|---|
| Structured question | `AskQuestion` | AskUserQuestion | a numbered question in plain text |
| Todo list | todo tool | the todo or task tool | `update_plan` |
| Recurring loop | `/loop` | `/loop` | no loop. Keep working in the turn, or schedule a task if the host app has a scheduler |
| Mode that stays on | Custom Mode (Option+Enter on `/poteto-mode`) | start the session with `claude --agent pstack:poteto-agent` | invoke `$poteto-mode` per task |
| Plan mode | Plan Mode | Plan mode | none. Write the plan in the reply |

## Transcripts and state

Several skills read past agent chats. Never glob transcript directories by hand.

- `pstack transcripts list` lists the current workspace's transcripts from every harness, newest first, one per line: time, harness, `session` or `subagent`, path, and first prompt. Narrow it with `--harness claude|codex|cursor` and `--limit N`. Pass `--all-workspaces` only when the user asked about work outside this repo.
- `pstack transcripts show <file>` prints one transcript as plain `## user` and `## assistant` turns. Add `--tools` to include tool calls and results.
- Your own current chat is the newest `session` entry for your harness.

`pstack store` prints this workspace's state directory and creates it if needed. It lives outside the repo, under `~/.local/state/pstack/`. Use it wherever a skill says "the store", for example `ORCH_STORE` for the orch tool.

## MCP discovery

- Cursor: the available-tools map, or the `mcps/` directory it exposes.
- Claude Code: the `mcp__*` tools in this session, plus ToolSearch for deferred ones.
- Codex: the MCP tools in this session, or `codex mcp list`.

## Companions pstack doesn't ship

- `deslop`, from Cursor's `cursor-team-kit`: use it if installed. Otherwise, in Claude Code, use the built-in `simplify` skill. Anywhere else, review the diff for slop yourself, using **no-comments** and **unslop**.
- `control-cli` and `control-ui`, also from `cursor-team-kit`: the project's `verify-*` skill comes first. Otherwise drive the app with your harness's own tools: a shell for CLIs and TUIs, and browser or computer-use tools for UIs (in Claude Code, the `run` skill).
- Cursor's built-in `babysit`: never use it. The Babysit playbook replaces it everywhere.
