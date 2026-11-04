// The memory tools as the server lists them: Claude Code's memory_list, memory_read and memory_write
// (2.1.318), with their descriptions and input schemas, and how a call finds its session's folder.

import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { Option, Schema } from "effect";
import { McpSchema } from "effect/ai";

import LIST_TEXT from "./text/memory_list.md" with { type: "text" };
import READ_TEXT from "./text/memory_read.md" with { type: "text" };
import WRITE_TEXT from "./text/memory_write.md" with { type: "text" };

export const INSTRUCTIONS =
  "Claude Code's auto memory, for this harness: memory_list, memory_read and memory_write read and " +
  "save this project's memories in the store `personal`, the same folder Claude Code's auto memory " +
  "uses. The # Memory section at the start of the session says how to use it and loads its index; " +
  "without one, memory_read /MEMORY.md before relying on memory.";

const STORES_HINT = "(call memory_list with no arguments to see the stores available in this session)";

const text = (file: string) => file.replace(/\n$/, "");

export const TOOLS: ReadonlyArray<McpSchema.Tool> = [
  new McpSchema.Tool({
    name: "memory_list",
    description: text(LIST_TEXT),
    annotations: { title: "List memories", readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        store: {
          type: "string",
          description:
            "Id of the memory store to list. Omit to list the memory stores available in this session (id, description, writable or read-only, and the path of its index document).",
        },
        path_prefix: {
          type: "string",
          description:
            "Optional directory prefix to list only documents under it (e.g. /feedback/). Matching is directory-aligned (/x is the same as /x/). Omit to list the whole store.",
        },
        cursor: {
          type: "string",
          description: "Path of the last entry from a previous call. Returns entries after this path.",
        },
      },
      additionalProperties: false,
    },
  }),
  new McpSchema.Tool({
    name: "memory_read",
    description: text(READ_TEXT),
    annotations: { title: "Read a memory", readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        store: { type: "string", description: `Id of the memory store to read from ${STORES_HINT}.` },
        path: { type: "string", description: "Path of the memory document to read (e.g. /MEMORY.md)." },
      },
      required: ["store", "path"],
      additionalProperties: false,
    },
  }),
  new McpSchema.Tool({
    name: "memory_write",
    description: text(WRITE_TEXT),
    annotations: { title: "Save a memory", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        store: { type: "string", description: `Id of the memory store to write to ${STORES_HINT}.` },
        path: {
          type: "string",
          description: "Path of the document to create or update (e.g. /feedback_testing.md).",
        },
        content: {
          type: "string",
          description:
            "Full text content to write (UTF-8). Replaces the entire document — any line you omit is deleted. Line endings are normalized to LF, invisible/format characters are stripped, and other control characters are replaced with U+FFFD. Empty or whitespace-only content is rejected. Capped at 100KB per document.",
        },
        if_version: {
          type: "string",
          maxLength: 64,
          description:
            "Pass the 12-character version token from your most recent memory_read or memory_write of this file. For a file that does not yet exist (not shown in the listing), pass the literal word new (without quotes; an empty string is treated the same way). For any file already in the listing, memory_read it first to get its version token — the listing itself does not contain version tokens. Never invent a value.",
        },
      },
      required: ["store", "path", "content", "if_version"],
      additionalProperties: false,
    },
  }),
];

/**
 * The folder a call works in. Codex names the turn's folder in `codex/sandbox-state` (sent to a
 * server that asks for it, as this one does) and, in a Git repository, its root in
 * x-codex-turn-metadata; another client may start the server in the session's folder with PWD set.
 * Codex passes no PWD and starts the server in the plugin's own folder, so without any of these the
 * call has no project: null.
 */
// The two fields of a call's _meta that can name its folder, each read on its own so that a change
// to one doesn't hide the other.
const SandboxState = Schema.Struct({ "codex/sandbox-state": Schema.Struct({ sandboxCwd: Schema.String }) });
const TurnMetadata = Schema.Struct({
  "x-codex-turn-metadata": Schema.Struct({ workspaces: Schema.Record(Schema.String, Schema.Unknown) }),
});
const decodeSandbox = Schema.decodeUnknownOption(SandboxState);
const decodeTurn = Schema.decodeUnknownOption(TurnMetadata);

export function sessionFolder(meta: unknown, pwd: string | null): string | null {
  const sandbox = decodeSandbox(meta);
  if (Option.isSome(sandbox)) {
    try {
      return fileURLToPath(sandbox.value["codex/sandbox-state"].sandboxCwd);
    } catch {
      // Not a file URL: try the others.
    }
  }
  const turn = decodeTurn(meta);
  const workspaces = Option.isSome(turn) ? Object.keys(turn.value["x-codex-turn-metadata"].workspaces) : [];
  return workspaces.find((path) => isAbsolute(path)) ?? pwd;
}
