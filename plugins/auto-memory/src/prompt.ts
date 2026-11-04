// What a session starts with: Claude Code's memory section and its MEMORY.md index, loaded the way
// Claude Code loads them (2.1.318), for a harness that doesn't have auto memory built in.

import { join } from "node:path";

import { INDEX } from "./store.ts";

import SECTION from "./text/section.md" with { type: "text" };

const MAX_LINES = 200;
const MAX_BYTES = 25000;

/** Claude Code's memory section for the folder `dir`. */
export const section = (dir: string) => SECTION.replace("{dir}", () => dir).trimEnd();

/** Bytes as Claude Code shows them: "812 bytes", "24.4KB". */
function size(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
}

/** Shorten text to `max` characters at a word break, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  const words = space === -1 ? "" : cut.slice(0, space).trimEnd();
  return `${words.length > max / 2 ? words : cut.trimEnd()}…`;
}

/**
 * The index as Claude Code loads it: trimmed, and past 200 lines or 25,000 characters cut to fit, with
 * a warning that says what was cut.
 */
export function truncateIndex(content: string): string {
  const text = content.trim();
  const lines = text.split("\n").length;
  // Claude Code counts the index in characters, though it calls them bytes.
  const bytes = text.length;
  const tooManyLines = lines > MAX_LINES;
  const tooManyBytes = bytes > MAX_BYTES;
  if (!tooManyLines && !tooManyBytes) return text;
  let kept = tooManyLines ? text.split("\n").slice(0, MAX_LINES).join("\n") : text;
  if (kept.length > MAX_BYTES) {
    const end = kept.lastIndexOf("\n", MAX_BYTES);
    kept = kept.slice(0, end > 0 ? end : MAX_BYTES);
  }
  const keptLines = text[kept.length] === "\n" ? kept.split("\n").length : 0;
  const next = text.indexOf("\n", kept.length + 1);
  const firstCut = text.slice(kept.length + 1, next < 0 ? undefined : next).trim();
  const what =
    keptLines === 0
      ? `everything after the first ${kept.length} characters of line 1 was cut off`
      : `${lines - keptLines} of ${lines} lines were cut off, starting at line ${keptLines + 1}${firstCut ? ` ("${clip(firstCut, 80)}")` : ""}`;
  const why =
    tooManyBytes && !tooManyLines
      ? `${size(bytes)} (limit: ${size(MAX_BYTES)}) — index entries are too long`
      : tooManyLines && !tooManyBytes
        ? `${lines} lines (limit: ${MAX_LINES})`
        : `${lines} lines and ${size(bytes)}`;
  return `${kept}\n\n> WARNING: ${INDEX} is ${why}. Only part of it was loaded: ${what}. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

/** The index of the memory in `dir`, `content` being its MEMORY.md, as a session starts with it, or null
 * when there is none or it is empty. */
export function indexBlock(dir: string, content: string | null): string | null {
  if (content === null || !content.trim()) return null;
  return `Contents of ${join(dir, INDEX)} (user's auto-memory, persists across conversations):\n\n${truncateIndex(content)}`;
}

/** What a session starts with: the memory section, then the index when there is one. */
export function sessionContext(dir: string, content: string | null): string {
  const index = indexBlock(dir, content);
  return index ? `${section(dir)}\n\n${index}` : section(dir);
}
