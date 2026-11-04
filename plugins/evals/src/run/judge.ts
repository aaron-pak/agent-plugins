// The judge for `llm` and `baseline` graders, with `claude plugin eval`'s prompts word for word: it
// votes PASS or FAIL three times on what it is shown, and the majority wins.

import type { Harness } from "./harness/types.ts";

export const JUDGE_SYSTEM = "You are a strict, terse evaluation judge for coding-agent traces.";
const VOTES = 3;
const TEXT_LIMIT = 100_000;
const TEXT_TAIL = 20_000;
const TRACE_EDGE = 12;

/** Keeps the start and end of a long text, as the judge sees it. */
export function clipForJudge(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const head = TEXT_LIMIT - TEXT_TAIL;
  return `${text.slice(0, head)}\n[…${text.length - TEXT_LIMIT} chars elided…]\n${text.slice(text.length - TEXT_TAIL)}`;
}

/** A trace as the judge sees it: the first and last 12 messages, each as JSON. */
export function renderTrace(messages: unknown[]): string {
  const show = (m: unknown) => JSON.stringify(m);
  if (messages.length <= TRACE_EDGE * 2) return messages.map(show).join("\n");
  return [
    ...messages.slice(0, TRACE_EDGE).map(show),
    `[…${messages.length - TRACE_EDGE * 2} messages elided…]`,
    ...messages.slice(-TRACE_EDGE).map(show),
  ].join("\n");
}

export function llmPrompt(criteria: string, focusLabel: string, text: string): string {
  return `You are grading the output of a coding agent against a criterion.\n\nCriterion:\n${criteria}\n\n\nAgent output (${focusLabel}):\n${text}\n\n\nRespond with exactly one word: PASS or FAIL.`;
}

export function baselinePrompt(criteria: string, baseline: string, run: string): string {
  return [
    "You are comparing a NEW coding-agent trajectory against a BASELINE.",
    `Criterion:\n${criteria}`,
    `\nBASELINE trajectory:\n${baseline}`,
    `\nNEW trajectory:\n${run}`,
    "\nDoes the NEW trajectory satisfy the criterion at least as well as the BASELINE?",
    "Respond with exactly one word: PASS or FAIL.",
  ].join("\n\n");
}

export function readVote(text: string): boolean {
  return /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text);
}

export type Verdict = { passed: boolean; votes: boolean[]; explanation: string; costUsd: number };

export async function judge(
  harness: Harness,
  model: string | undefined,
  prompt: string,
  signal?: AbortSignal,
): Promise<Verdict> {
  const answers = await Promise.all(
    Array.from({ length: VOTES }, () => harness.ask(JUDGE_SYSTEM, prompt, model, signal)),
  );
  const votes = answers.map((a) => readVote(a.text));
  const passes = votes.filter(Boolean).length;
  return {
    passed: passes * 2 > votes.length,
    votes,
    explanation: `judge votes: ${votes.map((v) => (v ? "PASS" : "FAIL")).join(" ")}`,
    costUsd: answers.reduce((n, a) => n + a.costUsd, 0),
  };
}
