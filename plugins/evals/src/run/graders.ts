// Grading one run, as `claude plugin eval` does. Free graders read the run's last message, its event
// stream, the files it created, a file in its working folder, or the calls its mocks answered; judged
// graders ask the judge. Under ablation, graders that only mean something with the plugin (`arm:
// with-only`, a `tool_used: Skill` check, a check of calls to the plugin's own mocked servers) are
// reported but not scored, and not run in the arm without the plugin.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { type Case, type Focus, type Grader, type ToolRef, inCase, pathGlob } from "./case.ts";
import type { Harness, RunOutput, ToolCall } from "./harness/types.ts";
import { baselinePrompt, clipForJudge, judge, llmPrompt, renderTrace } from "./judge.ts";

export type GraderResult = {
  name: string;
  passed: boolean;
  weight: number;
  explanation: string;
  with_only?: boolean;
  scored?: boolean;
  judge_votes?: boolean[];
  criteria?: string;
  evidence?: string;
};

export type GradeContext = {
  case_: Case;
  run: RunOutput;
  /** Files the run created in its working folder, one per line. */
  cwdDiff: string;
  sandboxCwd: string;
  harness: Harness;
  judgeModel?: string;
  skipPaidGraders: boolean;
  /** Set only when the case runs more than one arm. */
  arm?: "with" | "without";
  /** Every mock that ran stands in for one of the plugin's own servers. */
  mockCallsWithOnly: boolean;
  /** Whether any mock ran (mock_calls graders need one). */
  mocksActive: boolean;
  signal?: AbortSignal;
};

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function label(focus: Focus): string {
  return typeof focus === "object" ? `file ${focus.path}` : focus;
}

function unavailable(g: Grader, reason: string): GraderResult {
  return { name: g.name, passed: false, weight: g.weight, explanation: reason };
}

type Text = { kind: "text"; text: string } | { kind: "unavailable"; reason: string };

function focusText(focus: Focus, ctx: GradeContext): Text {
  if (typeof focus === "object") {
    const file = resolve(ctx.sandboxCwd, focus.path);
    const rel = relative(ctx.sandboxCwd, file);
    if (rel.startsWith("..") || rel.startsWith("/"))
      return { kind: "unavailable", reason: `focus file ${focus.path} is outside the run's working folder` };
    if (!existsSync(file) || !statSync(file).isFile())
      return { kind: "unavailable", reason: `focus file ${focus.path} does not exist` };
    const real = realpathSync(file);
    if (relative(realpathSync(ctx.sandboxCwd), real).startsWith(".."))
      return { kind: "unavailable", reason: `focus file ${focus.path} links outside the run's working folder` };
    if (IMAGE.test(file))
      return {
        kind: "unavailable",
        reason: `${label(focus)} is an image; this runner shows the judge text only, so have the case write a text rendering and grade that`,
      };
    const bytes = readFileSync(real);
    if (bytes.includes(0))
      return {
        kind: "unavailable",
        reason: `${label(focus)} is binary (it holds a NUL byte); write it as UTF-8 text and grade that`,
      };
    return { kind: "text", text: bytes.toString("utf8") };
  }
  if (focus === "last_message") return { kind: "text", text: ctx.run.lastAssistantText };
  if (focus === "files") return { kind: "text", text: ctx.cwdDiff };
  if (focus === "mock_calls") {
    if (!ctx.mocksActive) {
      return {
        kind: "unavailable",
        reason:
          "no mock stand-ins were active in this run (--mocks off, or no mocks/ folder applies to this case); a mock_calls grader has nothing to check",
      };
    }
    return {
      kind: "text",
      text: ctx.run.toolCalls
        .filter((c) => c.mock !== undefined)
        .map((c) =>
          JSON.stringify({
            tool: c.name,
            input: c.input,
            ...(c.output !== undefined && { output: c.output }),
            ...(c.isError && { isError: true }),
            verdict: c.mock?.verdict,
          }),
        )
        .join("\n"),
    };
  }
  return { kind: "text", text: ctx.run.messages.map((m) => JSON.stringify(m)).join("\n") };
}

function callMatches(call: ToolCall, ref: ToolRef): boolean {
  if (call.name !== ref.tool && !call.aliases?.includes(ref.tool)) return false;
  return ref.input_match ? new RegExp(ref.input_match).test(call.inputText) : true;
}

function regex(g: Extract<Grader, { type: "regex" }>, ctx: GradeContext): GraderResult {
  const t = focusText(g.target, ctx);
  if (t.kind === "unavailable") return unavailable(g, t.reason);
  const re = new RegExp(g.pattern, g.flags);
  const all = t.text.match(new RegExp(g.pattern, g.flags.includes("g") ? g.flags : `${g.flags}g`)) ?? [];
  let passed: boolean;
  let explanation: string;
  if (g.match === "contains") {
    passed = re.test(t.text);
    explanation = passed ? `matched ${g.pattern}` : `pattern not found in ${label(g.target)}`;
  } else if (g.match === "not_contains") {
    passed = !re.test(t.text);
    explanation = passed ? "pattern absent as expected" : "pattern found (expected absent)";
  } else {
    const want = Number.parseInt(g.match.slice(6), 10);
    passed = all.length === want;
    explanation = `found ${all.length} matches (expected ${want})`;
  }
  return { name: g.name, passed, weight: g.weight, explanation };
}

async function judged(
  g: Extract<Grader, { type: "llm" | "baseline" }>,
  ctx: GradeContext,
): Promise<GraderResult & { costUsd: number }> {
  let prompt: string;
  let evidence: string;
  if (g.type === "llm") {
    const t =
      g.focus === "trace" ? ({ kind: "text", text: renderTrace(ctx.run.messages) } as Text) : focusText(g.focus, ctx);
    if (t.kind === "unavailable") return { ...unavailable(g, t.reason), costUsd: 0 };
    const shown =
      t.text === "" && g.focus === "files"
        ? "(no file changes)"
        : t.text === "" && g.focus === "mock_calls"
          ? "(no mocked tool calls)"
          : t.text;
    evidence = clipForJudge(shown);
    prompt = llmPrompt(g.criteria, label(g.focus), evidence);
  } else {
    const file = inCase(ctx.case_, g.baseline_file);
    const baseline = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return l;
        }
      });
    evidence = renderTrace(ctx.run.messages);
    prompt = baselinePrompt(g.criteria, renderTrace(baseline), evidence);
  }
  const v = await judge(ctx.harness, ctx.judgeModel, prompt, ctx.signal);
  return {
    name: g.name,
    passed: v.passed,
    weight: g.weight,
    explanation: v.explanation,
    judge_votes: v.votes,
    criteria: g.criteria,
    evidence: evidence.slice(0, 4000),
    costUsd: v.costUsd,
  };
}

async function one(g: Grader, ctx: GradeContext): Promise<GraderResult & { costUsd?: number }> {
  try {
    switch (g.type) {
      case "regex":
        return regex(g, ctx);
      case "tool_order": {
        const b = ctx.run.toolCalls.findIndex((c) => callMatches(c, g.before));
        const a = ctx.run.toolCalls.findIndex((c) => callMatches(c, g.after));
        if (b === -1) return unavailable(g, `"before" tool ${g.before.tool} never called`);
        if (a === -1) return unavailable(g, `"after" tool ${g.after.tool} never called`);
        const passed = b < a;
        return {
          name: g.name,
          passed,
          weight: g.weight,
          explanation: passed
            ? `${g.before.tool}@${b} precedes ${g.after.tool}@${a}`
            : `${g.before.tool}@${b} does NOT precede ${g.after.tool}@${a}`,
        };
      }
      case "tool_used": {
        const n = ctx.run.toolCalls.filter((c) => callMatches(c, { tool: g.tool, input_match: g.input_match })).length;
        const min = g.min ?? 1;
        const max = g.max ?? Number.POSITIVE_INFINITY;
        return {
          name: g.name,
          passed: n >= min && n <= max,
          weight: g.weight,
          explanation: `${g.tool} called ${n}x (expected ${min}..${max === Number.POSITIVE_INFINITY ? "∞" : max})`,
        };
      }
      case "file_exists": {
        const re = pathGlob(g.path);
        const found = ctx.cwdDiff
          .split("\n")
          .filter((l) => l.trim())
          .some((l) => re.test(l.trim()));
        const passed = found === g.exists;
        return {
          name: g.name,
          passed,
          weight: g.weight,
          explanation: passed
            ? `${g.path} ${g.exists ? "exists" : "absent"} as expected`
            : `${g.path} ${found ? "exists" : "missing"} (expected ${g.exists ? "present" : "absent"})`,
        };
      }
      case "llm":
      case "baseline":
        if (ctx.skipPaidGraders)
          return { name: g.name, passed: false, weight: g.weight, explanation: "skipped: cost ceiling" };
        return await judged(g, ctx);
    }
  } catch (error) {
    return { name: g.name, passed: false, weight: g.weight, explanation: `grader threw: ${(error as Error).message}` };
  }
}

/** A `tool_used: Skill` check with no arm set: it says whether the plugin fired, so it's with-only. */
function skillCheck(g: Grader): boolean {
  return g.type === "tool_used" && g.tool === "Skill" && g.arm === undefined;
}

export async function gradeRun(
  ctx: GradeContext,
): Promise<{ results: GraderResult[]; judgeCostUsd: number; paidGradersSkipped: boolean }> {
  const mockOnly = (g: Grader) =>
    ctx.mockCallsWithOnly &&
    g.arm === undefined &&
    ((g.type === "regex" && g.target === "mock_calls") || (g.type === "llm" && g.focus === "mock_calls"));
  const withOnly = (g: Grader) => g.arm === "with-only" || skillCheck(g) || mockOnly(g);
  const all = ctx.case_.graders;
  const allWithOnly = all.every(withOnly);
  const graders = ctx.arm === "without" && !allWithOnly ? all.filter((g) => !withOnly(g)) : all;
  const paidGradersSkipped = ctx.skipPaidGraders && graders.some((g) => g.type === "llm" || g.type === "baseline");
  const results: GraderResult[] = [];
  let judgeCostUsd = 0;
  for (const g of graders) {
    const r = await one(g, ctx);
    judgeCostUsd += r.costUsd ?? 0;
    delete r.costUsd;
    if (ctx.arm !== undefined && !allWithOnly && withOnly(g)) r.with_only = true;
    r.scored = !r.with_only;
    results.push(r);
  }
  return { results, judgeCostUsd, paidGradersSkipped };
}

/** A run's score: the weighted share of its scored graders that passed. */
export function scoreOf(results: GraderResult[]): number {
  const scored = results.filter((r) => r.scored !== false);
  const total = scored.reduce((n, r) => n + r.weight, 0);
  if (total === 0) return 0;
  return scored.reduce((n, r) => n + (r.passed ? r.weight : 0), 0) / total;
}
