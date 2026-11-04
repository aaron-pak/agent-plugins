# Cases, runs and the helper

Runs go through Claude Code's own `claude plugin eval` (documented at
https://code.claude.com/docs/en/plugin-evals; `claude plugin eval --help` is the source of truth for
the installed version). This plugin adds a helper, `"${CLAUDE_PLUGIN_ROOT}/bin/evals"`, that reads
sessions and results and never calls a model. This page covers what the skills need from both.

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
`claude plugin eval <suite folder>`. A case says which plugin it tests with `plugins:` (paths
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
`context.history_file` (a recorded conversation to resume; the prompt is the next user turn) and
`context.add_dirs` (read-only fixture folders). `prompt.md` overrides `case.yaml` where both set a
field.

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
claude plugin eval <suite or plugin> --model opus --judge-model opus --runs 3 \
  [--ablation with-without|none] [--case <glob>] [--tag <t>] [--allow-tools Write "Bash(npm test *)"] \
  [--scaffold] [--max-cost-usd <usd>] [--output-dir <dir>] [-j 4] --no-publish
```

- Always pass `--model opus --judge-model opus`; the default judge is a small model.
- `--ablation with-without` (the default when a plugin resolves) adds a no-plugin arm and reports Δ.
  Under it, `tool_used: Skill` graders and `arm: with-only` graders are indicators, not scored;
  under `none` they score. Keep one mode for every run you'll compare. A case with a history file
  runs one arm unless `--ablation with-without` is passed.
- Runs never ask for permission. Read-only tools listed in `allowed_tools` are granted; anything
  else needs `--allow-tools`. Bash runs in an OS sandbox that can't read the home directory.
- `--max-cost-usd 0` loads every case and runs nothing: a free check that the suite parses.
- A first run in an untrusted folder asks to trust it; a non-interactive run needs `--trust-plugin`,
  only for a plugin the user owns or trusts.
- `--no-publish` keeps the report local (a run a Claude Code session starts stays local anyway).

Results: `<output dir>/aggregate-result.json` and `report.html`. Per case, `cases[].aggregates`
(`score`, `scoreWithout`, `delta`) and per run `cases[].arms.with[]` / `.without[]` with `score`,
`turns`, `costUsd`, `judgeCostUsd`, `durationSeconds`, `error`, `aborted`, `skippedPaidGraders`,
`tracePath` (the run's transcript) and `graders[]` (`passed`, `scored`, `explanation`, `judgeVotes`,
`evidence`). The top level has `claudeVersion`, `costUsd`, `partial`, `partialReason` and `suite`.

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

**Instruction-file variants.** No CLAUDE.md, AGENTS.md or rules file loads in a run. Two ways in:

- A recorded case carries the files its session loaded, as an `instructions` record in the history.
  `$E instructions list <history.jsonl>` shows them; `$E instructions rewrite <history.jsonl>
  --replace <recorded path> --with <file>` (or `--remove <path>`, `--add <path> --with <file>`)
  puts new text where the old was, in the record and in the text the model was sent, rendered the
  way Claude Code renders a file (frontmatter and HTML comments dropped; `@imports` are not expanded).
- A fresh case gets the file through a small plugin whose SessionStart hook adds it as context,
  with the same "Contents of <path>" header. It's close to the real loading path, not the same:
  the text arrives as hook context.

`$E variant --suite <dir> --out <dir> --file <new text> --replaces <recorded path> [--path <path for fresh cases>] [--type Project|User|Local]`
copies a suite (without `results/`) and applies one variant to every case: recorded cases' histories
are rewritten, fresh cases get the variant plugin added to `plugins:`. For an A/B comparison build
one variant from the old file and one from the new, run both the same way (`--ablation none`), and
compare. Under with-without, a fresh case's no-plugin arm runs without any instruction file.

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
- Codex sessions: not read yet.
