---
name: hillclimb
description: Improve a plugin, skill, instruction file or MCP server against an existing eval suite, one measured change per round, with a held-out test split. Use when the user wants to hillclimb or optimize a target against its eval, asks to tune a skill, prompt, description or instructions against an eval, or runs /hillclimb.
---

# Hillclimb

Run the suite, read the failures, change one thing, run again, and keep the change only if it
helps cases nobody tuned on. The loop is simple; the discipline is what makes the result true:
read transcripts rather than summary numbers, know which change caused which effect, keep a record,
and never tune on the cases you report. **The result is the test-split delta against the
baseline.** Train improvement is the process, not the result.

Runs go through `claude plugin eval` with `--model opus --judge-model opus`; the helper that
compares them is `"${CLAUDE_PLUGIN_ROOT}/bin/evals"`. Both, with their files and results, are
described in `${CLAUDE_PLUGIN_ROOT}/docs/case-format.md`; the audit you run first is
`${CLAUDE_PLUGIN_ROOT}/docs/audit.md`.

## Step 0 — A suite you can trust

There must be a suite that runs and that the user signed off. If there isn't, build one first with
the **build-eval** skill. Run the audit on the suite as it stands, and these must pass before
round 1:

- **The suite can see the win you want.** Apply the planning half of `docs/principles.md`, "When a
  change is real": put the expected half-width of a paired difference (from the baseline, or an
  A/A run) next to the headroom and the smallest improvement the user would act on. If it's wider,
  say so now and offer more cases (which help far more than more runs, especially for decision
  points) or a finer metric.
- **The mechanism is wired.** Disable what you're about to tune and confirm the score drops: the
  with-without Δ, or the cases that depend on a tool losing it. If the score doesn't depend on the
  lever, tuning it is editing and hoping.
- **Zeros are classified.** Read the baseline's lowest cases: their output, the grader's reasoning,
  the expected result. Fix a wrong rubric or reference now and run the baseline again (stored runs
  can't be regraded), and keep plumbing failures (timeouts, API errors, mock failures) out of the
  denominator.
- **The headline recomputes** from the per-run scores in `aggregate-result.json`.

## Step 1 — Goal and scope

Ask what to optimize, listing what the suite records: raise the score; hold the score and cut cost
or turns; or move to another model and recover the score. The answer sets the target metric and
turns every other metric into a guardrail that must not regress beyond noise.

Ask what may change: a skill's body, its description (whether it fires), tool descriptions or
server instructions, an agent or hook, an instruction file, the model or effort, or code. Ask what
is off limits; there is almost always something. Record the files the runner, graders and fixtures
live in: changing those changes the measurement, so they're off limits unless the user approves
each change.

When the target is whether a skill fires, its description is the lever and the trigger check is the
metric. Run that loop with `--ablation none`, where `tool_used: Skill` graders are scored, and
keep it on `--ablation none` for every round, the baseline included.

When the target is an instruction file, build each round's suite with `evals variant --suite
<suite> --out <state>/r<N>/suite --file <the round's file> --replaces <the recorded path>` and run
that folder. Build round 0 the same way from the original file, so every round reaches the agent
by the same path and each round's Δ is measured against the original. Edit a working copy, never
the user's live file, until the winner is chosen. A recorded case resumes the recorded
conversation with the plugin as it is now: an edit to the plugin reaches it from the cut on, an
edit to the instruction file on disk never does, and the history still shows what the old version
said and did.

With cases captured from real sessions, the decision cases are the loop's suite, with their own
train/test split. Turn cases are a separate confirm suite, run on the baseline and on the winner,
never tuned on. Recorded cases lean toward the recorded behavior (`docs/principles.md`,
off-policy bias), so a change that moves them is likely real, and one that doesn't may still
deserve a turn-case or fresh-case check before you drop it.

## Step 2 — Plan and stopping rule

Measure one full pass (cost and time from a real run, not a guess) and ask how often to check in:
until plateau (the target moves less than the noise for three rounds in a row, or a guardrail
regresses), one round at a time, or N rounds. If cost matters, show baseline plus every planned
round and get a ceiling; pass it as `--max-cost-usd` each round. Then confirm the plan: what will
change and what won't, whether the user approves each round's diff before it runs (recommend it for
anything other people read in the user's name), and how you'll run the loop. Wait for the yes.

Run every round, round 0 included, under the same ablation mode and the same flags. Under
with-without, `tool_used: Skill` and with-only graders are an indicator outside the score; under
`--ablation none` they count; so switching modes between rounds changes the scoring formula, and
the rounds stop being comparable. If the no-plugin arm is too expensive to repeat, run the whole
loop on `--ablation none` and do one with-without run on the baseline and the winner at the end.

## Step 3 — Split, state and baseline

Split the cases **at random, stratified by their first tag**, never by baseline score, and keep
every case from one source session or one failure (its variants, its minimized copy) on the same
side, so a sibling of a train case can't land in test. Train is what the analyzer reads; test is
never read and decides which round wins. Picking the worst cases
for train tunes for the tail and buys regression to the mean. Check after the baseline that train
and test means agree within noise, and redraw if they don't. With fewer than about 20 cases,
don't split: run everything, lean on more runs, and call the result directional.

Keep the loop's state on disk so it survives a lost session, in
`<eval dir>/results/hillclimb-<name>/` (the runner never reads cases from `results/`):

- `state.json` — goal, guardrails, scope and off-limits, the train and test case names, runs per
  case, the stopping rule, the current round and the best round.
- `r0/`, `r1/`, … — each round's results (`--output-dir <state>/r<N>`), plus, for every round after
  the baseline, `change.md` (the hypothesis, the behavior it targets, the cited traces) and
  `change.patch` (the diff, cut against the real files).
- `narrative.md` — the status table and one paragraph on what's winning and why, rewritten after
  every round.

Run the baseline on the full suite and record an environment fingerprint with it: commit, plugin
build, model, judge, Claude Code version. If any of it changes mid-loop, re-run the baseline; comparisons
across it are broken.

## Step 4 — The loop

Each round: analyze, apply, run, record. Run the suite in the background and wait for it to finish
before reading anything; a half-landed round can show a sign that flips.

**Analyze.** Unless the next change is obvious, start a fresh analyzer subagent each round. Give it
only: the train cases' rows from the last round's `aggregate-result.json`, the transcript at
each train run's `tracePath` (list them; it reads nothing else under the results directory), each
train case's
score in every round so far, the current artifact, the scope and off-limits, the target metric,
the guardrails and the noise (the interval on a paired difference). Ask it for the single behavior that costs the most on train,
how many cases show it and what it costs, and one change, as a diff, that fixes it at the root,
with the trace lines that motivate it quoted. If no single behavior costs more than the noise
floor, it says so instead of proposing a change. You never read test traces, and you never pass
test results to the analyzer.

**Apply.** One hypothesis per round, even if it touches several places, so you know what worked.
Fix the cause (rewrite the section, add the missing rule, fact or tool), not a reworded line:
a change smaller than the noise gets kept or reverted by chance. Describe the failing
behavior, never paste a train case's specifics into the artifact. Cut platitudes and restated
defaults from the diff before applying it. Save `change.md` and `change.patch`. If the plugin is
built, rebuild it.

**Run.** The loop's whole suite, train and test, same runs per case, every round, so every round
is comparable. A round
whose errors look nothing like the baseline's is void: fix it and run again.

**Record and decide.** `evals compare <current best> <this round> --cases <test cases>` gives
the paired Δ on test; train the same way for the overfitting check. Keep the change only if test
improves by the rule in `docs/principles.md`, "When a change is real", and no guardrail regresses. Revert if
the test change is within noise, if train rose but test stayed flat (it overfit), or if it
regressed. If train fell but test rose, treat it as noise unless it repeats. Update `state.json` and `narrative.md`, and give the user one line:
"r3 test 0.71 → 0.74, change: …".

If a judged score jumps further than the change could explain, suspect the judge before you
celebrate. Read a few outputs by hand. The judge answers a bare PASS or FAIL three times; its
votes are all the reasoning you get, so judge the outputs yourself.

For turn cases with read grants, the agent reads files as they are today, which may
already contain a fix made after the session was recorded; check before crediting a round. Track whether the mechanism engaged (the skill fired, the
tool was called) next to the score; a score that moved while engagement didn't is probably noise.

## Step 4.5 — When it stalls

After two or three rounds without a test change beyond noise, stop changing content and spend one
round sorting every remaining train failure by cause:

| cause | tell | instead of another content round |
|---|---|---|
| artifact gap | the agent lacked a fact or rule and guessed | keep going |
| grader | the output looks right but fails, or the rubric asks for something the prompt doesn't | fix the grader, then run the baseline and the best round again (stored runs can't be regraded) and check whether the ranking changed |
| harness | timeouts, API errors, mock or scaffold failures, budget hit | fix the plumbing; leave those runs out until then |
| structural | the content exists but isn't reached, or the same finding recurs | reorganize (consolidate, split, fix routing) rather than add |
| variance | identical setups flip between runs as much as rounds differ | report best-so-far; offer more runs or a new target |

A long tail of small, independent gaps can take one breadth round that covers them all; say that
it breaks the one-change rule and why.

## Step 5 — Report

Leave the target at the round that won on test. Because test also chose the winner, the winner's
test score is optimistic. Before reporting, run a **confirm**: fresh runs of the baseline and the
winner on the test cases only (or on held-back cases, if you kept some), plus the turn-case
confirm suite if there is one. Train cases never count toward the headline. Then:

- **Headline:** the confirm runs' paired Δ from `evals compare`, with its interval or sign
  test. If it isn't real by the rule in `docs/principles.md`, say so plainly and recommend not
  merging.
- The round table: change, train, test, guardrails (cost, turns), with only the deltas that clear
  noise highlighted. If train and test drift apart, say so.
- Each change still applied, with its one-sentence why, marked required (fixes something broken) or
  tune (a judgment call the user can decline).
- Failures by cause: capability misses versus plumbing.
- Two or three before-and-after trace pairs for the behavior you targeted.
- The final with-without run, if the suite uses ablation.
- What you'd try next, including levers outside the scope.

## Failure modes

- Reading test traces, or letting test results shape a change.
- Leaving expected answers where the agent can reach them; under optimization it will find them.
- Climbing a suite that wasn't audited first.
- Stacking unrelated edits in one round.
- Grinding content at a wall instead of sorting the failures.
- Letting the environment shift mid-loop.
- Changing the suite, the split or the budget without going back to the user.
