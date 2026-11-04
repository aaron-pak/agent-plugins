// Instruction files (CLAUDE.md, AGENTS.md, rules) in recorded sessions.
//
// A recorded session carries the files it loaded as an `instructions` attachment: the files' text,
// and the <system-reminder> the model was sent, which quotes each file under a "Contents of <path>"
// header. Rewriting that attachment in a copy of the history makes the resumed conversation read the
// new text where the old text was; `evals run --instructions` does this for recorded cases.

import { writeFileSync } from "node:fs";

import { type InstructionFile, type Rec, readTranscript } from "./transcript.ts";

const LABELS: Record<string, string> = {
  Project: "project instructions, checked into the codebase",
  User: "user's private global instructions for all projects",
  Local: "user's private project instructions, not checked in",
  Managed: "managed instructions",
};

/** Claude Code drops frontmatter, HTML comments and trailing whitespace from an instruction file before sending it. */
export function renderFile(text: string): string {
  let body = text.replace(/^﻿/, "");
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

export function header(file: { path: string; type?: string }): string {
  return `Contents of ${file.path} (${LABELS[file.type ?? "Project"] ?? LABELS.Project}):`;
}

export function reminder(files: InstructionFile[]): string {
  const sections = files.map((f) => `${header(f)}\n\n${f.content}`);
  return `<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${sections.join("\n\n")}\n</system-reminder>`;
}

export type Edit =
  | { kind: "replace"; path: string; text: string }
  | { kind: "remove"; path: string }
  | { kind: "add"; path: string; type?: string; text: string };

export type RewriteResult = { records: Rec[]; changed: number; warnings: string[] };

export function recordedFiles(records: Rec[]): InstructionFile[] {
  const files = new Map<string, InstructionFile>();
  for (const rec of records) {
    if (rec.type === "attachment" && rec.attachment?.type === "instructions") {
      for (const f of rec.attachment.files ?? []) files.set(f.path, f);
    }
  }
  return [...files.values()];
}

/** Applies the edits to every `instructions` attachment in a history. */
export function rewriteHistory(records: Rec[], edits: Edit[]): RewriteResult {
  const warnings: string[] = [];
  let changed = 0;
  const seen = new Set<string>();
  const out = records.map((rec) => {
    if (rec.type !== "attachment" || rec.attachment?.type !== "instructions") return rec;
    let files = [...(rec.attachment.files ?? [])];
    let rendered = Array.isArray(rec.rendered) ? rec.rendered.map((r) => r.content).join("") : undefined;
    let exact = rendered !== undefined;
    const section = (f: InstructionFile) => `${header(f)}\n\n${f.content}`;
    for (const edit of edits) {
      const at = files.findIndex((f) => f.path === edit.path);
      const old = at >= 0 ? files[at]! : undefined;
      if (edit.kind === "remove") {
        if (!old) continue;
        seen.add(edit.path);
        files = files.filter((_, i) => i !== at);
        if (rendered !== undefined) {
          const next = rendered.replace(`\n\n${section(old)}`, "");
          exact &&= next !== rendered;
          rendered = next;
        }
        continue;
      }
      if (edit.kind === "replace" && !old) continue;
      seen.add(edit.path);
      const file: InstructionFile = old
        ? { ...old, content: renderFile(edit.text) }
        : {
            path: edit.path,
            type: edit.kind === "add" ? (edit.type ?? "Project") : "Project",
            content: renderFile(edit.text),
          };
      if (old) files[at] = file;
      else files.push(file);
      if (rendered !== undefined) {
        const next = old
          ? rendered.replace(section(old), () => section(file))
          : rendered.replace(/\n<\/system-reminder>\s*$/, () => `\n\n${section(file)}\n</system-reminder>`);
        exact &&= next !== rendered;
        rendered = next;
      }
    }
    changed++;
    const next: Rec = { ...rec, attachment: { ...rec.attachment, files } };
    if (rendered !== undefined) {
      // The rendered text is what the model was sent. Edit it in place when the old sections are
      // found in it, so anything else it says survives; otherwise rebuild it from the files.
      if (!exact)
        warnings.push(
          "a recorded instructions message didn't quote the files as expected, so it was rebuilt from them",
        );
      next.rendered = exact ? [{ content: rendered }] : files.length ? [{ content: reminder(files) }] : [];
    }
    return next;
  });
  for (const edit of edits) {
    if (edit.kind !== "add" && !seen.has(edit.path)) {
      const known = recordedFiles(records).map((f) => f.path);
      throw new Error(`the history never loaded ${edit.path}${known.length ? `; it loaded ${known.join(", ")}` : ""}`);
    }
  }
  if (changed === 0) {
    if (edits.some((e) => e.kind === "add")) {
      warnings.push(
        "the history loaded no instruction files, so there was no attachment to add to; use a shim plugin for this case",
      );
    }
  }
  for (const edit of edits) {
    if (edit.kind !== "remove" && /^\s*@\S/m.test(edit.text)) {
      warnings.push(`${edit.path} has an @import line; it's sent as written, not expanded`);
    }
  }
  return { records: out, changed, warnings };
}

export function rewriteHistoryFile(path: string, edits: Edit[], outPath = path): RewriteResult {
  const result = rewriteHistory(readTranscript(path), edits);
  writeFileSync(outPath, result.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return result;
}
