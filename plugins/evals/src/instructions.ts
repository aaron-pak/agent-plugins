// Instruction-file variants (CLAUDE.md, AGENTS.md, rules) for `claude plugin eval`, which loads no
// instruction file in a run.
//
// A recorded session carries the files it loaded as an `instructions` attachment: the files' text,
// and the <system-reminder> the model was sent, which quotes each file under a "Contents of <path>"
// header. A variant of a recorded case rewrites that attachment in a copy of the history, so the
// resumed conversation reads the new text where the old text was.
//
// A fresh case has no history, so a variant reaches it through a small plugin whose SessionStart hook
// adds the file's text as context, rendered the way Claude Code renders an instruction file. That is
// the closest a run gets to the real loading path, not the same one: it arrives as hook context.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { type InstructionFile, type Rec, readTranscript } from "./transcript.ts";

const LABELS: Record<string, string> = {
  Project: "project instructions, checked into the codebase",
  User: "user's private global instructions for all projects",
  Local: "user's private project instructions, not checked in",
  Managed: "managed instructions",
};

/** Claude Code drops frontmatter and HTML comments from an instruction file before sending it. */
export function renderFile(text: string): string {
  let body = text.replace(/^﻿/, "");
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/^\n+/, "");
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

/** A plugin whose SessionStart hook adds the given instruction files as context. */
export function writeShim(
  dir: string,
  files: { path: string; type?: string; text: string }[],
  name = "instructions-variant",
): void {
  const rendered = files.map((f) => ({ path: f.path, type: f.type ?? "Project", content: renderFile(f.text) }));
  const context = rendered.map((f) => `${header(f)}\n\n${f.content}`).join("\n\n");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name, description: "Adds an instruction-file variant as session context, for evals." }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "hooks", "context.json"),
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`,
  );
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/context.json"' }] }],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function caseDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const names = readdirSync(dir);
    if (names.includes("case.yaml") || names.includes("prompt.md")) {
      out.push(dir);
      return;
    }
    for (const n of names) {
      if (n === "results" || n === "mocks" || n.startsWith(".")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

function historyOf(caseDir: string): string | undefined {
  const yaml = join(caseDir, "case.yaml");
  if (!existsSync(yaml)) return undefined;
  const m = /^\s+history_file:\s*["']?([^"'\n]+)["']?\s*$/m.exec(readFileSync(yaml, "utf8"));
  return m ? join(caseDir, m[1]!.trim()) : undefined;
}

/** Adds a plugin directory to a case's `plugins:` list in case.yaml, creating case.yaml if needed. */
function addPlugin(caseDir: string, pluginDir: string): void {
  const rel = relative(caseDir, pluginDir);
  const yamlPath = join(caseDir, "case.yaml");
  if (!existsSync(yamlPath)) {
    const name = caseDir.split("/").pop()!;
    writeFileSync(
      yamlPath,
      `schema_version: "1.1"\nname: ${JSON.stringify(name)}\nplugins: [${JSON.stringify(rel)}]\n`,
    );
    return;
  }
  let yaml = readFileSync(yamlPath, "utf8");
  const inline = /^plugins:\s*\[(.*)\]\s*$/m.exec(yaml);
  if (inline) {
    const items = inline[1]!.trim() ? `${inline[1]!.trim()}, ` : "";
    yaml = yaml.replace(inline[0], `plugins: [${items}${JSON.stringify(rel)}]`);
  } else if (/^plugins:\s*$/m.test(yaml)) {
    yaml = yaml.replace(/^plugins:\s*$/m, `plugins:\n  - ${JSON.stringify(rel)}`);
  } else {
    yaml = yaml.replace(/^(name:.*)$/m, `$1\nplugins: [${JSON.stringify(rel)}]`);
  }
  writeFileSync(yamlPath, yaml);
}

export type VariantOptions = {
  suite: string;
  out: string;
  /** The new text of the file at `replaces`, or of a new file at `path` for fresh cases. */
  file: string;
  /** The path the recorded sessions loaded the file from. */
  replaces?: string;
  /** Where the file lives for fresh cases (default: `replaces`, else the file's own path). */
  path?: string;
  type?: string;
};

export type VariantResult = { recorded: string[]; fresh: string[]; warnings: string[] };

/** Copies a suite and puts one instruction-file variant into every case: recorded cases get their
 * history rewritten; fresh cases get a shim plugin. */
export function writeVariant(options: VariantOptions): VariantResult {
  const suite = resolve(options.suite);
  const out = resolve(options.out);
  if (existsSync(out)) throw new Error(`${out} exists; pick a new folder for the variant`);
  const text = readFileSync(options.file, "utf8");
  const path = options.path ?? options.replaces ?? resolve(options.file);
  cpSync(suite, out, {
    recursive: true,
    filter: (src) => !relative(suite, src).split("/").includes("results"),
  });
  const result: VariantResult = { recorded: [], fresh: [], warnings: [] };
  const shimDir = join(out, ".variant-plugin");
  let shimWritten = false;
  for (const dir of caseDirs(out)) {
    const history = historyOf(dir);
    if (history && existsSync(history)) {
      if (!options.replaces)
        throw new Error(`${relative(out, dir)} is a recorded case; pass --replaces <the path its session loaded>`);
      const r = rewriteHistoryFile(history, [{ kind: "replace", path: options.replaces, text }]);
      result.warnings.push(...r.warnings.map((w) => `${relative(out, dir)}: ${w}`));
      result.recorded.push(relative(out, dir));
    } else {
      if (!shimWritten) {
        writeShim(shimDir, [{ path, type: options.type, text }]);
        shimWritten = true;
      }
      addPlugin(dir, shimDir);
      result.fresh.push(relative(out, dir));
    }
  }
  return result;
}
