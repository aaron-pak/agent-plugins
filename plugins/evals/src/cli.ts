// `evals`: the evals plugin's runner and helper. `evals run` runs a suite's cases the way `claude
// plugin eval` does, in our own code; the other commands read Claude Code sessions, save traces, cut
// cases from recorded moments, rewrite the instruction files a recorded case loaded, grade recorded turns for free, and
// compare two results.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

import { capture } from "./capture.ts";
import { compare, formatComparison, loadResult } from "./compare.ts";
import { gradeCase } from "./grade.ts";
import { claudeHarness } from "./run/harness/claude.ts";
import { codexHarness } from "./run/harness/codex.ts";
import type { Harness } from "./run/harness/types.ts";
import { renderReport } from "./run/report.ts";
import { type Ablation, runSuite } from "./run/runner.ts";
import { type Edit, recordedFiles, rewriteHistoryFile } from "./instructions.ts";
import { findSession, listSessions, parseSince, projectsDir, searchSessions } from "./sessions.ts";
import { describeTrace, evalsHome, filterTraces, listTraces, saveTrace, updateTrace } from "./traces.ts";
import { clip, mainChain, readTranscript, textOf, turnsOf } from "./transcript.ts";

const HELP = `evals: the evals plugin's runner and helper.

Traces live in $EVALS_HOME (default ~/.claude/evals); sessions are read from $CLAUDE_CONFIG_DIR/projects
(default ~/.claude/projects).

  sessions list [--since 7d] [--project <part>] [--limit n]
  sessions search [--since 7d] [--used <tool|skill|server>] [--user-text <regex>] [--project <part>] [--limit n]
  sessions turns <session>             each turn: the user's message, each response's request id, tools and text

  trace save --session <id|path> [--moment <request id|record uuid|words from the user's reaction>]...
             [--note <text>] [--user] [--good] [--tag <t>]... [--copy]
  trace show <id>
  trace list [--tag t] [--used name] [--source user|inferred] [--good|--bad] [--session id]
  trace update <id> [--set-note text | --add-note text] [--user] [--moment ref]... [--tag t]... [--untag t]... [--good|--bad]

  capture (--trace <id> [--moment n] | --session <id> [--moment ref]) --out <case dir>
          [--kind turn|decision] [--name n] [--tag t]... [--plugin <dir>] [--max-turns n]
  grade <case dir> [--transcript <jsonl>] [--text-file <file>]
                                       regex, tool_used and tool_order graders on what the agent did (default:
                                       the case's original-turn.jsonl); judged graders are listed, not run

  instructions list <history.jsonl>
  instructions rewrite <history.jsonl> (--replace <path> | --remove <path> | --add <path>) [--with <file>]
                       [--type Project|User|Local] [--out <file>]

  run [target] [--harness claude|codex] [--runs n] [--model m (opus)] [--judge-model m (opus)] [--judge-harness claude|codex]
      [--instructions <file>] [--instructions-scope project|user] [--instructions-name AGENTS.md] [--ablation none|with-without] [--case glob]... [--tag t]...
      [--allow-tools t...] [--disallow-tools t...] [--threshold 0..1] [--max-cost-usd usd] [-j n] [--scaffold]
      [--mocks record|off] [--allow-real-servers] [--eval-dir d] [--output-dir d] [--report file] [--json [file]] [--keep-temp]
                                       runs the target's eval cases (<target>/evals/**/case.yaml or prompt.md) the
                                       way \`claude plugin eval\` does, under Claude Code or Codex; --max-cost-usd 0 loads them and runs nothing

  compare <results A> <results B> [--cases <glob>]... [--drop-errors] [--min-effect x] [--json]
                                       B against A: paired per-case score Δ with a 95% interval and a sign test;
                                       --drop-errors leaves out plumbing (timeouts, API errors, aborts), not the turn cap
`;

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(1);
}

function warn(warnings: string[]): void {
  for (const w of warnings) console.error(`warning: ${w}`);
}

function args(argv: string[], options: ParseArgsOptionsConfig) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

function sessionsCommand(sub: string | undefined, rest: string[]): void {
  if (sub === "list") {
    const { values } = args(rest, {
      since: { type: "string" },
      project: { type: "string" },
      limit: { type: "string" },
    });
    const since = values.since ? parseSince(values.since as string) : undefined;
    const limit = Number(values.limit ?? 30);
    const sessions = listSessions().filter(
      (s) =>
        (since === undefined || s.mtimeMs >= since) &&
        (!values.project || s.project.includes(values.project as string)),
    );
    for (const s of sessions.slice(0, limit)) {
      let first = "";
      try {
        const turns = turnsOf(mainChain(readTranscript(s.path)));
        first = `${turns.length} turns · ${clip(textOf(turns[0]?.user ?? { type: "user" }), 90)}`;
      } catch {
        first = "(unreadable)";
      }
      console.log(`${s.id}  ${new Date(s.mtimeMs).toISOString().slice(0, 16)}  ${s.project}\n    ${first}`);
    }
    if (!sessions.length) console.log(`no sessions under ${projectsDir()}`);
    return;
  }
  if (sub === "search") {
    const { values } = args(rest, {
      since: { type: "string" },
      used: { type: "string" },
      "user-text": { type: "string" },
      project: { type: "string" },
      limit: { type: "string" },
    });
    if (!values.used && !values["user-text"]) fail("sessions search needs --used or --user-text");
    const hits = searchSessions({
      since: values.since ? parseSince(values.since as string) : undefined,
      used: values.used as string | undefined,
      userText: values["user-text"] as string | undefined,
      project: values.project as string | undefined,
      limit: Number(values.limit ?? 50),
    });
    for (const h of hits) {
      console.log(`${h.session.id} turn ${h.turn}  ${h.at?.slice(0, 16) ?? ""}  ${h.session.project}`);
      console.log(`    ${h.why.join(" · ")}`);
      console.log(`    user: ${h.user}`);
      if (h.requestId) console.log(`    ${values["user-text"] ? "reacted to" : "first response"}: ${h.requestId}`);
    }
    if (!hits.length) console.log("no matches");
    return;
  }
  if (sub === "turns") {
    const ref = rest[0] ?? fail("sessions turns <session>");
    const session = findSession(ref);
    const turns = turnsOf(mainChain(readTranscript(session.path)));
    console.log(`${session.path}`);
    for (const t of turns) {
      console.log(`\nturn ${t.index}  ${t.user.timestamp?.slice(0, 16) ?? ""}  ${t.user.uuid}`);
      console.log(`  user: ${clip(textOf(t.user), 300)}`);
      t.responses.forEach((r, i) => {
        const tools = r.tools.map((x) => x.name).join(", ");
        console.log(`  ${r.requestId}  ${tools ? `[${tools}] ` : ""}${clip(r.text, 160)}`);
        for (const x of t.interjections.filter((j) => j.after === i + 1))
          console.log(`    ↳ arrived: ${clip(textOf(x.rec), 120)}`);
      });
    }
    return;
  }
  fail("sessions list | search | turns");
}

function traceCommand(sub: string | undefined, rest: string[]): void {
  if (sub === "save") {
    const { values } = args(rest, {
      session: { type: "string" },
      moment: { type: "string", multiple: true },
      note: { type: "string" },
      user: { type: "boolean" },
      good: { type: "boolean" },
      tag: { type: "string", multiple: true },
      copy: { type: "boolean" },
    });
    if (!values.session) fail("trace save needs --session <id or path>");
    if (values.user && !values.note) fail("--user marks a note as the user's own words; pass --note too");
    const result = saveTrace({
      session: values.session as string,
      moments: (values.moment as string[] | undefined) ?? [],
      note: values.note as string | undefined,
      user: Boolean(values.user),
      good: values.good ? true : undefined,
      tags: values.tag as string[] | undefined,
      copy: Boolean(values.copy),
    });
    warn(result.warnings);
    console.log(`${result.appended ? "added to" : "saved"} ${result.trace.id} (${result.path})\n`);
    console.log(describeTrace(result.trace));
    return;
  }
  if (sub === "show") {
    const id = rest[0] ?? fail("trace show <id>");
    console.log(describeTrace(listTraces().find((t) => t.id === id) ?? fail(`no trace ${id} in ${evalsHome()}`)));
    return;
  }
  if (sub === "list") {
    const { values } = args(rest, {
      tag: { type: "string" },
      used: { type: "string" },
      source: { type: "string" },
      good: { type: "boolean" },
      bad: { type: "boolean" },
      session: { type: "string" },
    });
    if (values.source && values.source !== "user" && values.source !== "inferred") fail("--source user|inferred");
    const traces = filterTraces(listTraces(), {
      tag: values.tag as string | undefined,
      used: values.used as string | undefined,
      source: values.source as "user" | "inferred" | undefined,
      verdict: values.good ? "good" : values.bad ? "bad" : undefined,
      session: values.session as string | undefined,
    });
    for (const t of traces) {
      const note = t.notes[t.notes.length - 1];
      console.log(
        `${t.id}  ${t.verdict}  [${t.tags.join(",")}]  ${note ? `${note.source}: ${clip(note.text, 100)}` : "no note"}`,
      );
    }
    if (!traces.length) console.log("no traces");
    return;
  }
  if (sub === "update") {
    const id = rest[0] ?? fail("trace update <id> ...");
    const { values } = args(rest.slice(1), {
      "set-note": { type: "string" },
      "add-note": { type: "string" },
      user: { type: "boolean" },
      moment: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      untag: { type: "string", multiple: true },
      good: { type: "boolean" },
      bad: { type: "boolean" },
    });
    const { trace, warnings } = updateTrace(id, {
      setNote: values["set-note"] as string | undefined,
      addNote: values["add-note"] as string | undefined,
      user: Boolean(values.user),
      moments: values.moment as string[] | undefined,
      addTags: values.tag as string[] | undefined,
      removeTags: values.untag as string[] | undefined,
      good: values.good ? true : values.bad ? false : undefined,
    });
    warn(warnings);
    console.log(describeTrace(trace));
    return;
  }
  fail("trace save | show | list | update");
}

const RUN_OPTIONS: ParseArgsOptionsConfig = {
  runs: { type: "string" },
  model: { type: "string" },
  "judge-model": { type: "string" },
  ablation: { type: "string" },
  threshold: { type: "string" },
  "max-cost-usd": { type: "string" },
  "allow-tools": { type: "string", multiple: true },
  "disallow-tools": { type: "string", multiple: true },
  case: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  "eval-dir": { type: "string" },
  scaffold: { type: "boolean" },
  "no-scaffold": { type: "boolean" },
  "output-dir": { type: "string" },
  report: { type: "string" },
  json: { type: "string" },
  concurrency: { type: "string", short: "j" },
  "keep-temp": { type: "boolean" },
  mocks: { type: "string" },
  "allow-real-servers": { type: "boolean" },
  harness: { type: "string" },
  "judge-harness": { type: "string" },
  instructions: { type: "string" },
  "instructions-scope": { type: "string" },
  "instructions-name": { type: "string" },
};

const HARNESSES: Record<string, Harness> = { claude: claudeHarness, codex: codexHarness };

function harnessOf(name: unknown, flag: string): Harness {
  return HARNESSES[String(name)] ?? fail(`${flag} claude | codex`);
}

function number(value: unknown, flag: string, min: number, max: number, integer = false): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    fail(`${flag} must be ${integer ? "a whole number " : ""}from ${min} to ${max}`);
  return n;
}

async function runCommand(argv: string[]): Promise<void> {
  // `--json` with no path prints to stdout, as `claude plugin eval --json` does.
  const jsonBare = argv.includes("--json") && (argv[argv.indexOf("--json") + 1] ?? "--").startsWith("-");
  const { values, positionals } = args(
    argv.filter((a, i) => !(jsonBare && a === "--json" && i === argv.indexOf("--json"))),
    RUN_OPTIONS,
  );
  const ablation = (values.ablation as string | undefined) ?? "auto";
  if (!["auto", "with-without", "none"].includes(ablation)) fail("--ablation none | with-without");
  const mocks = (values.mocks as string | undefined) ?? "record";
  if (mocks !== "record" && mocks !== "off") fail("--mocks record | off");
  const harness = harnessOf(values.harness ?? "claude", "--harness");
  const judgeHarness = harnessOf(values["judge-harness"] ?? "claude", "--judge-harness");
  const scope = (values["instructions-scope"] as string | undefined) ?? "project";
  if (scope !== "project" && scope !== "user") fail("--instructions-scope project | user");
  // Opus runs and judges unless told otherwise; another harness keeps its own default model.
  const model = (values.model as string | undefined) ?? (harness.name === "claude" ? "opus" : undefined);
  const judgeModel =
    (values["judge-model"] as string | undefined) ?? (judgeHarness.name === "claude" ? "opus" : undefined);
  const log = (line: string) => (jsonBare ? console.error(line) : console.log(line));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const { result, exitCode, outputDir } = await runSuite({
    target: positionals[0] ?? ".",
    evalDir: values["eval-dir"] as string | undefined,
    runs: number(values.runs, "--runs", 1, 50, true),
    model,
    judgeModel,
    ablation: ablation as Ablation,
    threshold: number(values.threshold, "--threshold", 0, 1) ?? 1,
    maxCostUsd: number(values["max-cost-usd"], "--max-cost-usd", 0, Number.MAX_SAFE_INTEGER),
    allowTools: ((values["allow-tools"] as string[] | undefined) ?? []).flatMap((t) => t.split(/\s+/)).filter(Boolean),
    disallowTools: ((values["disallow-tools"] as string[] | undefined) ?? [])
      .flatMap((t) => t.split(/[\s,]+/))
      .filter(Boolean),
    caseGlobs: (values.case as string[] | undefined) ?? [],
    tags: (values.tag as string[] | undefined) ?? [],
    scaffold: Boolean(values.scaffold) && !values["no-scaffold"],
    outputDir: values["output-dir"] as string | undefined,
    concurrency: number(values.concurrency, "--concurrency", 1, 8, true) ?? 1,
    keepTemp: Boolean(values["keep-temp"]),
    mocks: mocks === "record",
    allowRealServers: Boolean(values["allow-real-servers"]),
    harness,
    judgeHarness,
    ...(values.instructions !== undefined && { instructions: values.instructions as string }),
    instructionsScope: scope as "project" | "user",
    ...(values["instructions-name"] !== undefined && { instructionsName: values["instructions-name"] as string }),
    onLine: log,
    signal: controller.signal,
  });
  const reportPath = (values.report as string | undefined) ?? join(outputDir, "report.html");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderReport(result));
  if (jsonBare) console.log(JSON.stringify(result, null, 2));
  else if (values.json) writeFileSync(values.json as string, `${JSON.stringify(result, null, 2)}\n`);
  if (result.partial) log(`⚠ partial: ${result.partialReason}`);
  log(`results: ${join(outputDir, "aggregate-result.json")}\nreport: ${reportPath}`);
  process.exitCode = exitCode;
}

function main(argv: string[]): void | Promise<void> {
  const [command, sub, ...rest] = argv;
  switch (command) {
    case "run":
      return runCommand(argv.slice(1));
    case "sessions":
      return sessionsCommand(sub, rest);
    case "trace":
      return traceCommand(sub, rest);
    case "capture": {
      const { values } = args(argv.slice(1), {
        trace: { type: "string" },
        session: { type: "string" },
        moment: { type: "string" },
        out: { type: "string" },
        kind: { type: "string" },
        name: { type: "string" },
        tag: { type: "string", multiple: true },
        plugin: { type: "string" },
        "max-turns": { type: "string" },
      });
      if (!values.out) fail("capture needs --out <case dir>");
      if (values.kind && values.kind !== "turn" && values.kind !== "decision") fail("--kind turn|decision");
      const result = capture({
        out: values.out as string,
        trace: values.trace as string | undefined,
        session: values.session as string | undefined,
        moment: values.trace ? undefined : (values.moment as string | undefined),
        momentIndex: values.trace && values.moment ? Number(values.moment) : undefined,
        kind: values.kind as "turn" | "decision" | undefined,
        name: values.name as string | undefined,
        tags: values.tag as string[] | undefined,
        plugin: values.plugin as string | undefined,
        maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
      });
      console.log(`wrote ${result.dir}: ${result.files.join(", ")}`);
      warn(result.warnings);
      return;
    }
    case "grade": {
      const { values, positionals } = args(argv.slice(1), {
        transcript: { type: "string" },
        "text-file": { type: "string" },
      });
      const dir = positionals[0] ?? fail("grade <case dir>");
      const verdicts = gradeCase(dir, {
        transcript: values.transcript as string | undefined,
        text: values["text-file"] ? readFileSync(values["text-file"] as string, "utf8") : undefined,
      });
      for (const v of verdicts) {
        const mark = v.passed === undefined ? "  ·  " : v.passed ? "PASS " : "FAIL ";
        console.log(`${mark} ${v.name} (${v.type}): ${v.detail}`);
      }
      return;
    }
    case "instructions": {
      if (sub === "list") {
        const path = rest[0] ?? fail("instructions list <history.jsonl>");
        const files = recordedFiles(readTranscript(path));
        for (const f of files) console.log(`${f.path}  (${f.type ?? "?"}, ${Buffer.byteLength(f.content)} bytes)`);
        if (!files.length) console.log("the history loaded no instruction files");
        return;
      }
      if (sub === "rewrite") {
        const { values, positionals } = args(rest, {
          replace: { type: "string" },
          remove: { type: "string" },
          add: { type: "string" },
          with: { type: "string" },
          type: { type: "string" },
          out: { type: "string" },
        });
        const path = positionals[0] ?? fail("instructions rewrite <history.jsonl> ...");
        const text = values.with ? readFileSync(values.with as string, "utf8") : undefined;
        let edit: Edit;
        if (values.replace)
          edit = {
            kind: "replace",
            path: values.replace as string,
            text: text ?? fail("--replace needs --with <file>"),
          };
        else if (values.remove) edit = { kind: "remove", path: values.remove as string };
        else if (values.add)
          edit = {
            kind: "add",
            path: values.add as string,
            type: values.type as string | undefined,
            text: text ?? fail("--add needs --with <file>"),
          };
        else fail("instructions rewrite needs --replace, --remove or --add");
        const result = rewriteHistoryFile(path, [edit], (values.out as string | undefined) ?? path);
        warn(result.warnings);
        console.log(
          `rewrote ${result.changed} instructions message(s) in ${(values.out as string | undefined) ?? path}`,
        );
        return;
      }
      return fail("instructions list | rewrite");
    }
    case "compare": {
      const { values, positionals } = args(argv.slice(1), {
        cases: { type: "string", multiple: true },
        "drop-errors": { type: "boolean" },
        "min-effect": { type: "string" },
        json: { type: "boolean" },
      });
      const [a, b] = positionals;
      if (!a || !b) fail("compare <results A> <results B>");
      const result = compare(loadResult(a), loadResult(b), {
        cases: (values.cases as string[] | undefined)?.flatMap((c) => c.split(",")),
        dropErrors: Boolean(values["drop-errors"]),
      });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatComparison(result, values["min-effect"] ? Number(values["min-effect"]) : undefined));
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`unknown command ${command}; run evals help`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
