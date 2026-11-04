// Grading what an agent already did, for free: the graders `claude plugin eval` computes without a
// judge (regex, tool_used, tool_order) run against a recorded turn or a given final message. Judged
// graders (llm, baseline) need a model and are listed, not run.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type Rec, blocks, readTranscript, textOf } from "./transcript.ts";

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scalar(raw: string): Value {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitTop(v.slice(1, -1)).map(scalar);
  if (v.startsWith("{") && v.endsWith("}")) {
    const out: Record<string, Value> = {};
    for (const part of splitTop(v.slice(1, -1))) {
      const at = part.indexOf(":");
      out[part.slice(0, at).trim()] = scalar(part.slice(at + 1));
    }
    return out;
  }
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "true" || v === "false") return v === "true";
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/\s+#.*$/, "");
}

/** The frontmatter keys graders use: scalars, flow lists and maps, and one level of nested map. */
export function parseFrontmatter(text: string): { data: Record<string, Value>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, Value> = {};
  let parent: string | undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (nested && parent) {
      const map = (data[parent] ??= {}) as Record<string, Value>;
      map[nested[1]!] = scalar(nested[2]!);
      continue;
    }
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    parent = top[2]!.trim() === "" ? top[1]! : undefined;
    data[top[1]!] = top[2]!.trim() === "" ? {} : scalar(top[2]!);
  }
  return { data, body: m[2]! };
}

export type Grader = { name: string; type: string; config: Record<string, Value>; body: string };

export function loadGraders(caseDir: string): Grader[] {
  const dir = join(caseDir, "graders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => {
      const { data, body } = parseFrontmatter(readFileSync(join(dir, n), "utf8"));
      return { name: n.slice(0, -3), type: String(data.type ?? ""), config: data, body };
    });
}

export type Run = { lastMessage: string; trace: string; calls: { name: string; input: unknown }[] };

export function runFromRecords(records: Rec[]): Run {
  const assistant = records.filter((r) => r.type === "assistant");
  // The final message is the text of the last response that had any.
  const byRequest = new Map<string, string[]>();
  for (const r of assistant) {
    const key = r.requestId ?? r.uuid ?? "";
    const text = textOf(r).trim();
    if (text) byRequest.set(key, [...(byRequest.get(key) ?? []), text]);
  }
  return {
    lastMessage: [...byRequest.values()].pop()?.join("\n") ?? "",
    trace: records
      .filter((r) => r.type === "user" || r.type === "assistant")
      .map((r) => JSON.stringify(r.message))
      .join("\n"),
    calls: assistant.flatMap((r) =>
      blocks(r)
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ name: b.name ?? "", input: b.input })),
    ),
  };
}

export type Verdict = { name: string; type: string; passed?: boolean; detail: string };

function regexOf(pattern: unknown, flags?: unknown): RegExp {
  return new RegExp(String(pattern ?? ""), typeof flags === "string" ? flags.replace("g", "") : "");
}

function callMatches(call: { name: string; input: unknown }, tool: unknown, inputMatch: unknown): boolean {
  if (call.name !== tool) return false;
  return inputMatch === undefined || inputMatch === null || regexOf(inputMatch).test(JSON.stringify(call.input));
}

function spec(value: Value | undefined): { tool: unknown; input_match?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { tool: unknown; input_match?: unknown })
    : { tool: value };
}

export function grade(graders: Grader[], run: Run): Verdict[] {
  return graders.map((g) => {
    const c = g.config;
    switch (g.type) {
      case "regex": {
        const target = c.target ?? "last_message";
        if (target !== "last_message" && target !== "trace") {
          return {
            name: g.name,
            type: g.type,
            detail: `target ${JSON.stringify(target)} needs the run's files; not graded here`,
          };
        }
        const text = target === "trace" ? run.trace : run.lastMessage;
        const re = new RegExp(String(c.pattern ?? g.body.trim()), String(c.flags ?? "").replace("g", "") + "g");
        const count = [...text.matchAll(re)].length;
        const match = String(c.match ?? "contains");
        const passed =
          match === "not_contains"
            ? count === 0
            : match.startsWith("count:")
              ? count === Number(match.slice(6))
              : count > 0;
        const approx = target === "trace" ? " (trace text approximated from the transcript)" : "";
        return { name: g.name, type: g.type, passed, detail: `${count} match(es), ${match}${approx}` };
      }
      case "tool_used": {
        const n = run.calls.filter((call) => callMatches(call, c.tool, c.input_match)).length;
        const min = typeof c.min === "number" ? c.min : 1;
        const max = typeof c.max === "number" ? c.max : Infinity;
        return {
          name: g.name,
          type: g.type,
          passed: n >= min && n <= max,
          detail: `${n} matching call(s) to ${String(c.tool)}`,
        };
      }
      case "tool_order": {
        const before = spec(c.before);
        const after = spec(c.after);
        const b = run.calls.findIndex((call) => callMatches(call, before.tool, before.input_match));
        const a = run.calls.findIndex((call) => callMatches(call, after.tool, after.input_match));
        return {
          name: g.name,
          type: g.type,
          passed: b >= 0 && a >= 0 && b < a,
          detail: `first ${String(before.tool)} at call ${b + 1 || "-"}, first ${String(after.tool)} at call ${a + 1 || "-"}`,
        };
      }
      case "llm":
      case "baseline":
        return {
          name: g.name,
          type: g.type,
          detail: "judged: read the output against the rubric yourself, or pay for a run",
        };
      default:
        return { name: g.name, type: g.type, detail: "needs the run's workspace; not graded here" };
    }
  });
}

export function gradeCase(caseDir: string, options: { transcript?: string; text?: string }): Verdict[] {
  const graders = loadGraders(caseDir);
  if (!graders.length) throw new Error(`${caseDir} has no graders/*.md (graders listed in case.yaml aren't read here)`);
  let run: Run;
  if (options.text !== undefined) run = { lastMessage: options.text, trace: "", calls: [] };
  else run = runFromRecords(readTranscript(options.transcript ?? join(caseDir, "original-turn.jsonl")));
  return grade(graders, run);
}
