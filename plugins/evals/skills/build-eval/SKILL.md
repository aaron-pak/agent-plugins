---
name: build-eval
description: Build an eval suite for a Claude Code plugin, a skill, an instruction file (CLAUDE.md, AGENTS.md, rules) or an MCP server, through an interview with sign-offs, and run its first baseline with the bundled plugin-eval runner. Use when the user wants an eval, wants to measure or test a plugin, skill, instruction file or MCP server, asks whether a change helped, wants a case built from a session or thread where an agent went wrong, or runs /build-eval.
---

# Build an eval

The goal is a suite the user trusts enough to make decisions with, plus a baseline number. The
user's sign-offs on the inputs and on the grading are what make it trustworthy, so they are the
product, not a formality. A suite that runs but that nobody believes is worth nothing.

The runner is `"${CLAUDE_PLUGIN_ROOT}/bin/plugin-eval"`, a port of `claude plugin eval` (same
case files, flags and results; no report publishing). Read these before you start:

- `${CLAUDE_PLUGIN_ROOT}/docs/case-format.md` — the case files, graders, mocks, flags and results.
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
  comes from an instruction or context variant instead). Say "I can't drop that, it's what makes the result mean something."
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

Ask for real material first: traces the user saved, then their sessions (`plugin-eval sessions search`), transcripts, bug reports
where the target should or shouldn't have acted. Then the user's own examples, and synthesize only
last, anchored on a few real ones and on what makes a case hard. Saved traces and corrections
alone skew toward obvious failures (user feedback is "sparse and self-selected"), so also sample
at random some ordinary uses of the target nobody complained about, and some sessions where it
shouldn't have fired. Before pulling transcripts, ask whether they may sit in
the repository (retention, customer data); if not, rewrite them into synthetic cases of the same
shape and show the rewrites.

Saved traces: run both `plugin-eval trace list --used <target>` (what the moment's turn used: a
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

1. Find the moment: a saved trace (`plugin-eval trace show <id>`), the id from the thread, or
   `plugin-eval sessions search --user-text '<words from their reaction>'`. `sessions turns <session>` lists its turns and whether each request
   rebuilds exactly, with what each request did.
2. Decide with the user where the failure lives (`docs/principles.md`, "Cases from real
   moments"): one response → a decision-point case at the step that went wrong (`--reply-before`
   the user's reaction, or `--request` for a step inside the turn, `--agent` for a subagent's
   step); a whole turn → a turn episode `--at` the message that started it, cut as early as the
   change could matter.
3. `plugin-eval capture ...` (`--trace <id>` for a saved trace) into `<work>/<case>`, where
   `<work>` is one working folder for the suite outside the repository or ignored by git, then
   read `original.md` with the user. Everything in it after the moment (the
   user's reaction, the trace's notes) is grading evidence and never reaches the agent under test.
4. Write the graders from the user's reaction: what they needed, as checkable claims rather than
   their exact wording, plus
   `tool_used` for decisions ("no `Agent` call"). A decision-point judge sees only the response,
   so quote the user's message and what they needed in the rubric. A turn episode also needs its
   environment: fixtures, the drafted mocks (review them and move them into `mocks/`), or read
   grants (`Read(//absolute/path)` through `--allow-tools`). Read grants show the files as they
   are today, which may already contain the fix; and Bash runs in the OS sandbox, which can't read
   the user's home whatever the grants say. A task about the live state of the user's machine is
   a poor turn episode.
5. **First gate, free:** the recorded response must fail the graders.
   `plugin-eval grade <case> --run <case>/original-run` grades exactly what the agent did. If it
   passes, the graders miss the problem; fix them before anything is paid for.
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
- **Judges:** a model other than the one under test, sonnet-tier or stronger. The rubric says what
  passes and what fails in concrete terms.
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
"${CLAUDE_PLUGIN_ROOT}/bin/plugin-eval" <target> --runs 1 --ablation with-without [--scaffold] [--allow-tools ...]
```

Pass `--scaffold` only for scaffolds you wrote. The runner asks to trust a plugin on first use;
from a non-interactive shell pass `--trust-plugin`, but only for plugins the user owns or has said
they trust. Run anything longer than a minute in the background and wait for it to finish.

Before the pilot, put an oracle and a null through every case's graders without running the
agent: `"${CLAUDE_PLUGIN_ROOT}/bin/plugin-eval" grade <case-dir> --output <file>` grades a text as
the final message (add `--workspace <dir>` for file graders). The oracle is a known-good answer
(the user's own, or one you wrote and they accepted), the nulls an empty file, "I don't know", and
a confident answer to the wrong question. Don't copy the judge into your own script: `grade` is the
real graders. Then check the pilot against `docs/audit.md` ("The run" and "The graders"). Each
run's transcript and graded files are under the results directory's `runs/`.

Calibrate with the user's judgment first: show them each case's output (its `last-message.txt`)
**before** the grades, ask how they'd score it, and only then compare with the graders. The judge
answers a bare PASS or FAIL, so there is no reasoning to show; its three votes are. Ask: **"Would
you have scored any of these differently?"** If yes for even one, the rubric isn't ready: revise
and re-pilot until the user and the graders agree on clear-cut cases (aim for about 9 in 10 or
better), then get an explicit yes. The user's good and bad saved traces for the target are labels a
judge can be checked on for free: it must pass the good replies and fail the bad ones before its
scores count. Only traces whose latest note is the user's (`trace list --source user`), or that
the user confirmed at the inputs gate, count as human labels; an inferred verdict is an agent's
guess.

## Step 4 — Cost (gate 3)

The pilot's `costUsd` in `aggregate-result.json` is what cases × 1 run × 2 arms really cost. A
full run is about that × `runs`. Show the math, the per-case spread, the expected wall-clock time,
and the planning check from "When a change is real". For recorded
cases the first run of each case and arm writes the prompt cache and the rest read it; capture
prints both prices. If it's too much, offer the levers:
fewer runs on cheap cases, a cheaper judge, or trimming cases that never discriminate (always
pass or always fail in both arms). The runs and cases you get approved are what you run;
`--max-cost-usd` can hold the line.

## Step 5 — Baseline and hand-over

Run the full suite. Check the results against `docs/audit.md` before showing anything: every
metric present and plausible, zero-score runs classified by their `error`, the headline recomputed
from the per-run scores. Then hand over the report path and a one-line headline (score, Δ against
the no-plugin arm with its interval or sign test). Name a case or two only if the user should look at them first.

Offer to commit the suite (cases, mocks, fixtures, scaffolds) with `results/` ignored (the runner
writes a `.gitignore` into each results folder). Leave captured material out unless the user says
otherwise: `request.json.gz`, `history.jsonl`, `original.md`, `original-run/` and stored `runs/` hold
real session content. If the user
wants to improve the target against it next, that's the **hillclimb** skill.

## Targets

**A plugin or a skill.** Target the plugin directory, or a skill directory (one with SKILL.md),
or an installed plugin by name. If the plugin is generated by a build, build it and target the
built directory, with the suite linked or copied in. Δ against the no-plugin arm is the headline.

**An MCP server.** Test it through the plugin that ships it. What usually matters is whether the
model picks the right tool from the user's words, passes the right arguments, handles errors, and
asks before writing. Mocks with `expect:` catch wrong arguments; `mock_calls` graders and
`tool_used` with `input_match` check the calls. The descriptions the model sees come from
`_tools.json`, so regenerate it from the server whenever the descriptions change, or you are
testing stale text. Δ against the no-plugin arm answers "does having the server help"; whether new
descriptions beat the old ones is a comparison between runs (hillclimb).

**An instruction file (CLAUDE.md, AGENTS.md, rules).** Tell the user which option you're using and
its trade-off:

- **Recorded moments first.** Decision-point cases and turn episodes captured from the user's
  sessions, or derived from them, run with `--instructions <new file> --instructions-replaces <the recorded path>`: the
  with arm gets the new text in place of the recorded file, rendered the way Claude Code renders
  it (frontmatter and HTML comments dropped), the without arm keeps the recording, and Δ is the
  change's effect on the exact situations that went wrong. Every edit is checked against every
  case before anything runs. A new `@import` in the file isn't expanded (the runner warns). Keep
  recorded and fresh cases in separate runs unless you pass `--baseline-instructions <file>`. `--context-replace`
  changes any other recorded text (one rule sentence, a tool description). This is where real
  failures are tested; mind the off-policy bias in `docs/principles.md`.
- **Fresh cases** with `--instructions <new> --baseline-instructions <old>`: every case runs with
  each version through the real loading path. Pick the scope where the file lives:
  `--instructions-scope user` for global rules (the run's user-level CLAUDE.md), `project`
  (default) for a repository's file, with `--instructions-name` when it isn't AGENTS.md. Good for
  synthetic cases and for confirming a change on new prompts.
- `setting_sources: [user, project]` in a case, plus a scaffold that writes the file: when one case
  needs its own instruction file or a whole `.claude/` layout. No A/B; compare runs.
- `append_system_prompt` — the text in the system prompt; tests the content, not the loading path.

## Failure modes

- Generating plausible cases and rubrics without the user reading them.
- Running anything paid before the user says go, or while a design question is open.
- Trusting a zero: a `$0.00` cost, a 0-turn run or a constant column is a wiring bug until proven
  otherwise.
- Calling a timeout, an API error or a failed scaffold a model failure.
- Grading the narration instead of what the run left behind.
- One suite for six flows.
