// Cutting a recorded session into a case `claude plugin eval` can run: the conversation before the
// moment's turn as `context.history_file`, the person's message as the prompt, and everything after
// the cut (the recorded reply, the person's reaction, the trace's notes) set aside as grading evidence.
//
// `claude plugin eval` resumes a history file with `--resume` and sends the prompt as the next user
// turn, so a case can only start at a person's message. A response in the middle of a turn can't be
// replayed on its own; the turn that contains it can.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { type Moment, findSession, resolveMoment } from "./sessions.ts";
import { type Trace, loadTrace } from "./traces.ts";
import { type Rec, type Turn, blocks, chainTo, instructionsIn, readTranscript, textOf, turnsOf } from "./transcript.ts";

/** Recorded content must not land where git would commit it. Returns why not, or undefined. */
export function unsafeLocation(dir: string): string | undefined {
  const abs = resolve(dir);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  let top: string;
  try {
    top = execFileSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined; // not inside a repository
  }
  try {
    execFileSync("git", ["-C", top, "check-ignore", "-q", "--no-index", abs], { stdio: "ignore" });
    return undefined;
  } catch {
    return `${abs} is inside the repository ${top} and git doesn't ignore it; recorded sessions hold real content, so capture writes only outside a repository or to an ignored path`;
  }
}

export type CaptureOptions = {
  out: string;
  trace?: string;
  session?: string;
  moment?: string;
  /** Which of the trace's moments, from 1. */
  momentIndex?: number;
  /** `turn`: the whole turn reruns. `decision`: one response, with max_turns 1. */
  kind?: "turn" | "decision";
  name?: string;
  tags?: string[];
  /** The plugin under test, written into the case as `plugins:` relative to the case. */
  plugin?: string;
  maxTurns?: number;
};

export type CaptureResult = { dir: string; warnings: string[]; files: string[] };

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function promptText(user: Rec, warnings: string[]): string {
  const parts = blocks(user);
  if (parts.some((b) => b.type === "image"))
    warnings.push(
      "the message had images, which a case prompt can't carry; describe them in the prompt or attach them as fixtures",
    );
  if (parts.some((b) => b.type === "document"))
    warnings.push("the message had a document attached, which a case prompt can't carry");
  return textOf(user).trim();
}

function evidence(
  trace: Trace | undefined,
  moment: Moment,
  turn: Turn,
  reaction: Rec | undefined,
  kind: string,
): string {
  const lines = [
    "# Grading evidence",
    "",
    "Everything here happened after the cut. It never reaches the agent under test; write the graders from it.",
    "",
  ];
  if (trace) {
    lines.push(`Trace ${trace.id}, marked ${trace.verdict}. Tags: ${trace.tags.join(", ") || "none"}.`, "");
    for (const n of trace.notes)
      lines.push(`- Note (${n.source === "user" ? "the user's words" : "inferred by an agent"}): ${n.text}`);
    if (trace.notes.length) lines.push("");
  }
  lines.push(`Moment: response ${moment.requestId}, ${moment.timestamp ?? ""}. Case kind: ${kind}.`, "");
  lines.push("## What the user sent", "", "```text", textOf(turn.user).trim(), "```", "");
  lines.push("## What the agent did in that turn", "");
  turn.responses.forEach((r, i) => {
    const mark = r.requestId === moment.requestId ? " ← the moment" : "";
    lines.push(`### Response ${i + 1} (${r.requestId})${mark}`, "");
    if (r.text) lines.push(r.text, "");
    for (const call of r.tools)
      lines.push(`- called \`${call.name}\` with \`${JSON.stringify(call.input).slice(0, 400)}\``);
    if (r.tools.length) lines.push("");
    const after = turn.interjections.filter((x) => x.after === i + 1);
    for (const x of after) lines.push(`> arrived here: ${textOf(x.rec).slice(0, 300)}`, "");
  });
  if (reaction) lines.push("## The user's reaction", "", "```text", textOf(reaction).trim(), "```", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function capture(options: CaptureOptions): CaptureResult {
  const warnings: string[] = [];
  let trace: Trace | undefined;
  let transcriptPath: string;
  let moment: Moment;
  let records: Rec[];
  if (options.trace) {
    trace = loadTrace(options.trace);
    transcriptPath = trace.transcriptPath;
    records = readTranscript(transcriptPath);
    const index = (options.momentIndex ?? 1) - 1;
    const picked = trace.moments[index];
    if (!picked) throw new Error(`trace ${trace.id} has ${trace.moments.length} moment(s), not ${index + 1}`);
    moment = picked;
  } else {
    if (!options.session) throw new Error("capture needs --trace <id> or --session <id>");
    transcriptPath = findSession(options.session).path;
    records = readTranscript(transcriptPath);
    const resolved = resolveMoment(records, options.moment);
    warnings.push(...resolved.warnings);
    moment = resolved.moment;
  }

  const dir = resolve(options.out);
  const unsafe = unsafeLocation(dir);
  if (unsafe) throw new Error(unsafe);
  if (existsSync(join(dir, "case.yaml")) || existsSync(join(dir, "prompt.md")))
    throw new Error(`${dir} already holds a case`);

  // The conversation exactly as a resumed session sees it: the chain up to the person's message,
  // stopping at a compaction the way --resume does.
  const toUser = chainTo(records, moment.turnUuid, false);
  const user = toUser[toUser.length - 1];
  if (!user || user.uuid !== moment.turnUuid) throw new Error("the moment's turn isn't in the transcript any more");
  const history = toUser.slice(0, -1);
  const fullChain = chainTo(records, moment.replyUuid, true);
  const turn = turnsOf(fullChain).find((t) => t.user.uuid === moment.turnUuid);
  if (!turn) throw new Error("couldn't rebuild the moment's turn");

  const kind = options.kind ?? "turn";
  const position = turn.responses.findIndex((r) => r.requestId === moment.requestId);
  if (kind === "decision" && position > 0) {
    throw new Error(
      `the moment is response ${position + 1} of its turn, and a case can only start at the user's message; capture it as a turn (--kind turn) and grade what the turn does, or pick the turn's first response`,
    );
  }
  if (history.length === 0)
    warnings.push("the moment's turn is the first of its session, so the case has no history to resume");
  if (history.some((r) => r.type === "system" && r.subtype === "compact_boundary") || toUser[0]?.type === "system") {
    warnings.push(
      "the session was compacted before the moment; the history starts at the compaction summary, as a resumed session would",
    );
  }
  const recorded = instructionsIn(history);
  if (recorded.length === 0) warnings.push("no CLAUDE.md or AGENTS.md was loaded in the recorded history");

  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    files.push(name);
  };

  const name = options.name ?? basename(dir);
  const maxTurns =
    options.maxTurns ?? (kind === "decision" ? 1 : Math.min(200, Math.max(10, turn.responses.length * 2 + 5)));
  const tags = [...new Set([...(trace?.tags ?? []), ...(options.tags ?? []), "captured", kind])];
  write("history.jsonl", history.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // The recorded turn itself, for grading what the agent really did (`evals grade`).
  write("original-turn.jsonl", [user, ...turn.records].map((r) => JSON.stringify(r)).join("\n") + "\n");
  write(
    "original.md",
    evidence(
      trace,
      moment,
      turn,
      moment.reactionUuid ? records.find((r) => r.uuid === moment.reactionUuid) : undefined,
      kind,
    ),
  );

  const yaml = [
    `schema_version: "1.1"`,
    `name: ${yamlString(name)}`,
    `description: ${yamlString(`Captured from session ${trace?.sessionId ?? basename(transcriptPath, ".jsonl")} at ${moment.requestId}${trace ? ` (trace ${trace.id})` : ""}`)}`,
    `tags: [${tags.map(yamlString).join(", ")}]`,
  ];
  if (options.plugin) {
    const rel = relative(dir, resolve(options.plugin)) || ".";
    yaml.push(`plugins: [${yamlString(rel)}]`);
  }
  yaml.push("context:", "  history_file: history.jsonl", "execution:", `  max_turns: ${maxTurns}`);
  write("case.yaml", `${yaml.join("\n")}\n`);
  // A prompt that itself starts with "---" would be read as frontmatter, so give it an empty one.
  const prompt = promptText(user, warnings);
  write("prompt.md", `${prompt.startsWith("---") ? "---\n---\n" : ""}${prompt}\n`);

  const toolsUsed = [...new Set(turn.responses.flatMap((r) => r.tools.map((t) => t.name)))];
  if (toolsUsed.length) {
    warnings.push(
      `the recorded turn called ${toolsUsed.join(", ")}; grant what the case needs (allowed_tools in case.yaml, --allow-tools for the rest) and mock any MCP server`,
    );
  }
  warnings.push("the case has no graders yet; write them from original.md before running it");
  return { dir, warnings, files };
}
