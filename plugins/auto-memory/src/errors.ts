// How a memory operation fails: the tool shows it as "<tool> failed: <message>", a tool error the
// model reads, not a protocol error.

import { Schema } from "effect";

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  message: Schema.String,
}) {}

/** An error's message, with the operating system's own words for a file error (Node's
 * "ENOENT: no such file or directory, open '…'") rather than Effect's summary of it. */
export const messageOf = (error: { readonly message: string; readonly cause?: unknown }): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

/** A file system error as a MemoryError. */
export const memoryError = (error: { readonly message: string; readonly cause?: unknown }) =>
  new MemoryError({ message: messageOf(error) });
