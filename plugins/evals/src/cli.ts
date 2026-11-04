// `evals`: the helper the evals plugin's skills call next to `claude plugin eval`. It reads Claude
// Code sessions, saves traces, cuts cases from recorded moments, makes instruction-file variants,
// grades recorded turns for free, and compares two eval results. It never runs a model.

import { readFileSync } from "node:fs";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

import { capture } from "./capture.ts";
import { compare, formatComparison, loadResult } from "./compare.ts";
import { gradeCase } from "./grade.ts";
import { type Edit, recordedFiles, rewriteHistoryFile, writeVariant } from "./instructions.ts";
import { findSession, listSessions, parseSince, projectsDir, searchSessions } from "./sessions.ts";
import { describeTrace, evalsHome, filterTraces, listTraces, saveTrace, updateTrace } from "./traces.ts";
import { clip, mainChain, readTranscript, textOf, turnsOf } from "./transcript.ts";

const HELP = `evals: helper for the evals plugin. Runs go through \`claude plugin eval\`; this never calls a model.

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
  variant --suite <dir> --out <dir> --file <new text> [--replaces <recorded path>] [--path <path>] [--type t]

  compare <results A> <results B> [--cases <glob>]... [--drop-errors] [--min-effect x] [--json]
                                       B against A: paired per-case score Δ with a 95% interval and a sign test
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

function main(argv: string[]): void {
  const [command, sub, ...rest] = argv;
  switch (command) {
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
    case "variant": {
      const { values } = args(argv.slice(1), {
        suite: { type: "string" },
        out: { type: "string" },
        file: { type: "string" },
        replaces: { type: "string" },
        path: { type: "string" },
        type: { type: "string" },
      });
      if (!values.suite || !values.out || !values.file) fail("variant needs --suite, --out and --file");
      const result = writeVariant({
        suite: values.suite as string,
        out: values.out as string,
        file: values.file as string,
        replaces: values.replaces as string | undefined,
        path: values.path as string | undefined,
        type: values.type as string | undefined,
      });
      warn(result.warnings);
      console.log(
        `wrote ${values.out}: ${result.recorded.length} recorded case(s) rewritten, ${result.fresh.length} fresh case(s) given the variant plugin`,
      );
      return;
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
  main(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
