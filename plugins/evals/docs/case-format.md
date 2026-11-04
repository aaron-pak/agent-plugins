# Cases, runs and the helper

Everything goes through one command, `bin/evals` at this plugin's root (`${CLAUDE_PLUGIN_ROOT}/bin/evals`
in Claude Code; elsewhere, two folders up from a skill's folder). `evals run` runs a suite: it reads
the same case files as Claude Code's `claude plugin eval` and grades and reports the same way, in
the plugin's own code, with the agent under test running in Claude Code or Codex. The other
commands read sessions and results and never call a model. This page covers what the skills need.

## Where things live

- **Traces** (bookmarks of moments in sessions): `$EVALS_HOME/traces/`, default
  `~/.claude/evals/traces/`. Set `EVALS_HOME` to keep them somewhere else, such as a private
  repository's checkout.
- **Suites with recorded content** (captured cases, `proposal.md`, results): a working folder under
  `$EVALS_HOME/suites/<name>/`, or any folder git ignores. `evals capture` refuses to write where git
  would commit it.
- **Suites with no recorded content**: they may live in the plugin, under `evals/` (or the folder
  `plugin.json` names in `experimental.evals`), with `results/` git-ignored.

A suite folder holds an `evals/` folder of cases, and is itself the target of a run:
`evals run <suite folder>`. A case says which plugin it tests with `plugins:` (paths
relative to the case folder); with none, it runs against Claude Code alone.

## A case

```text
<suite>/evals/<case>/
├── prompt.md          # optional frontmatter (run limits, tools, tags); body: the user's message
├── case.yaml          # optional: schema_version "1.1", name, plugins, context.*, execution.*
├── graders/<name>.md  # one per grader; frontmatter: type and options; body: the rubric
├── mocks/<server>/<tool>.md   # optional: this case's MCP mocks
└── fixtures and scripts the case names
```

`prompt.md` frontmatter: `name`, `description`, `tags`, `plugins`, `runs` (default 3), `model`,
`max_turns` (default 10), `timeout_seconds` (default 300), `allowed_tools`, `append_system_prompt`,
`env` (`EVAL_*` keys only). Unknown keys are errors. In `case.yaml` the run fields sit under
`execution:`, and only `case.yaml` has `context.scaffold_script` (runs with `--scaffold`),
`context.history_file` (a recorded conversation to resume; the prompt is the next user turn),
`context.add_dirs` (read-only fixture folders) and `context.instructions` (an instruction file the
run loads; see below). `prompt.md` overrides `case.yaml` where both set a field.

Graders (`type:`), each with `weight` (default 1) and `arm` (`with-only` or `both`):

| type | passes when | costs |
|---|---|---|
| `regex` | `pattern` (JavaScript, `flags`) is in the `target`: `last_message` (default), `trace`, `files`, `{source: file, path: …}`, `mock_calls`; `match: not_contains` or `count:N` | free |
| `tool_used` | calls to `tool` whose JSON input matches `input_match` number between `min` (1) and `max` | free |
| `tool_order` | the first `before` call precedes the first `after` call | free |
| `file_exists` | a file the run created matches `path` (or none, with `exists: false`) | free |
| `llm` | a judge votes PASS on the rubric (the body) at least 2 of 3 times; `focus` as `target` | judge |
| `baseline` | a judge finds the run at least as good as the reference transcript `baseline_file` | judge |

There are no custom-code graders. To check a build or test inside a run, have the prompt ask Claude
to run it and write the outcome to a file, and grade the file.

Mocks: `mocks/<server>/<tool>.md` in the suite or the case; the body is the tool's result
(`{{input.<field>}}`, `{{file:fixtures/…}}`); frontmatter `expect:` guards the input (a violation
aborts the run with score 0), `error: true` returns an error, `type: agent` has the judge answer as
the server (with `abort_when`), `_server.md` answers several tools, `_tools.json` carries the real
tool descriptions. Unmocked tools aren't available. Real servers only with `--allow-real-servers`
or `--mocks off`.

## A run

```sh
E="${CLAUDE_PLUGIN_ROOT}/bin/evals"
$E run <suite or plugin> [--harness claude|codex] [--runs 3] [--ablation with-without|none] \
  [--case <glob>]... [--tag <t>]... [--allow-tools Write "Bash(npm test *)"] [--scaffold] \
  [--instructions <file> [--instructions-scope project|user] [--instructions-name AGENTS.md]] \
  [--max-cost-usd <usd>] [--output-dir <dir>] [-j 4] [--keep-temp]
```

- Runs and judges are Opus by default (`--model`, `--judge-model` to change; `--judge-harness`
  picks where the judge runs, Claude Code by default). Under `--harness codex` the run uses Codex's
  own default model unless `--model` names one.
- `--ablation with-without` (the default when a plugin resolves) adds a no-plugin arm and reports Δ.
  Under it, `tool_used: Skill` graders and `arm: with-only` graders are indicators, not scored;
  under `none` they score. Keep one mode for every run you'll compare. A case with a history file
  runs one arm unless `--ablation with-without` is passed.
- Each run gets a fresh temporary home, working folder and config folder: none of the user's
  settings, instruction files, memory, hooks, MCP servers or plugins load, and only the PATH,
  locale, proxy and model credentials pass through from the environment. Claude Code's Bash runs in
  its OS sandbox, which can't read the user's home; Codex runs in its read-only sandbox, or
  workspace-write when the case grants Bash, Write or Edit.
- Runs never ask for permission. Read-only tools are always granted; a case's other
  `allowed_tools` need `--allow-tools`. Mocked tools are granted automatically.
- **Instruction files load for real.** `--instructions <file>` (or a case's `context.instructions`,
  relative to the case) is written where the harness reads it: `CLAUDE.md` (Claude Code) or
  `AGENTS.md` (Codex) in the working folder, or the user's config folder with
  `--instructions-scope user`. Without one, no instruction file loads. A recorded case's history
  already holds the files its session loaded, so there the recorded text of that scope is replaced
  in a copy of the history (rendered the way Claude Code renders a file: frontmatter, HTML comments
  and trailing whitespace dropped, `@imports` not expanded). An A/B of two instruction files is two
  runs with different `--instructions`, then `evals compare`.
- **A recorded case resumes the way it would at home.** Claude Code re-reads a resumed session's
  instruction files and tells the model about any that changed or vanished, so the runner writes
  each file the history holds (after any replace) into the sandbox, where the recorded cwd, the
  folders above it, or the user's config folder map to, and moves the history's paths to match. A
  file with no place there (a managed file, or one more than two folders above the recorded cwd) is
  noted, and the model is told it's no longer present.
- **A recorded case resumes without its old reasoning.** The API keeps a signed thinking block only
  in the exact conversation that produced it: change anything before it (an instruction file, the
  tool list, a path) and the block is dropped. A sandbox always changes something, and a variant
  changes more than its baseline, so the runner removes the recorded thinking from every arm and
  says so in the run's notes; both arms then resume from the same visible history. The turns after
  an edit were still written under the old text, and the model can notice that (an edited rule its
  earlier replies didn't follow reads as its own mistake), so a decision point is best cut at the
  first turn the change could affect.
- A resumed Claude Code session reuses the system prompt it recorded, so a recorded case's
  `append_system_prompt` has no effect (noted on each run).
- `--max-cost-usd 0` loads every case and runs nothing: a free check that the suite parses (exit 2).
  Otherwise the ceiling is checked before each run starts; a run that crosses it skips its judged
  graders.
- The agent's credentials: Claude Code takes `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`),
  `ANTHROPIC_API_KEY` or a provider's variables from the environment, or copies
  `~/.claude/.credentials.json` (a macOS keychain login can't be passed to an isolated run). Codex
  takes `OPENAI_API_KEY` or copies `~/.codex/auth.json`.
- Exit code: 0 when every case reaches `--threshold` (default 1) with no errors, 1 otherwise, 2 for
  a partial run (cost ceiling, interrupted, or refused credentials).

Results: `<output dir>/aggregate-result.json` (default `<eval dir>/results/<timestamp>/`), and
`report.html` beside it. The top level has `harness`, `harnessVersion`, `costUsd`, `partial`,
`partialReason` and `suite` (with `instructions`: the file, its hash and scope). Per case,
`cases[].aggregates` (`score`, `scoreWithout`, `delta`) and per run `cases[].arms.with[]` /
`.without[]` with `score`, `turns`, `costUsd`, `judgeCostUsd`, `durationSeconds`, `error`,
`aborted`, `skippedPaidGraders`, `tracePath` (the run's event stream, kept in
`runs/<case>/<arm>-<n>/trace.jsonl` with the mock calls beside it) and `graders[]` (`passed`,
`scored`, `explanation`, `judgeVotes`, `evidence`).

Tool names: Claude Code names a plugin's MCP tool `mcp__plugin_<plugin>_<server>__<tool>` and Codex
`mcp__<server>__<tool>`; a mocked tool answers to `mcp__<server>__<tool>` under both, so write
graders with that name. Under Codex a shell command is `Bash`, a file edit is `Edit`, and reading a
skill's `SKILL.md` also counts as a `Skill` call for that skill.

## The helper

```sh
E="${CLAUDE_PLUGIN_ROOT}/bin/evals"
```

**Sessions** (read from `$CLAUDE_CONFIG_DIR/projects`, default `~/.claude/projects`):

- `$E sessions list [--since 7d] [--project <part>]`: recent sessions with their first message.
- `$E sessions search [--since 7d] [--used <tool|skill|server>] [--user-text <regex>]`: turns that
  used something, or user messages matching words; a text match prints the request id of the reply
  the message reacted to.
- `$E sessions turns <session>`: each turn's user message and each response's request id, tools and
  text, with notifications that arrived mid-turn.

**Traces:**

- `$E trace save --session <id|path> [--moment <ref>]... [--note <text>] [--user] [--good] [--tag <t>]... [--copy]`.
  A moment is a request id (`req_…`), a record uuid, or words from the user message that reacted to
  it; without one, the reply the latest user message reacted to. A message stands for the reply
  before it, or, when notifications arrived in that turn, the reply before the first of them (save
  warns). Notes are inferred unless `--user`. Saving the same moments again adds the note to the
  existing trace. The trace records the environment: Claude Code version, model and effort, working
  folder and branch, the instruction files loaded (path and hash) and, read at save time, the
  folder's commit and whether it had uncommitted changes. `--copy` freezes a copy of the transcript.
- `$E trace show <id>`: notes, environment, and each moment's user message, reply and reaction.
- `$E trace list [--tag t] [--used name] [--source user|inferred] [--good|--bad]`. `--used` matches
  what the moment's turn used: a tool, a skill (`plugin:skill`, `skill` or `plugin`), an MCP server.
- `$E trace update <id> [--set-note <text>|--add-note <text>] [--user] [--moment <ref>]... [--tag t] [--untag t] [--good|--bad]`.

**Capture** a recorded moment as a case:

```sh
$E capture --trace <id> [--moment <n>] --out <suite>/evals/<case> [--kind turn|decision] [--plugin <dir>] [--tag t]
$E capture --session <id> --moment <ref> --out …
```

It writes `history.jsonl` (the conversation before the moment's turn, exactly as a resumed session
sees it), `prompt.md` (the user's message), `case.yaml` (`context.history_file`, `max_turns`, tags,
`plugins:` from `--plugin`), `original-turn.jsonl` (what the agent did in the turn) and `original.md`
(the grading evidence: the trace's notes, every response in the turn, the user's reaction). It
writes no graders. `--kind decision` sets `max_turns: 1` and is refused when the moment isn't the
turn's first response. Images in the user's message can't be carried into the prompt (it warns).

**Grade** for free: `$E grade <case> [--transcript <jsonl>] [--text-file <file>]` runs the
`regex` (on `last_message`, and `trace` approximated from the transcript), `tool_used` and
`tool_order` graders against the recorded turn (default `original-turn.jsonl`), another transcript
in Claude Code's session format, or a text given as the final message. Judged graders are listed, not run.

**Instruction files in a history:** `$E instructions list <history.jsonl>` shows the files a
recorded case loaded; `$E instructions rewrite <history.jsonl> --replace <recorded path> --with <file>`
(or `--remove <path>`, `--add <path> --with <file>`) edits them by hand, in the record and in the
text the model was sent. `evals run --instructions` does the replace for you.

**Compare** two results: `$E compare <A> <B> [--cases <glob>]... [--drop-errors] [--min-effect 0.1] [--json]`
(each a results folder or an `aggregate-result.json`). It pairs cases by name and reports B against
A: the mean per-case score difference with a 95% t interval, cases better, same and worse with a
sign test, the half-width run-to-run noise alone would give, the same for turns, cost and seconds,
plumbing failures (timeouts, API errors, aborts; `--drop-errors` leaves them out, but not runs that hit the turn cap, which are behavior) and unjudged runs on each side, the cases that moved, and a verdict by the rule in
`principles.md`. It warns when the cases differ, a result is partial, the setups differ, or fewer
than 20 cases are paired.

## What isn't possible here

- A decision point inside a turn (after a tool result) or inside a subagent: a run can only start at
  a user message. Capture the turn instead.
- Regrading stored runs after a grader changes: rerun the cases. `evals grade` covers the free
  graders on a recorded turn.
- A simulated user over several turns, hidden tests on the final repository, and blind pairwise
  preference between two setups: not built yet.
- Codex as the agent under test can't resume a recorded Claude Code session (those cases fail),
  doesn't cap turns (`max_turns` is ignored; the timeout holds), can't allow tools one by one, runs
  no plugin hooks, and reports no cost (so `--max-cost-usd` can't bound it). Reading Codex
  sessions for traces isn't built yet.
- A judge reading an image: the judge is shown text only.
