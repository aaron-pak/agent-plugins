// A recorded conversation, made ready to resume in a run's sandbox.
//
// Two things in a recorded session don't survive the move to a sandbox on their own:
//
// - Its instruction files. On resume Claude Code re-reads the files the history loaded, at the paths
//   it recorded, and tells the model about any change ("Instructions no longer present: …"). The
//   recorded paths are on the machine the session ran on, so in a sandbox every file reads as
//   removed. So each recorded file is written into the sandbox (the cwd, the folders above it, or
//   the config folder for user files), with the text the history now holds, and the history's
//   paths are moved to match: the re-read then finds what was recorded and adds nothing.
// - Its reasoning. A signed thinking block is valid only in the exact conversation that produced
//   it: any change before it (an edited instruction file, a different tool list, a moved path) and
//   the API drops it. A sandbox always changes something, and a variant changes more than the
//   baseline, so the blocks are removed from every arm up front: each arm then resumes from the
//   same visible history, and none keeps reasoning another lost.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { recordedFiles } from "../instructions.ts";
import type { Block, Rec } from "../transcript.ts";

export type Placement = { cwd: string; parents: string[]; configDir: string };

function within(base: string, path: string): string | null {
  const rel = relative(base, path);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : null;
}

/** Where a recorded instruction file goes in the sandbox, or null when it has no place there. */
export function placeFor(path: string, type: string | undefined, recordedCwd: string | undefined, to: Placement) {
  if (type === "Managed") return null;
  if (type === "User") {
    const at = path.lastIndexOf("/.claude/");
    return join(to.configDir, at >= 0 ? path.slice(at + "/.claude/".length) : basename(path));
  }
  if (!recordedCwd) return null;
  let from = recordedCwd;
  for (const base of [to.cwd, ...to.parents]) {
    const rel = within(from, path);
    if (rel) return join(base, rel);
    from = dirname(from);
  }
  return null;
}

/** Moves instruction file paths in a history: the attachments' file lists and their rendered text. */
export function moveFiles(records: Rec[], moves: Map<string, string>): Rec[] {
  if (moves.size === 0) return records;
  const swap = (text: string) => {
    for (const [from, to] of moves) text = text.split(from).join(to);
    return text;
  };
  return records.map((rec) => {
    if (rec.type !== "attachment" || rec.attachment?.type !== "instructions") return rec;
    const next: Rec = {
      ...rec,
      attachment: {
        ...rec.attachment,
        files: (rec.attachment.files ?? []).map((f) => ({ ...f, path: moves.get(f.path) ?? f.path })),
      },
    };
    if (Array.isArray(rec.rendered)) next.rendered = rec.rendered.map((r) => ({ ...r, content: swap(r.content) }));
    return next;
  });
}

const isThinking = (b: Block) => b.type === "thinking" || b.type === "redacted_thinking";

/** Removes thinking blocks; a record left empty is dropped and its children relinked to its parent. */
export function stripThinking(records: Rec[]): { records: Rec[]; removed: number } {
  let removed = 0;
  const parentOf = new Map<string, string | null | undefined>();
  const kept: Rec[] = [];
  for (const rec of records) {
    const content = rec.message?.content;
    if (rec.type === "assistant" && Array.isArray(content) && content.some(isThinking)) {
      const rest = content.filter((b) => !isThinking(b));
      removed += content.length - rest.length;
      if (rest.length === 0) {
        if (rec.uuid) parentOf.set(rec.uuid, rec.parentUuid);
        continue;
      }
      kept.push({ ...rec, message: { ...rec.message, content: rest } });
      continue;
    }
    kept.push(rec);
  }
  const resolveParent = (uuid: string | null | undefined) => {
    while (uuid && parentOf.has(uuid)) uuid = parentOf.get(uuid);
    return uuid;
  };
  const out = parentOf.size
    ? kept.map((rec) =>
        rec.parentUuid && parentOf.has(rec.parentUuid) ? { ...rec, parentUuid: resolveParent(rec.parentUuid) } : rec,
      )
    : kept;
  return { records: out, removed };
}

/**
 * Writes each instruction file the history holds into the sandbox and moves the history's paths to
 * match, then strips the recorded thinking. Returns the history to resume, how many files were
 * placed, and notes for the result.
 */
export function prepareHistory(records: Rec[], to: Placement): { records: Rec[]; placed: number; notes: string[] } {
  const notes: string[] = [];
  const recordedCwd = records.find((r) => typeof r.cwd === "string")?.cwd;
  const moves = new Map<string, string>();
  for (const f of recordedFiles(records)) {
    const target = placeFor(f.path, f.type, recordedCwd, to);
    if (!target) {
      notes.push(
        `the history loaded ${f.path}, which has no place in the sandbox; the resumed session is told it's no longer present`,
      );
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    moves.set(f.path, target);
  }
  const stripped = stripThinking(moveFiles(records, moves));
  if (stripped.removed > 0)
    notes.push(
      `${stripped.removed} recorded thinking block(s) removed: the API keeps reasoning only in the conversation that produced it, so every arm resumes without it`,
    );
  return { records: stripped.records, placed: moves.size, notes };
}
