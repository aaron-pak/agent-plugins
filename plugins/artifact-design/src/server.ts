// An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.
//
// It exposes `Artifact`, with the claude.ai tool's actions that make sense on a local machine,
// and, where preview can run, `ArtifactCheck` (src/artifacts.ts):
//
// - quickstart: the page contract and design guidance, the same text the claude.ai tool's
//   quickstart returns for a plain page (read from the bundled artifact-design skill).
// - publish: wraps the page in the claude.ai publish skeleton and writes it to an artifacts
//   folder (ARTIFACTS_DIR, default ~/artifacts), one folder per artifact. Publishing the same
//   file again in the same session (this server process, a Claude Code session ID the artifact
//   lists, or a file in a drafts folder) updates the same artifact, as the Artifact tool keeps its
//   file-to-artifact map per session; `url` updates any artifact.
//   A Markdown file is rendered into the document template Claude Code uses for one. `edits`
//   changes the file on the way, as the Artifact tool's does (src/edits.ts).
// - list, read, open, delete: the published artifacts.
// - ArtifactCheck's preview: renders the page at 1280 and 390px wide in light and dark (or the
//   widths and themes given), as Claude Code's ArtifactCheck does, and returns the captures and
//   what breaks (scripts/preview.mjs). The tool is listed only when Playwright and a Chromium are
//   found (src/preview.ts), and ARTIFACT_PREVIEW=0 leaves it out. Claude Code's ArtifactCheck also
//   has verify, which reads what claude.ai viewers' browsers reported; there is nothing like it here.
//
// Codex strips every description from an input schema over 5,000 bytes, so the plugin's Codex
// manifest starts the server with --client=codex, and it lists a compact tool whose text fits and
// points to quickstart for the rest.
//
// Speaks MCP over stdio, both the 2026-07-28 revision and the earlier ones, with Effect's McpServer.
// scripts/build.ts bundles it into mcp/server.mjs, which runs on Node.

import { NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Cause, Context, Effect, Exit, Layer, Logger, Runtime } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { Artifacts } from "./artifacts.ts";
import { Browser } from "./browser.ts";
import { ServerConfig } from "./config.ts";
import { Drafts } from "./drafts.ts";
import { Preview } from "./preview.ts";
import { Skill } from "./skill.ts";
import { Store } from "./store.ts";
import { INSTRUCTIONS, checkTool, tool } from "./tool.ts";

const argumentsOf = (payload: unknown): Readonly<Record<string, unknown>> =>
  payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

const ArtifactTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const artifacts = yield* Artifacts;
    const config = yield* ServerConfig;
    const drafts = yield* Drafts;
    const browser = yield* Browser;
    yield* server.addTool({
      tool: tool(config.codex, {
        store: config.store,
        drafts: drafts.folder,
        opens: config.openPages && browser.available,
      }),
      annotations: Context.empty(),
      handle: (payload) => artifacts.call(argumentsOf(payload)),
    });
  }),
);

// ArtifactCheck is listed only where preview is offered, by the last start's answer so that the list
// is ready at once. A call waits for this start's own answer instead, and says why when preview can't
// run; with ARTIFACT_PREVIEW=0 the tool is an unknown one.
const PreviewOffered = McpServer.visibility(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const preview = yield* Preview;
    return ({ method }: McpServer.MiddlewareOptions) =>
      !config.previewSwitch ? Effect.succeed(false) : method === "tools/list" ? preview.offered : Effect.succeed(true);
  }),
);

const CheckTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const artifacts = yield* Artifacts;
    yield* server.addTool({
      tool: checkTool(),
      annotations: Context.empty(),
      services: yield* Effect.context<never>(), // carries the visibility
      handle: (payload) => artifacts.check(argumentsOf(payload)),
    });
  }),
).pipe(Layer.provide(PreviewOffered.layer));

const Services = Artifacts.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Preview.layer, Browser.layer)),
  Layer.provideMerge(Layer.mergeAll(Store.layer, Skill.layer)),
  Layer.provideMerge(Drafts.layer),
  Layer.provideMerge(ServerConfig.layer),
  Layer.provideMerge(NodeServices.layer),
);

const Server = McpServer.layerStdio({
  name: "artifact",
  version: "0.1.0",
  instructions: INSTRUCTIONS,
  protocols: [
    McpProtocol.v2026_07_28,
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ],
  registrations: Layer.mergeAll(ArtifactTool, CheckTool),
}).pipe(Layer.provide(NodeStdio.layer), Layer.provide(Services));

// The client closing stdin ends the session: the stdio transport interrupts the server, which stops a
// preview check still running. That is a normal end, so it exits 0. stdout carries only protocol
// messages, so every log, a failed start's included, goes to stderr.
Layer.launch(Server).pipe(
  Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit),
  }),
);
