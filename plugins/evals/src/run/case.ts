// Cases: finding them under a suite's eval folder and loading each one the way `claude plugin eval`
// does. A case is a folder with `case.yaml`, `prompt.md`, or both, plus `graders/*.md`. `prompt.md`'s
// frontmatter sets the same fields `case.yaml` does (run fields flat instead of under `execution:`),
// its body is the prompt, and it wins where both set a field. Unknown keys are errors.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

export const SCHEMA_MAJOR = 1;
export const SCHEMA_VERSION = "1.1";
const BLANK_PROMPT = "TODO: write the user prompt to test";
const BLANK_CRITERIA = "TODO: replace with concrete pass criteria";

export class CaseError extends Error {}

export type Focus = "last_message" | "trace" | "files" | "mock_calls" | { source: "file"; path: string };
export type ToolRef = { tool: string; input_match?: string };
export type ArmRule = "with-only" | "both";

type Common = { name: string; weight: number; arm?: ArmRule };
export type Grader = Common &
  (
    | { type: "regex"; pattern: string; flags: string; target: Focus; match: string }
    | { type: "tool_order"; before: ToolRef; after: ToolRef }
    | { type: "tool_used"; tool: string; input_match?: string; min?: number; max?: number }
    | { type: "file_exists"; path: string; exists: boolean }
    | { type: "llm"; criteria: string; focus: Focus }
    | { type: "baseline"; baseline_file: string; criteria: string }
  );

export type Execution = {
  prompt: string;
  max_turns: number;
  timeout_seconds: number;
  model?: string;
  allowed_tools: string[];
  disallowed_tools?: string[];
  append_system_prompt?: string;
  env: Record<string, string>;
};

export type Context = {
  scaffold_script?: string;
  history_file?: string;
  add_dirs: string[];
};

export type Case = {
  schema_version: string;
  name: string;
  description?: string;
  tags: string[];
  plugins?: string[];
  context: Context;
  execution: Execution;
  runs: number;
  graders: Grader[];
  expected_outcome?: string;
  /** The case folder, absolute. */
  dir: string;
  /** Where the case was written: case.yaml only, prompt.md (prose) only, or both. */
  source: "case_yaml" | "prose" | "mixed";
  /** Each grader's .md text, by grader name, for the report. */
  graderMarkdown: Record<string, string>;
  /** Notes to print when the case loads. */
  notes: string[];
};

const TOP_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome"]);
const RUN_KEYS = new Set([
  "model",
  "max_turns",
  "timeout_seconds",
  "allowed_tools",
  "disallowed_tools",
  "artifact_publish",
  "growthbook_overrides",
  "append_system_prompt",
  "env",
]);
// Claude Code reads these two in its own runner; here they mean nothing, so they load with a note.
const IGNORED_RUN_KEYS = new Set(["artifact_publish", "growthbook_overrides"]);
const SKIP_DIRS = new Set(["node_modules", ".claude", "results", "mocks", "graders", ".git"]);
const BODY_KEY: Record<string, string> = { llm: "criteria", baseline: "criteria", regex: "pattern" };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Splits `---` frontmatter (YAML) from a Markdown body. */
export function splitFrontmatter(text: string, file: string): { fm: Obj; body: string; had: boolean } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text, had: false };
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!) ?? {};
  } catch (error) {
    throw new CaseError(`${file}: frontmatter is not valid YAML (${(error as Error).message})`);
  }
  if (!isObj(fm)) throw new CaseError(`${file}: frontmatter must be a YAML map`);
  return { fm, body: m[2]!, had: true };
}

class Check {
  issues: string[] = [];
  constructor(readonly where: string) {}
  add(path: string, message: string): void {
    this.issues.push(`  ${path || "(root)"}: ${message}`);
  }
  str(o: Obj, key: string, path: string, required = false): string | undefined {
    const v = o[key];
    if (v === undefined) {
      if (required) this.add(path + key, "required");
      return undefined;
    }
    if (typeof v !== "string") {
      this.add(path + key, "expected a string");
      return undefined;
    }
    return v;
  }
  strs(o: Obj, key: string, path: string): string[] | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      this.add(path + key, "expected a list of strings");
      return undefined;
    }
    return v as string[];
  }
  int(o: Obj, key: string, path: string, min: number, max: number): number | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      this.add(path + key, `expected a whole number from ${min} to ${max}`);
      return undefined;
    }
    return v;
  }
  num(o: Obj, key: string, path: string): number | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !(v > 0)) {
      this.add(path + key, "expected a positive number");
      return undefined;
    }
    return v;
  }
  only(o: Obj, keys: string[], path: string): void {
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.add(path + k, "unknown key");
  }
  fail(): never {
    throw new CaseError(`${this.where}:\n${this.issues.join("\n")}`);
  }
}

function focusOf(c: Check, v: unknown, path: string): Focus {
  if (v === undefined) return "last_message";
  if (v === "last_message" || v === "trace" || v === "files" || v === "mock_calls") return v;
  if (isObj(v) && v.source === "file" && typeof v.path === "string" && Object.keys(v).length === 2) {
    return { source: "file", path: v.path };
  }
  c.add(path, 'expected last_message, trace, files, mock_calls or {source: file, path: "…"}');
  return "last_message";
}

function toolRef(c: Check, v: unknown, path: string): ToolRef {
  if (typeof v === "string") return { tool: v };
  if (isObj(v) && typeof v.tool === "string") {
    c.only(v, ["tool", "input_match"], `${path}.`);
    if (v.input_match !== undefined && typeof v.input_match !== "string")
      c.add(`${path}.input_match`, "expected a string");
    return { tool: v.tool, input_match: v.input_match as string | undefined };
  }
  c.add(path, "expected a tool name or {tool, input_match}");
  return { tool: "" };
}

function graderOf(c: Check, g: unknown, path: string): Grader | undefined {
  if (!isObj(g)) {
    c.add(path, "expected a map");
    return undefined;
  }
  const name = c.str(g, "name", `${path}.`, true) ?? "";
  const weight = c.num(g, "weight", `${path}.`) ?? 1;
  const armRaw = g.arm;
  if (armRaw !== undefined && armRaw !== "with-only" && armRaw !== "both")
    c.add(`${path}.arm`, "expected with-only or both");
  const arm = armRaw as ArmRule | undefined;
  const base = { name, weight, ...(arm && { arm }) };
  const common = ["type", "name", "weight", "arm"];
  const p = `${path}.`;
  switch (g.type) {
    case "regex": {
      c.only(g, [...common, "pattern", "flags", "target", "match"], p);
      const pattern = c.str(g, "pattern", p, true) ?? "";
      const flags = c.str(g, "flags", p) ?? "";
      if (!/^[dgimsuvy]*$/.test(flags)) c.add(`${p}flags`, "only the flags d, g, i, m, s, u, v and y");
      const match = c.str(g, "match", p) ?? "contains";
      if (!/^(contains|not_contains|count:\d+)$/.test(match))
        c.add(`${p}match`, "expected contains, not_contains or count:N");
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        c.add(`${p}pattern`, `invalid regular expression (${(error as Error).message})`);
      }
      return { ...base, type: "regex", pattern, flags, target: focusOf(c, g.target, `${p}target`), match };
    }
    case "tool_order":
      c.only(g, [...common, "before", "after"], p);
      return {
        ...base,
        type: "tool_order",
        before: toolRef(c, g.before, `${p}before`),
        after: toolRef(c, g.after, `${p}after`),
      };
    case "tool_used": {
      c.only(g, [...common, "tool", "input_match", "min", "max"], p);
      const out: Grader = { ...base, type: "tool_used", tool: c.str(g, "tool", p, true) ?? "" };
      const im = c.str(g, "input_match", p);
      const min = c.int(g, "min", p, 0, Number.MAX_SAFE_INTEGER);
      const max = c.int(g, "max", p, 0, Number.MAX_SAFE_INTEGER);
      return {
        ...out,
        ...(im !== undefined && { input_match: im }),
        ...(min !== undefined && { min }),
        ...(max !== undefined && { max }),
      };
    }
    case "file_exists": {
      c.only(g, [...common, "path", "exists"], p);
      if (g.exists !== undefined && typeof g.exists !== "boolean") c.add(`${p}exists`, "expected true or false");
      return { ...base, type: "file_exists", path: c.str(g, "path", p, true) ?? "", exists: g.exists !== false };
    }
    case "llm":
      c.only(g, [...common, "criteria", "focus"], p);
      return {
        ...base,
        type: "llm",
        criteria: c.str(g, "criteria", p, true) ?? "",
        focus: focusOf(c, g.focus, `${p}focus`),
      };
    case "baseline":
      c.only(g, [...common, "baseline_file", "criteria"], p);
      return {
        ...base,
        type: "baseline",
        baseline_file: c.str(g, "baseline_file", p, true) ?? "",
        criteria: c.str(g, "criteria", p, true) ?? "",
      };
    default:
      c.add(`${p}type`, "expected regex, tool_order, tool_used, file_exists, llm or baseline");
      return undefined;
  }
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Loads one case folder, or returns undefined when it holds no case. */
export function loadCase(dir: string, evalRoot: string): Case | undefined {
  const abs = resolve(dir);
  const shown = relative(evalRoot, abs) || ".";
  const yamlText = readText(join(abs, "case.yaml"));
  const promptText = readText(join(abs, "prompt.md"));
  const graderFiles = existsSync(join(abs, "graders"))
    ? readdirSync(join(abs, "graders"))
        .filter((n) => n.endsWith(".md"))
        .sort()
    : [];
  if (yamlText === undefined && promptText === undefined && graderFiles.length === 0) return undefined;

  let fromYaml: Obj | undefined;
  if (yamlText !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlText);
    } catch (error) {
      throw new CaseError(`${shown}/case.yaml: YAML parse failed (${(error as Error).message})`);
    }
    if (parsed !== null && parsed !== undefined) {
      if (!isObj(parsed)) throw new CaseError(`${shown}/case.yaml: must be a YAML map`);
      fromYaml = parsed;
    }
  }

  const prose: { top: Obj; execution: Obj; prompt?: string; graders: Obj[]; markdown: Record<string, string> } = {
    top: {},
    execution: {},
    graders: [],
    markdown: {},
  };
  if (promptText !== undefined) {
    const { fm, body } = splitFrontmatter(promptText, `${shown}/prompt.md`);
    if (body.trim()) prose.prompt = body.trim();
    for (const [k, v] of Object.entries(fm)) {
      if (TOP_KEYS.has(k)) prose.top[k] = v;
      else if (RUN_KEYS.has(k)) prose.execution[k] = v;
      else {
        throw new CaseError(
          `${shown}/prompt.md: unknown frontmatter key "${k}" (expected one of: ${[...TOP_KEYS, ...RUN_KEYS].join(", ")})`,
        );
      }
    }
  }
  for (const file of graderFiles) {
    const text = readFileSync(join(abs, "graders", file), "utf8");
    const { fm, body, had } = splitFrontmatter(text, `${shown}/graders/${file}`);
    if (!had) continue;
    if (typeof fm.type !== "string") {
      throw new CaseError(
        `${shown}/graders/${file}: frontmatter must include "type:" (regex | tool_order | tool_used | file_exists | llm | baseline)`,
      );
    }
    const name = basename(file, ".md");
    const g: Obj = { name, ...fm };
    const key = BODY_KEY[fm.type];
    if (key && g[key] === undefined && body.trim()) g[key] = body.trim();
    prose.graders.push(g);
    prose.markdown[name] = text;
  }

  const hasProse = promptText !== undefined || prose.graders.length > 0;
  const base: Obj = fromYaml ?? { schema_version: SCHEMA_VERSION, name: basename(abs) };
  const merged: Obj = { ...base, ...prose.top };
  const baseExec = isObj(base.execution) ? base.execution : {};
  const dis = [baseExec.disallowed_tools, prose.execution.disallowed_tools].filter((x) => x !== undefined);
  merged.execution = {
    ...baseExec,
    ...prose.execution,
    ...(dis.length > 0 && { disallowed_tools: dis.every(Array.isArray) ? dis.flat() : dis.at(-1) }),
    ...(prose.prompt !== undefined && { prompt: prose.prompt }),
  };
  if (prose.graders.length > 0)
    merged.graders = [...(Array.isArray(base.graders) ? base.graders : []), ...prose.graders];

  const c = new Check(`invalid case ${shown}`);
  const sv = merged.schema_version;
  if (typeof sv !== "string")
    throw new CaseError(`${shown}: missing required field schema_version (e.g. "${SCHEMA_VERSION}")`);
  const major = Number.parseInt(sv.split(".")[0]!, 10);
  if (Number.isNaN(major)) throw new CaseError(`${shown}: schema_version "${sv}" is not a valid version string`);
  if (major > SCHEMA_MAJOR)
    throw new CaseError(`${shown}: schema_version "${sv}" is newer than this runner reads (${SCHEMA_MAJOR}.x)`);

  c.only(merged, [...TOP_KEYS, "context", "execution", "graders"], "");
  const name = c.str(merged, "name", "", true) ?? basename(abs);
  if (!name) c.add("name", "must not be empty");
  const description = c.str(merged, "description", "");
  const tags = c.strs(merged, "tags", "") ?? [];
  const plugins = c.strs(merged, "plugins", "");
  const runs = c.int(merged, "runs", "", 1, 50) ?? 3;
  const expected_outcome = c.str(merged, "expected_outcome", "");

  const ctxRaw = merged.context ?? {};
  const context: Context = { add_dirs: [] };
  if (!isObj(ctxRaw)) c.add("context", "expected a map");
  else {
    c.only(ctxRaw, ["scaffold_script", "history_file", "add_dirs"], "context.");
    context.scaffold_script = c.str(ctxRaw, "scaffold_script", "context.");
    context.history_file = c.str(ctxRaw, "history_file", "context.");
    context.add_dirs = c.strs(ctxRaw, "add_dirs", "context.") ?? [];
  }

  const notes: string[] = [];
  const ex = merged.execution as Obj;
  c.only(ex, ["prompt", ...RUN_KEYS], "execution.");
  for (const k of IGNORED_RUN_KEYS)
    if (ex[k] !== undefined) notes.push(`case "${name}": execution.${k} is Claude Code's own and is ignored here`);
  const env: Record<string, string> = {};
  if (ex.env !== undefined) {
    if (!isObj(ex.env)) c.add("execution.env", "expected a map of strings");
    else {
      for (const [k, v] of Object.entries(ex.env)) {
        if (!/^EVAL_[A-Z0-9_]*$/.test(k)) c.add(`execution.env.${k}`, "case env keys must match EVAL_[A-Z0-9_]*");
        else if (typeof v !== "string") c.add(`execution.env.${k}`, "expected a string");
        else env[k] = v;
      }
    }
  }
  const execution: Execution = {
    prompt: c.str(ex, "prompt", "execution.") ?? "",
    max_turns: c.int(ex, "max_turns", "execution.", 1, 200) ?? 10,
    timeout_seconds: c.int(ex, "timeout_seconds", "execution.", 1, 3600) ?? 300,
    model: c.str(ex, "model", "execution."),
    allowed_tools: c.strs(ex, "allowed_tools", "execution.") ?? [],
    disallowed_tools: c.strs(ex, "disallowed_tools", "execution."),
    append_system_prompt: c.str(ex, "append_system_prompt", "execution."),
    env,
  };

  const graders: Grader[] = [];
  if (!Array.isArray(merged.graders) || merged.graders.length === 0)
    c.add("graders", "at least one grader is required");
  else {
    const seen = new Set<string>();
    merged.graders.forEach((g, i) => {
      const parsed = graderOf(c, g, `graders.${i}`);
      if (!parsed) return;
      if (seen.has(parsed.name)) c.add("graders", `duplicate grader name "${parsed.name}"`);
      seen.add(parsed.name);
      graders.push(parsed);
    });
  }
  if (c.issues.length) c.fail();

  if (!execution.prompt.trim()) {
    throw new CaseError(
      context.history_file
        ? `${shown}: context.history_file requires execution.prompt (the resumed session needs a next turn)`
        : `${shown}: execution.prompt is required (a prompt.md body, or execution.prompt in case.yaml)`,
    );
  }
  if (execution.prompt.includes(BLANK_PROMPT)) throw new CaseError(`${shown}: the prompt is still the blank template`);
  for (const g of graders) {
    const text = "criteria" in g ? g.criteria : "pattern" in g ? g.pattern : "";
    if (text.includes(BLANK_CRITERIA)) throw new CaseError(`${shown}: grader "${g.name}" is still the blank template`);
  }
  for (const [label, p] of [
    ["context.history_file", context.history_file],
    ["context.scaffold_script", context.scaffold_script],
    ...context.add_dirs.map((d) => ["context.add_dirs", d] as const),
  ] as const) {
    if (p !== undefined && !existsSync(resolve(abs, p))) throw new CaseError(`${shown}: ${label} ${p} does not exist`);
  }
  for (const g of graders) {
    if (g.type === "baseline" && !existsSync(resolve(abs, g.baseline_file))) {
      throw new CaseError(`${shown}: grader "${g.name}" baseline_file ${g.baseline_file} does not exist`);
    }
  }

  return {
    schema_version: sv,
    name,
    ...(description !== undefined && { description }),
    tags,
    ...(plugins !== undefined && { plugins }),
    context,
    execution,
    runs,
    graders,
    ...(expected_outcome !== undefined && { expected_outcome }),
    dir: abs,
    source: fromYaml && hasProse ? "mixed" : fromYaml ? "case_yaml" : "prose",
    graderMarkdown: prose.markdown,
    notes,
  };
}

/** Every case folder under the eval folder: a folder with case.yaml or prompt.md stops the walk. */
export function findCaseDirs(evalDir: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(evalDir) || !statSync(evalDir).isDirectory()) return [];
  const here = readdirSync(evalDir);
  if (here.includes("case.yaml") || here.includes("prompt.md")) return [evalDir];
  return here
    .filter((n) => !n.startsWith(".") && !SKIP_DIRS.has(n))
    .map((n) => join(evalDir, n))
    .filter((p) => statSync(p).isDirectory())
    .sort()
    .flatMap((p) => findCaseDirs(p, depth + 1));
}

/** A glob with `*` and `?`, matched against the whole string. */
export function globMatch(glob: string, text: string): boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(text);
}

/** The file_exists glob: `**` crosses folders, `*` and `?` don't. */
export function pathGlob(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i++;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += ".";
    else if (".+^${}()|[]\\".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`${out}$`);
}

/** Resolves a path a case names, relative to the case folder. */
export function inCase(c: Case, p: string): string {
  return isAbsolute(p) ? p : resolve(c.dir, p);
}
