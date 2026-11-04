---
name: build-eval
description: Build an eval suite for a plugin, a skill, an instruction file (CLAUDE.md, AGENTS.md, rules) or an MCP server, through an interview with sign-offs, and run its first baseline under Claude Code or Codex. Use when the user wants an eval, wants to measure or test a plugin, skill, instruction file or MCP server, asks whether a change helped, wants a case built from a session or thread where an agent went wrong, or runs /build-eval.
---

# Build an eval

The goal is a suite the user trusts enough to make decisions with, plus a baseline number. The
user's sign-offs on the inputs and on the grading are what make it trustworthy, so they are the
product, not a formality. A suite that runs but that nobody believes is worth nothing.

Everything goes through this plugin's `bin/evals` (`"${CLAUDE_PLUGIN_ROOT}/bin/evals"` in Claude
Code; elsewhere, `bin/evals` two folders up from this skill's folder), called `$E` below. `$E run`
runs a suite the way Claude Code's `claude plugin eval` does, with the agent under test in Claude
Code (`--harness claude`, the default) or Codex (`--harness codex`), Opus for runs and judges. The
other commands read sessions and saved traces, cut cases from recorded moments, grade recorded
turns for free and compare results; they never call a model. Read these before you start:

- `${CLAUDE_PLUGIN_ROOT}/docs/case-format.md` — the case files, graders, mocks, flags, results and the helper.
- `${CLAUDE_PLUGIN_ROOT}/docs/principles.md` — what makes an eval trustworthy.
- `${CLAUDE_PLUGIN_ROOT}/docs/audit.md` — the checklist every suite you build must pass.

## How to run the interview

- One step at a time. Every decision goes to the user with your recommendation first, using the
  question tool when you have it; prose is for the three gates.
- **Three gates:** the inputs, the grading, and the cost. At each, state what you propose and
  wait for an explicit yes. Silence is not a yes, and neither is your own judgment that it's fine.
  If reaching a yes took several rounds, restate the final version once and confirm it.
- **Floor invariants**, kept even if the user pushes back, because they are what make the result
  mean something: at least one case where the target must not act; at least one outcome grader per
  case (never only `tool_used`); `runs` of 3 or more; and the with-without ablation on whenever
  there is a plugin to remove (cases captured from a session run single-arm under it; their Δ
  comes from an instruction-file variant or a comparison between runs instead). Say "I can't drop that, it's what makes the result mean something."
- The target is read-only. If the user asks you to fix it, note it as a follow-up and test it as it
  is. You write only in the eval directory.
- Fit the suite to the repository: where it already keeps evals, how it builds the plugin.
- Every run spends real money on the user's account. Nothing paid runs before the user says go.

## Step 0 — What is being evaluated

Read the target yourself and open with what you found: its skills, commands, agents, hooks, MCP
servers and the descriptions that make them fire. Surface contradictions between its README and
its skills. Pick **one flow**; a plugin with four skills is four suites. Then settle how the target
reaches the agent during a run (see "Targets" below), since that decides what the suite can
measure.

## Step 1 — What good looks like

Ask what a good result is, what a bad one is (wrong output, firing when it shouldn't, missing the
point), and which failures the user has actually seen. That becomes the spec the graders are
written against. Don't lift pass criteria from the target's own SKILL.md: that's the author's
intent, not the user's experience. A literal format string from it may be a secondary grader
(`weight: 0.5`) next to an outcome grader, never the only scored check.

## Step 2 — The inputs (gate 1)

Ask for real material first: traces the user saved, then their sessions (`evals sessions search`), transcripts, bug reports
where the target should or shouldn't have acted. Then the user's own examples, and synthesize only
last, anchored on a few real ones and on what makes a case hard. Saved traces and corrections
alone skew toward obvious failures (user feedback is "sparse and self-selected"), so also sample
at random some ordinary uses of the target nobody complained about, and some sessions where it
shouldn't have fired. Before pulling transcripts, ask whether they may sit in
the repository (retention, customer data); if not, rewrite them into synthetic cases of the same
shape and show the rewrites.

Saved traces: run both `evals trace list --used <target>` (what the moment's turn used: a
skill, command, plugin or MCP server name) and `trace list --tag <target>` (what the user filed it
under), since either can miss a trace the other finds. Read each one's notes (`trace show <id>`)
before keeping it; a note can say the trace is about something else. A note marked `inferred` is
an agent's reading, not the user's.

Aim for at least four cases where the target should act, in at least two different shapes, plus
one or two where it must not. Grow toward the size the decision needs: the planning check in
`docs/principles.md`, "When a change is real" (more cases help far more than more runs). A prompt that names the skill (`/plugin:skill ...`) tests the skill's work; a
prompt in the user's plain words tests whether it fires. Know which one each case is for.

### From the user's own sessions

When the user points at a thread ("that reply where I got confused", "the turn where it spawned a
subagent for nothing"), build the case from the recorded moment rather than paraphrasing it:

1. Find the moment: a saved trace (`evals trace show <id>`), the id from the thread, or
   `evals sessions search --user-text '<words from their reaction>'`. `evals sessions turns
   <session>` lists its turns, with each response's request id and what it did.
2. Decide with the user where the failure lives (`docs/principles.md`, "Cases from real
   moments"): the first response of a turn → a decision case (`--kind decision`, graded on that
   one response); anything later in a turn, or a whole turn → a turn case at the user's message
   that started it. A run can only start at a user message, so a step after a tool result or
   inside a subagent is tested through its turn.
3. `evals capture --trace <id>` (or `--session <id> --moment <ref>`) `--out <work>/evals/<case>`,
   where `<work>` is one working folder for the suite outside the repository or ignored by git
   (`~/.claude/evals/suites/<name>` by default), with `--plugin <dir>` when a plugin is under
   test. Then read `original.md` with the user. Everything in it after the cut (the agent's
   recorded turn, the user's reaction, the trace's notes) is grading evidence and never reaches
   the agent under test.
4. Write the graders from the user's reaction: what they needed, as checkable claims rather than
   their exact wording, plus
   `tool_used` for decisions ("no `Agent` call"). A decision case's judge sees only that one
   response, so quote the user's message and what they needed in the rubric. A turn case also
   needs its environment: fixtures, mocks for every MCP tool the turn called (capture lists them),
   or read grants (`Read(//absolute/path)` through `--allow-tools`). Read grants show the files as they
   are today, which may already contain the fix; and Bash runs in the OS sandbox, which can't read
   the user's home whatever the grants say. A task about the live state of the user's machine is
   a poor turn case.
5. **First gate, free:** the recorded response must fail the graders. `evals grade <case>` runs
   the deterministic graders on exactly what the agent did (`original-turn.jsonl`); read the
   judged rubrics against `original.md` yourself. If the recording passes, the graders miss the
   problem; fix them before anything is paid for.
6. **Second gate:** measure how often the recorded behavior fails. Run the recorded arm several
   times (`--runs 5`, no variant). One bad reply was one draw, and the same moment often goes fine.
   If it rarely fails, the case can catch a regression but can't show a fix: tell the user, and
   keep it for the regression suite rather than the suite you'll climb on.
7. **Derive the case to keep** (`docs/principles.md`, "Captured versus derived"): decide with the
   user whether the capture goes in the suite as it is, or a cleaned, minimized or rewritten
   version, and how many variants. Each derived case must fail under the old instructions about as
   often as the capture did.

For instruction-file work, also capture a few turns that went right as guardrail cases, so a
change can't fix one failure by breaking what worked (they're optimistic, see
`docs/principles.md`).

Recorded sessions hold real content (names, internal systems, sometimes secrets). Ask before
putting captured cases anywhere shared, and read a captured history before committing it.

Write every proposed case into a markdown file (an id/tags table, then each prompt in a fenced
block) and point the user at it. When the cases quote recorded content, that file is
`<work>/proposal.md`, next to the captures: capture refuses to write unless git ignores it too.
Never put recorded content into a file in the repository, and never recreate a cases file that
was removed from it. Ask whether these are representative, what's missing, and what
doesn't matter. Quote a case's lines when asking about it. Wait for the yes.

## Step 3 — The graders

Propose the grading as one table: case, short prompt, each grader (type and one-line spec), and
the tools the case grants. Prefer, in order: a deterministic check (regex, file present, file
contents, mock-call arguments), a binary criterion, a judged rubric of checkable claims, a
preference judgment. Grade outcomes; keep tool checks for guardrails ("never called the write
tool"). Show the criteria you considered and left out, and why.

- **Tools follow graders.** Grant exactly what the graders need, preferably through the skill's own
  `allowed-tools` so the without-plugin arm stays honest; list any `--allow-tools` in the run
  command. Size `timeout_seconds` and `max_turns` to the work: a one-shot answer about 120 s and
  5 turns; reading a repository, running something and writing a result 600-900 s and 25-40 turns.
- **Judges:** Opus, the runner's default. That is also the model under test, so calibration against the user (below) is the check on a judge that
  favors answers like its own. The rubric says what passes and what fails in concrete terms.
- **Side measures:** turns, cost and duration are recorded per run; ask whether any has a hard
  ceiling.
- End with "Things I'm unsure about". If the user softens a grader until it always passes, push
  back once ("that makes it a vanity metric — what version would catch a real regression?");
  if they insist, do it and list it as unsure.

### Mocks

If the flow calls MCP tools, no case may reach the real service. Write a mock for every tool the
flow can call (`mocks/<server>/<tool>.md`), ask the user what a realistic result looks like, and
put the arguments that must be right under `expect:`. Use one `_server.md` agent mock when later
answers depend on earlier calls, and start its `abort_when` list with the mistakes the user says
would embarrass them in production. Save the real `tools/list` as `_tools.json` whenever the
model's choice of tool matters. Real servers (`--mocks off`, `--allow-real-servers`) only with
the user's explicit approval, and never for tools that write.

## Step 3b — Pilot and calibrate (gate 2)

Write the case files, then pilot every case once:

```
$E run <target> --runs 1 --ablation with-without [--harness codex] [--scaffold] [--allow-tools ...] [--instructions <file>]
```

Check first that every case loads, for free: the same command with `--max-cost-usd 0` loads the
suite and runs nothing.

Pass `--scaffold` only for scaffolds you wrote: they run as the user. Run anything longer than a
minute in the background and wait for it to finish.

Before the pilot, put an oracle and a null through every case's graders without running the
agent: `$E grade <case-dir> --text-file <file>` grades a text as the
final message with the deterministic graders. The oracle is a known-good answer (the user's own,
or one you wrote and they accepted), the nulls an empty file, "I don't know", and a confident
answer to the wrong question. Judged graders and file graders are checked by the pilot itself; read
their verdicts on the oracle and nulls by hand. Then check the pilot against `docs/audit.md` ("The
run" and "The graders"). Each run's transcript is at its `tracePath` in `aggregate-result.json`;
`--keep-temp` keeps each run's workspace for reading what it produced.

Calibrate with the user's judgment first: show them each case's output (the run's final message)
**before** the grades, ask how they'd score it, and only then compare with the graders. The judge
answers a bare PASS or FAIL, so there is no reasoning to show; its three votes are. Ask: **"Would
you have scored any of these differently?"** If yes for even one, the rubric isn't ready: revise
and re-pilot until the user and the graders agree on clear-cut cases (aim for about 9 in 10 or
better), then get an explicit yes. The user's good and bad saved traces for the target are labels a
judge can be checked on for free: it must pass the good replies and fail the bad ones before its
scores count. Only traces whose latest note is the user's (`evals trace list --source user`), or that
the user confirmed at the inputs gate, count as human labels; an inferred verdict is an agent's
guess.

## Step 4 — Cost (gate 3)

The pilot's `costUsd` in `aggregate-result.json` is what cases × 1 run × 2 arms really cost. A
full run is about that × `runs`. Show the math, the per-case spread, the expected wall-clock time,
and the planning check from "When a change is real". For recorded
cases a long history is most of the cost of each run. If it's too much, offer the levers: fewer
runs on cheap cases, a shorter cut of a long history, or trimming cases that never discriminate
(always pass or always fail in both arms). The judge stays Opus. The runs and cases you get approved are what you run;
`--max-cost-usd` can hold the line.

## Step 5 — Baseline and hand-over

Run the full suite. Check the results against `docs/audit.md` before showing anything: every
metric present and plausible, zero-score runs classified by their `error`, the headline recomputed
from the per-run scores. Then hand over the report path and a one-line headline (score, Δ against
the no-plugin arm with its interval or sign test). Name a case or two only if the user should look at them first.

Offer to commit the suite (cases, mocks, fixtures, scaffolds) with `results/` ignored. Leave
captured material out unless the user says otherwise: `history.jsonl`, `original.md`,
`original-turn.jsonl` and `results/` hold real session content, and this plugin's own repository
is public. If the user
wants to improve the target against it next, that's the **hillclimb** skill.

## Targets

**A plugin or a skill.** Target the plugin directory (or a skill's folder); a suite in a working
folder names the plugin in each case's `plugins:`. Pick the harness the user runs the plugin in;
when it ships for both, run the suite under each and report them separately, never pooled. If the plugin is generated by a build, build it and target the
built directory, with the suite linked or copied in. Δ against the no-plugin arm is the headline.

**An MCP server.** Test it through the plugin that ships it. What usually matters is whether the
model picks the right tool from the user's words, passes the right arguments, handles errors, and
asks before writing. Mocks with `expect:` catch wrong arguments; `mock_calls` graders and
`tool_used` with `input_match` check the calls. The descriptions the model sees come from
`_tools.json`, so regenerate it from the server whenever the descriptions change, or you are
testing stale text. Δ against the no-plugin arm answers "does having the server help"; whether new
descriptions beat the old ones is a comparison between runs (hillclimb).

**An instruction file (CLAUDE.md, AGENTS.md, rules).** `--instructions <file>` loads a version
the real way: written as `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) in the run's working
folder, or in the user's config with `--instructions-scope user`. No other instruction file loads.

- **Recorded moments first.** Decision and turn cases captured from the user's sessions, or
  derived from them, carry the files their session loaded; with `--instructions`, the recorded
  text of that scope is replaced in a copy of the history, rendered the way Claude Code renders a
  file (frontmatter and HTML comments dropped; a new `@import` isn't expanded), so the resumed
  conversation reads the new text where the old was. This is where real failures are tested; mind
  the off-policy bias in `docs/principles.md`.
- **Fresh cases** read the file from disk exactly as a session would. Good for synthetic cases and
  for confirming a change on new prompts.
- Compare two versions as two runs of the same suite, one per `--instructions`, then
  `$E compare`. Run the old version the same way rather than reusing a result from before.
- `append_system_prompt` in a case: the text in the system prompt; tests the content, not where it
  loads.

## Failure modes

- Generating plausible cases and rubrics without the user reading them.
- Running anything paid before the user says go, or while a design question is open.
- Trusting a zero: a `$0.00` cost, a 0-turn run or a constant column is a wiring bug until proven
  otherwise.
- Calling a timeout, an API error or a failed scaffold a model failure.
- Grading the narration instead of what the run left behind.
- One suite for six flows.
