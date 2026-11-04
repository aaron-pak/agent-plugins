// What the server reads from its surroundings once, at startup: the environment, its own command
// line and where the bundled skill sits.

import { homedir, tmpdir } from "node:os";

import { Config, Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { expandUser, resolvePath } from "./paths.ts";

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly home: string;
    /** The folder the server started in, which relative paths would resolve against. */
    readonly cwd: string;
    /** The system's temporary folder (TMPDIR). */
    readonly temp: string;
    /** The artifacts folder (ARTIFACTS_DIR, default ~/artifacts), resolved at startup. */
    readonly store: string;
    /** Whether a first publish opens the page (ARTIFACT_OPEN, default on). */
    readonly openPages: boolean;
    /** The command that opens a file in the browser here: macOS, Windows, or a Linux desktop session. */
    readonly opener: string | null;
    /** Whether ArtifactCheck's preview may be offered (ARTIFACT_PREVIEW, default on). */
    readonly previewSwitch: boolean;
    /** The Claude Code session that started the server; a resumed session keeps its ID. */
    readonly sessionId: string | null;
    /** Whether the client is Codex: its manifest starts the server with --client=codex. */
    readonly codex: boolean;
    /** The bundled artifact-design skill, whose text and scripts the server reads. */
    readonly skillDir: string;
    readonly path: string;
    /** Where Playwright looks for its browsers (PLAYWRIGHT_BROWSERS_PATH), part of the preview setup. */
    readonly browsersPath: string;
    readonly platform: NodeJS.Platform;
  }
>()("artifact-design/ServerConfig") {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const env = (name: string) => Config.String(name).pipe(Config.withDefault(""));
      const home = homedir();
      const artifactsDir = yield* env("ARTIFACTS_DIR");
      const display = (yield* env("DISPLAY")) || (yield* env("WAYLAND_DISPLAY"));
      const searchPath = yield* env("PATH");
      const platform = process.platform;
      // xdg-open is looked for on PATH as a shell would find it.
      const onPath = (name: string) =>
        Effect.findFirst(searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean), (dir) =>
          fs.exists(paths.join(dir, name)).pipe(Effect.orElseSucceed(() => false)),
        ).pipe(Effect.map(Option.isSome));
      const opener =
        platform === "darwin"
          ? "open"
          : platform === "win32"
            ? "explorer.exe"
            : display && (yield* onPath("xdg-open"))
              ? "xdg-open"
              : null;
      // Both this file and the bundle (mcp/server.mjs) sit one folder below the plugin's root.
      const skillDir = yield* paths.fromFileUrl(new URL("../skills/artifact-design/", import.meta.url));
      return ServerConfig.of({
        home,
        cwd: process.cwd(),
        temp: tmpdir(),
        store: yield* resolvePath(expandUser(artifactsDir || paths.join(home, "artifacts"), home)),
        openPages: (yield* Config.String("ARTIFACT_OPEN").pipe(Config.withDefault("1"))) !== "0",
        opener,
        previewSwitch: (yield* Config.String("ARTIFACT_PREVIEW").pipe(Config.withDefault("1"))) !== "0",
        sessionId: (yield* env("CLAUDE_CODE_SESSION_ID")) || null,
        codex: process.argv.slice(2).includes("--client=codex"),
        skillDir,
        path: searchPath,
        browsersPath: yield* env("PLAYWRIGHT_BROWSERS_PATH"),
        platform,
      });
    }),
  );
}
