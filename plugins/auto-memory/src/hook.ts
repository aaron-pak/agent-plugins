// The plugin's SessionStart hook. In Codex it starts the session the way Claude Code does (2.1.318):
// the memory section, then the MEMORY.md index, for the project the session is in. Claude Code has
// that built in, so there the hook only checks that Claude Code's auto memory is pointed at the shared
// store, and says how to point it there when it isn't.
//
// scripts/build.ts bundles it into mcp/hook.mjs, which hooks/hooks.json runs with node.

import { isAbsolute } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Logger, Path, Schema, Stdio, Stream } from "effect";

import { type Env, MemoryConfig } from "./config.ts";
import { sessionContext } from "./prompt.ts";
import { INDEX, Store } from "./store.ts";

const trim = (path: string) => path.replace(/[/\\]+$/, "");

/** In Claude Code: a warning when its auto memory doesn't use the shared store `root`, else null. */
export function claudeCodeCheck(env: Env, root: string): { systemMessage: string } | null {
  // Claude Code takes the value as it is: it expands no ~, and reads a relative path from each
  // session's folder.
  const set = env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
  if (set && isAbsolute(set) && trim(set) === trim(root)) return null;
  const now = !set
    ? "keeps its memory in ~/.claude"
    : isAbsolute(set)
      ? `uses ${set}`
      : `uses ${set}, which Claude Code reads from each session's folder (it expands no ~)`;
  return {
    systemMessage:
      `auto-memory: Claude Code's auto memory ${now}, not the shared store ${root}, so Codex won't see it. ` +
      `Add "env": {"CLAUDE_CODE_REMOTE_MEMORY_DIR": "${root}"} to ~/.claude/settings.json and restart Claude Code.`,
  };
}

/**
 * Whether Claude Code runs the hook. Codex names the plugin's folder in PLUGIN_ROOT and Claude Code in
 * CLAUDE_PLUGIN_ROOT (hooks.json falls back from one to the other: a Codex 0.166 hook that used only
 * CLAUDE_PLUGIN_ROOT failed to start). CLAUDECODE alone could be inherited, as by a Codex started
 * from Claude Code.
 */
export const inClaudeCode = (env: Env) =>
  !env.PLUGIN_ROOT && (Boolean(env.CLAUDE_PLUGIN_ROOT) || env.CLAUDECODE === "1");

/** In Codex and other harnesses: the memory section and index for the session's folder. */
export const sessionStart = Effect.fn("sessionStart")(function* (cwd: string) {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const dir = yield* store.dirFor(cwd);
  yield* store.ensure(dir);
  const index = yield* fs.readFileString(paths.join(dir, INDEX)).pipe(Effect.orElseSucceed(() => null));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(dir, index) } };
});

const HookInput = Schema.fromJsonString(Schema.Struct({ cwd: Schema.optional(Schema.String) }));
const decodeInput = Schema.decodeUnknownOption(HookInput);

/** The hook's output for its input (the hook event as JSON), or null when it has nothing to say. */
export const run = Effect.fn("run")(function* (input: string) {
  const config = yield* MemoryConfig;
  if (inClaudeCode(config.env)) return claudeCodeCheck(config.env, config.root);
  // Without a folder in the input, the hook's own folder is the session's.
  const cwd = decodeInput(input).pipe((decoded) => (decoded._tag === "Some" ? decoded.value.cwd : undefined));
  return yield* sessionStart(cwd || process.cwd());
});

export const Services = Store.layer.pipe(
  Layer.provideMerge(MemoryConfig.layer),
  Layer.provideMerge(NodeServices.layer),
);

if (process.argv[1]?.endsWith("hook.mjs")) {
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const input = yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.orElseSucceed(() => ""),
    );
    const output = yield* run(input);
    if (output) yield* Console.log(JSON.stringify(output));
  }).pipe(
    // A failure goes to stderr, which Codex and Claude Code show with the hook's failure.
    Effect.tapCause((cause) => Effect.logError(cause)),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provide(Services),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
