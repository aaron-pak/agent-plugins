# Audit checklist

Run this on every suite you build, before its first full paid run, and on any suite before round 1
of a hillclimb. Check the actual case files, results and transcripts, not a README. A broken suite
gives confident numbers that point the wrong way, and hillclimbing on one multiplies the error.

Report what you find as observations with evidence (the case, the file, the transcript line) and
one concrete fix each, most misleading first. An audit that finds nothing is a valid result.

## It runs

- The suite loads: `evals run <suite> --max-cost-usd 0` loads every case and runs none, for
  free. A case that fails to load is named above the summary.
- It has run end to end at least once, and the result is under `results/`.
- Runs you compare share one setup: harness and its version, model, judge, ablation mode and, unless
  it is the thing being compared, the instruction file. `evals compare` warns when they differ.

## The cases

- **Clear pass and fail.** Two careful people shown the same output would agree. "A good summary"
  is not a criterion.
- **A known-good answer passes.** Each case has an answer that passes its graders: the user's own, or
  one they accepted. A case nothing passes is broken more often than it is hard.
- **The answer isn't reachable.** Not in the prompt, the history, a fixture, a mock, a read grant or
  a file in the workspace. The eval directory itself is hidden from runs; `original.md` must stay
  in it.
- **Symptom, not investigation.** A case that asks the agent to find or fix something gives it what
  a user would report, not the file and line.
- **Both directions.** At least one case where the target must not act, and the suite isn't won by
  always acting or never acting.
- **Real shape.** Cases look like real use: the user's words, the length, the turns. A captured case
  says which kind it is (turn or decision) and the user agreed where the failure lives.
- **Headroom.** If the baseline already scores near 1.0, the suite can't show an improvement in
  quality, only in cost or turns; say so. If everything scores 0, suspect the case or the grader.
- **Spread.** Cases are not all one shape; tags record the shapes, and the first tag stratifies the
  hillclimb split.
- **Fresh.** Cases that depend on live facts or on files read through grants say when they were
  last checked; a read grant shows the files as they are today.

## The run

- **Plumbing is not a model failure.** Look at every run whose `error` isn't null, every `aborted`
  run and every run with `skippedPaidGraders`. A timeout, API error, failed scaffold, mock abort or
  cost ceiling is fixed and rerun, and kept out of comparisons until then, never averaged in as a 0.
- **A zero is a bug until proven otherwise.** A `$0.00` cost, a 0-turn run, a grader that fails in
  every run of every arm, or a column that never changes is a wiring problem first.
- **The tools match the graders.** The case grants exactly what its graders need. A tool listed as
  `not granted` in the progress output is a run that couldn't do the task.
- **Turn and time limits fit the work.** A run that hits `max_turns` or `timeout_seconds` without
  having finished is a limit problem (except in a decision case, where the cap is the point).
- **Mocks cover the flow.** Every MCP tool the flow can call is mocked; `unmocked` is empty; `expect:`
  guards the arguments that matter. Real servers only with the user's approval, never for writes.
- **The right setup.** `aggregate-result.json` shows the Claude Code version, model and judge you
  meant (`suite.modelOverride`, `suite.judgeModel`), and the plugin under test resolved (`suite.plugins`).
- **The mechanism engages.** Remove what you're testing (the plugin, the skill, the instruction
  file) and the score drops; with it, the transcripts show it engaging (the skill fired, the tool
  was called, the rule was quoted).
- **The headline recomputes.** Recompute the suite score and Δ from the per-run `score` values
  yourself before reporting them.

## The graders

- **The grader checks what the prompt asks.** A prompt that asks for an explanation isn't graded
  only on a number; "at least three" isn't graded as "more than three".
- **Outcomes over paths.** A different valid route passes. Tool checks guard decisions ("no `Agent`
  call", "asked before `rm`"); they are not the only scored grader.
- **Oracle and nulls.** A known-good answer passes; an empty reply, "I don't know" and a confident
  answer to the wrong question fail. `evals grade <case> --text-file <file>` checks the deterministic
  graders for free; a judged grader is checked by reading, or by a small paid run.
- **The recorded failure fails.** For a captured case, `evals grade <case>` on the recorded turn
  shows its deterministic graders failing it, and the judged rubric, read against `original.md`,
  would fail it too.
- **Not too rigid, not too lenient.** A regex survives formatting, casing and a sentence around the
  answer; a wrong but plausible answer fails.
- **Cheat-resistant.** There's no shortcut that satisfies the graders without doing the task:
  quoting the rubric, an empty file a lenient pattern accepts, doing nothing.
- **Judged graders are calibrated.** The user scored a sample before seeing the grades (`evals label`,
  then `evals agree`), and the judge agreed on about 9 in 10 clear-cut cases. Good and bad saved traces of the target are free
  labels: the judge passes the good ones and fails the bad ones. Only the user's own notes count as
  labels; an inferred note is an agent's guess.
- **Read the failures.** Of the outputs the graders failed, more than about one in ten looking right
  means the graders need fixing before the scores mean anything.
- **Atomic.** Separate properties are separate graders, weighted if they matter differently.

## It can see the change

- **Noise, headroom and the smallest change worth acting on** sit side by side
  (`principles.md`, "When a change is real"), from the baseline's own runs or an A/A run. If the
  noise is wider, say so before anything is tuned.
- **The split is random.** Train and test were drawn at random, stratified by first tag, with
  siblings of one source on the same side, and their baseline means agree within noise.
- **One environment.** Every round of a comparison ran on the same Claude Code version, model,
  judge, ablation mode, flags and plugin build.
