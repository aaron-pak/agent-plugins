// The two ways an action fails. Both reach the model as a tool error, not as a protocol error.

import { Schema } from "effect";

/** An action that could not run: shown as "<action> failed: <message>". */
export class ActionError extends Schema.TaggedError<ActionError>()("ActionError", {
  message: Schema.String,
}) {}

/** A refusal shown exactly as written, with no "<action> failed:" in front. */
export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", {
  message: Schema.String,
}) {}

/** An error's message, with the operating system's own words for a file error (Node's
 * "ENOENT: no such file or directory, open '…'") rather than Effect's summary of it. */
export const messageOf = (error: { readonly message: string; readonly cause?: unknown }): string =>
  error.cause instanceof Error ? error.cause.message : error.message;
