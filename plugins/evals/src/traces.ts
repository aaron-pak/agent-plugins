// Saved traces: bookmarks of moments in sessions, with a note on what happened. They live outside any
// repository, in EVALS_HOME (default ~/.claude/evals), because they point at real conversations.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Moment, type Resolved, findSession, resolveMoment } from "./sessions.ts";
import { type Rec, chainTo, clip, instructionsIn, readTranscript, textOf, usedIn } from "./transcript.ts";

export function evalsHome(): string {
  return process.env.EVALS_HOME || join(homedir(), ".claude", "evals");
}

export function tracesDir(): string {
  return join(evalsHome(), "traces");
}

export type Note = { text: string; source: "user" | "inferred"; at: string };

export type Environment = {
  claudeVersion?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  gitBranch?: string;
  /** Read when the trace was saved, which for a past session may be later than the moment. */
  git?: { commit?: string; dirty?: boolean; diffSha256?: string; readAt: string };
  instructions: { path: string; type?: string; sha256: string; bytes: number }[];
};

export type Trace = {
  id: string;
  created: string;
  sessionId: string;
  transcriptPath: string;
  copied: boolean;
  verdict: "bad" | "good";
  tags: string[];
  used: string[];
  notes: Note[];
  moments: Moment[];
  environment: Environment;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function environmentAt(records: Rec[], resolved: Resolved): Environment {
  const chain = chainTo(records, resolved.moment.replyUuid, true);
  const reply = chain.filter((r) => r.type === "assistant").pop();
  const env: Environment = {
    claudeVersion: reply?.version,
    model: reply?.message?.model,
    effort: reply?.effort,
    cwd: reply?.cwd,
    gitBranch: reply?.gitBranch,
    instructions: instructionsIn(chain).map((f) => ({
      path: f.path,
      type: f.type,
      sha256: sha256(f.content),
      bytes: Buffer.byteLength(f.content),
    })),
  };
  if (env.cwd && existsSync(env.cwd)) {
    const commit = git(env.cwd, ["rev-parse", "HEAD"])?.trim();
    if (commit) {
      const diff = git(env.cwd, ["diff", "HEAD"]) ?? "";
      env.git = {
        commit,
        dirty: diff.length > 0,
        diffSha256: diff ? sha256(diff) : undefined,
        readAt: new Date().toISOString(),
      };
    }
  }
  return env;
}

export function newId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `t${day}-${randomBytes(3).toString("hex")}`;
}

export function loadTrace(id: string): Trace {
  const path = join(tracesDir(), `${id}.json`);
  if (!existsSync(path)) throw new Error(`no trace ${id} in ${tracesDir()}`);
  return JSON.parse(readFileSync(path, "utf8")) as Trace;
}

export function writeTrace(trace: Trace): string {
  mkdirSync(tracesDir(), { recursive: true });
  const path = join(tracesDir(), `${trace.id}.json`);
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`);
  return path;
}

export function listTraces(): Trace[] {
  if (!existsSync(tracesDir())) return [];
  return readdirSync(tracesDir())
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(tracesDir(), n), "utf8")) as Trace)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export type SaveOptions = {
  session: string;
  moments: (string | undefined)[];
  note?: string;
  user?: boolean;
  good?: boolean;
  tags?: string[];
  copy?: boolean;
};

export type SaveResult = { trace: Trace; path: string; appended: boolean; warnings: string[] };

export function saveTrace(options: SaveOptions): SaveResult {
  const session = findSession(options.session);
  const records = readTranscript(session.path);
  const refs = options.moments.length ? options.moments : [undefined];
  const resolved = refs.map((ref) => resolveMoment(records, ref));
  const warnings = resolved.flatMap((r) => r.warnings);
  const now = new Date().toISOString();
  const note: Note | undefined = options.note
    ? { text: options.note, source: options.user ? "user" : "inferred", at: now }
    : undefined;

  // Saving the same moments again adds a note (a correction, the user's own words) to that trace.
  const requestIds = resolved
    .map((r) => r.moment.requestId)
    .sort()
    .join(",");
  const existing = listTraces().find(
    (t) =>
      t.sessionId === session.id &&
      t.moments
        .map((m) => m.requestId)
        .sort()
        .join(",") === requestIds,
  );
  if (existing) {
    if (note) existing.notes.push(note);
    for (const tag of options.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    if (options.good !== undefined) existing.verdict = options.good ? "good" : "bad";
    return { trace: existing, path: writeTrace(existing), appended: true, warnings };
  }

  const id = newId();
  let transcriptPath = session.path;
  if (options.copy) {
    const dir = join(tracesDir(), id);
    mkdirSync(dir, { recursive: true });
    transcriptPath = join(dir, "session.jsonl");
    copyFileSync(session.path, transcriptPath);
  }
  const trace: Trace = {
    id,
    created: now,
    sessionId: session.id,
    transcriptPath,
    copied: Boolean(options.copy),
    verdict: options.good ? "good" : "bad",
    tags: options.tags ?? [],
    used: [...new Set(resolved.flatMap((r) => usedIn(r.turn)))],
    notes: note ? [note] : [],
    moments: resolved.map((r) => r.moment),
    environment: environmentAt(records, resolved[0]!),
  };
  return { trace, path: writeTrace(trace), appended: false, warnings };
}

export type UpdateOptions = {
  setNote?: string;
  addNote?: string;
  user?: boolean;
  moments?: string[];
  addTags?: string[];
  removeTags?: string[];
  good?: boolean;
};

export function updateTrace(id: string, options: UpdateOptions): { trace: Trace; warnings: string[] } {
  const trace = loadTrace(id);
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const source = options.user ? "user" : "inferred";
  if (options.setNote !== undefined) trace.notes = [{ text: options.setNote, source, at: now }];
  if (options.addNote !== undefined) trace.notes.push({ text: options.addNote, source, at: now });
  if (options.moments?.length) {
    const records = readTranscript(trace.transcriptPath);
    const resolved = options.moments.map((m) => resolveMoment(records, m));
    warnings.push(...resolved.flatMap((r) => r.warnings));
    trace.moments = resolved.map((r) => r.moment);
    trace.used = [...new Set(resolved.flatMap((r) => usedIn(r.turn)))];
  }
  for (const tag of options.addTags ?? []) if (!trace.tags.includes(tag)) trace.tags.push(tag);
  if (options.removeTags) trace.tags = trace.tags.filter((t) => !options.removeTags!.includes(t));
  if (options.good !== undefined) trace.verdict = options.good ? "good" : "bad";
  writeTrace(trace);
  return { trace, warnings };
}

export type ListFilter = {
  tag?: string;
  used?: string;
  source?: "user" | "inferred";
  verdict?: "good" | "bad";
  session?: string;
};

export function filterTraces(traces: Trace[], filter: ListFilter): Trace[] {
  return traces.filter((t) => {
    if (filter.tag && !t.tags.includes(filter.tag)) return false;
    if (filter.used && !t.used.includes(filter.used)) return false;
    if (filter.verdict && t.verdict !== filter.verdict) return false;
    if (filter.session && !t.sessionId.startsWith(filter.session)) return false;
    if (filter.source && t.notes[t.notes.length - 1]?.source !== filter.source) return false;
    return true;
  });
}

export function describeTrace(trace: Trace): string {
  const lines: string[] = [];
  const note = trace.notes[trace.notes.length - 1];
  lines.push(`${trace.id}  ${trace.verdict}  ${trace.tags.join(",") || "-"}  session ${trace.sessionId}`);
  lines.push(`transcript: ${trace.transcriptPath}${trace.copied ? " (copy)" : ""}`);
  for (const n of trace.notes) lines.push(`note (${n.source}, ${n.at.slice(0, 16)}): ${n.text}`);
  if (!note) lines.push("note: none yet");
  const env = trace.environment;
  lines.push(
    `environment: Claude Code ${env.claudeVersion ?? "?"}, ${env.model ?? "?"}${env.effort ? ` (${env.effort})` : ""}, ${env.cwd ?? "?"}${env.gitBranch ? ` on ${env.gitBranch}` : ""}`,
  );
  if (env.git)
    lines.push(
      `git (read ${env.git.readAt.slice(0, 16)}): ${env.git.commit?.slice(0, 12)}${env.git.dirty ? " + uncommitted changes" : ""}`,
    );
  for (const f of env.instructions) lines.push(`instructions: ${f.path} (${f.type ?? "?"}, ${f.bytes} bytes)`);
  lines.push(`used: ${trace.used.join(", ") || "-"}`);

  let records: Rec[] = [];
  try {
    records = readTranscript(trace.transcriptPath);
  } catch {
    lines.push("(the transcript is gone; only the bookmark is left)");
  }
  trace.moments.forEach((m, i) => {
    lines.push("", `moment ${i + 1}: ${m.requestId} at ${m.timestamp ?? "?"}`);
    if (!records.length) return;
    const chain = chainTo(records, m.replyUuid, true);
    const user = chain.find((r) => r.uuid === m.turnUuid);
    if (user) lines.push(`  user asked: ${clip(textOf(user), 600)}`);
    const reply = chain.filter((r) => r.type === "assistant" && r.requestId === m.requestId);
    const text = reply.map(textOf).join("\n").trim();
    const tools = reply.flatMap((r) =>
      (Array.isArray(r.message?.content) ? r.message!.content : [])
        .filter((b) => b.type === "tool_use")
        .map((b) => b.name),
    );
    lines.push(`  reply: ${text ? clip(text, 1500) : "(no text)"}`);
    if (tools.length) lines.push(`  reply called: ${tools.join(", ")}`);
    const reaction = m.reactionUuid ? records.find((r) => r.uuid === m.reactionUuid) : undefined;
    if (reaction) lines.push(`  reaction: ${clip(textOf(reaction), 600)}`);
  });
  return lines.join("\n");
}
