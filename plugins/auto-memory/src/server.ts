// The memory MCP server: Claude Code's memory_list, memory_read and memory_write tools (2.1.318) for
// a harness without auto memory built in, over the folder Claude Code's own auto memory keeps for
// the project (src/store.ts). Codex starts it from the plugin's manifest.
//
// The tools take the store id Claude Code's do; here the one store is `personal`, the memory folder
// of the session's project. Codex starts one server for every session of its app server, so the
// server learns the project at each call, from the folder Codex names in the call's metadata
// (sessionFolder in src/tools.ts).
//
// Speaks MCP over stdio with Effect's McpServer; scripts/build.ts bundles it into mcp/server.mjs,
// which runs on Node.

import { NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Cause, Context, Effect, Exit, Layer, Logger, Runtime, Sink, Stdio } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";

import { MemoryConfig } from "./config.ts";
import { Memory } from "./memory.ts";
import { Store } from "./store.ts";
import { INSTRUCTIONS, TOOLS } from "./tools.ts";

const argumentsOf = (payload: unknown): Readonly<Record<string, unknown>> =>
  payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

const MemoryTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const memory = yield* Memory;
    for (const tool of TOOLS)
      yield* server.addTool({
        tool,
        annotations: Context.empty(),
        handle: (payload) =>
          McpSchema.McpRequestContext.use((request) =>
            memory.call(tool.name, argumentsOf(payload), request.requestMetadata),
          ),
      });
  }),
);

/**
 * The capability that asks Codex to name the turn's folder in each call's _meta["codex/sandbox-state"],
 * added to the server's initialize result. McpServer declares only the standard capabilities, so this
 * adds it to the reply on its way out.
 */
export function withSandboxState(line: string): string {
  if (!line.includes('"capabilities"') || !line.includes('"protocolVersion"')) return line;
  try {
    const message = JSON.parse(line) as { result?: { capabilities?: Record<string, unknown>; serverInfo?: unknown } };
    const result = message.result;
    if (!result?.capabilities || !result.serverInfo) return line;
    result.capabilities.experimental = { "codex/sandbox-state-meta": {} };
    return `${JSON.stringify(message)}\n`;
  } catch {
    return line;
  }
}

const decoder = new TextDecoder();
const SandboxStateStdio = Layer.effect(
  Stdio.Stdio,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return Stdio.make({
      ...stdio,
      // Each chunk the transport writes is one whole message and its newline.
      stdout: (options) =>
        stdio
          .stdout(options)
          .pipe(
            Sink.mapInput((chunk: string | Uint8Array) =>
              withSandboxState(typeof chunk === "string" ? chunk : decoder.decode(chunk)),
            ),
          ),
    });
  }),
).pipe(Layer.provide(NodeStdio.layer));

const Services = Memory.layer.pipe(
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(MemoryConfig.layer),
  Layer.provideMerge(NodeServices.layer),
);

const Server = McpServer.layerStdio({
  name: "memory",
  version: "0.1.0",
  instructions: INSTRUCTIONS,
  protocols: [
    McpProtocol.v2026_07_28,
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ],
  registrations: MemoryTools,
}).pipe(Layer.provide(SandboxStateStdio), Layer.provide(Services));

// The client closing stdin ends the session, a normal end, so it exits 0. stdout carries only
// protocol messages, so every log, a failed start's included, goes to stderr.
if (process.argv[1]?.endsWith("server.mjs")) {
  Layer.launch(Server).pipe(
    Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
    Effect.provideService(Logger.LogToStderr, true),
    NodeRuntime.runMain({
      disableErrorReporting: true,
      teardown: (exit, onExit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit),
    }),
  );
}
