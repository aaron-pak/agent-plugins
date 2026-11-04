# What makes an eval trustworthy

An eval is worth what the decisions made with it are worth. These are the ideas the build-eval and
hillclimb skills lean on. They come from Anthropic's "Demystifying evals for AI agents", "Automating
eval design and hillclimbing with Claude", the `claude plugin eval` docs (whose runner `evals run`
ports) and the eval guides in the `claude-api` skill, restated for this plugin's setup.

## Read the transcripts

A score is a summary of transcripts, and most surprising scores are bugs in the eval, not facts
about the model. Read the runs behind any number you act on: what the agent did, what the grader
saw, why it passed or failed. Each run's transcript is the `tracePath` in `aggregate-result.json`.

## Start from real failures

Twenty to fifty cases drawn from things that actually went wrong beat hundreds of invented ones.
Saved traces are the first source, then the user's sessions, then their own examples; synthesize
last, anchored on real cases. Saved failures alone skew toward the obvious and the memorable, so
also sample ordinary uses nobody complained about.

## Both directions

Every behavior has a twin: ask when it should and don't ask when it shouldn't; fire the skill when
it applies and stay quiet when it doesn't; act and refrain. A suite that tests only one side is
won by always doing that side. Every suite has at least one case where the target must not act.

## Grade outcomes, cheapest first

Grade what the run left behind, not the narration. In order of preference: a deterministic check
(a regex on the reply or a file, a file that exists, a mock call's arguments), a binary criterion,
a judged rubric of concrete PASS and FAIL claims, a preference judgment. Tool checks are guardrails
("never called Bash with rm") and say whether the target engaged; they are never a case's only
scored grader. Keep judged graders on short text: a judge reading a long file or a long trace is
noisier than a regex over it.

## Judges

Runs and judges use Opus, the runner's default; never a small model as the judge. A judge from the same family as the agent under test can prefer
answers like its own, and here both are Opus, so the check is calibration: the judge must agree with
the user on clear-cut cases (about 9 in 10 or better) before its scores steer anything, and it must
fail an empty reply, "I don't know" and a confident answer to the wrong question. The judge votes
PASS or FAIL three times and sees only the first and last 12 messages of a trace; its votes are all
the reasoning it gives.

## When a change is real

**Planning.** Before a suite is used for a decision, put three numbers side by side: the noise
(the expected 95% half-width of a paired difference between two runs of the same setup), the
headroom (the best possible score minus the baseline) and the smallest change the user would act
on. For a pass rate the noise is roughly `1/√(cases × runs)`: 20 cases × 3 runs is about ±13 points,
50 × 3 about ±8. If the noise is wider than the headroom or the smallest change worth acting on, the
suite can't answer the question: say so before anything is spent, and offer more cases (they help
far more than more runs, because a case's runs share its difficulty), a finer metric, or trimming to
the cases that discriminate for iteration with a full confirm at the end. An A/A run (the same setup
twice) measures the noise directly.

**Deciding.** Compare two results with `evals compare A B`. A change is real when:

- the 95% interval on the paired per-case difference excludes zero,
- the difference is at least the smallest change the user would act on, and
- no guardrail (cost, turns, time, an untouched behavior) moved the wrong way beyond its own interval.

With fewer than about 20 paired cases, call any result directional. The sign test (cases better
against cases worse) is the check that doesn't assume a shape; when it and the interval disagree,
say so. Runs that errored, timed out or were stopped by the cost ceiling are plumbing, not model
behavior: count them, fix them, and keep them out of the comparison (`--drop-errors`) until fixed.
A run that hit the turn cap is behavior, not plumbing, and stays in.

## Train, test and confirm

Tuning on the cases you report overfits them. Split the cases at random, stratified by their first
tag, with every case from one source session or failure on the same side. Change things by reading
train; choose the winner by test; report a fresh confirm run of the baseline and the winner, since
choosing by test makes the winner's test score optimistic. Never paste a failing case's specifics
into the thing being tuned: fix the behavior, not the example.

## Cases from real moments

A recorded session can be cut into a case: the conversation before a turn becomes the history the
run resumes, and the user's message becomes the prompt (`evals capture`). The run replays from that
message on, so the earliest a case can start is a user message; a response in the middle of a turn
can't be replayed on its own, only the turn that contains it.

- A **turn case** reruns the whole turn and grades where it ended up. Use it when the failure built
  up over the turn, or sits inside it.
- A **decision case** grades only the first response (`max_turns: 1`): what the agent said or which
  tool it reached for first. Use it when the moment was the turn's first response. Hitting the turn
  cap is expected there and shows as a run error.

The history is real content: names, internal systems, sometimes secrets. Captures go outside any
repository, in a folder git ignores, and are read before anything is shared.

**Off-policy bias.** A replayed history was written by the old setup. A change can only show its
effect from the cut on, and the agent is steered by everything the old setup already said and did,
so recorded cases lean toward the recorded behavior. A change that moves them is likely real; one
that doesn't may still help a conversation from its start. Confirm a winner on fresh cases.

## Captured versus derived

A capture is the situation exactly as it happened, which is its value and its limit: one draw of
a noisy process, with incidental detail. Before tuning on a capture, run it several times without
any change. If it rarely fails, it can catch a regression but can't show a fix; keep it for the
regression suite. A derived case (the capture minimized, cleaned, rewritten, or turned into several
variants of the same shape) generalizes better, but it must fail under the old setup about as often
as the capture did, or it no longer tests the failure.

## Isolation

Each run gets a temporary home, working folder and config folder: no user settings, instruction
files (unless the case loads one on purpose), memory, hooks, MCP servers or other plugins load, and
shell commands run in the harness's OS sandbox, which can't read the user's home. That is what keeps runs from touching real sessions and services.
MCP servers are mocked unless real ones are explicitly started, and no case may reach a real
service. Anything the agent must not see (expected answers, graders, the evidence in `original.md`)
stays out of the workspace and its read grants; under optimization the agent will find it.

## A living suite

Cases that always pass, in every setup, stop discriminating: move them to a regression suite that
is run but never tuned on. New failures from real use become new cases. When the target, the model
or Claude Code changes, rerun the baseline; comparisons across a changed environment are broken.
