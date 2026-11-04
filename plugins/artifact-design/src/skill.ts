// The bundled artifact-design skill, whose text and scripts the server reads, so there is one copy of
// each: quickstart's guidance, the highlight.js runtime and the preview script.

import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect";

import { ServerConfig } from "./config.ts";
import { ActionError, messageOf } from "./errors.ts";
import { HLJS_RUNTIME_FILE } from "./publish.ts";

export class Skill extends Context.Service<
  Skill,
  {
    /** The skill's scripts folder (preview.mjs and the page runtimes). */
    readonly scripts: string;
    /** SKILL.md's page contract and design guidance, from "## Page contract" on. */
    readonly guidance: Effect.Effect<string, ActionError>;
    /** The highlight.js runtime, read once, the first time a page needs it. */
    readonly highlightRuntime: Effect.Effect<string, ActionError>;
  }
>()("artifact-design/Skill") {
  static readonly layer = Layer.effect(
    Skill,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const { skillDir } = yield* ServerConfig;
      const scripts = paths.join(skillDir, "scripts");
      const skillFile = paths.join(skillDir, "SKILL.md");

      const guidance = Effect.gen(function* () {
        const text = yield* fs
          .readFileString(skillFile)
          .pipe(Effect.mapError((error) => new ActionError({ message: messageOf(error) })));
        const start = text.indexOf("## Page contract");
        if (start === -1) return yield* new ActionError({ message: `${skillFile} has no "## Page contract" section` });
        return text.slice(start).trim();
      });

      // Read once it has been read; a failed read is tried again on the next call.
      const runtime = yield* Ref.make<string | null>(null);
      const highlightRuntime = Effect.gen(function* () {
        const known = yield* Ref.get(runtime);
        if (known !== null) return known;
        const text = yield* fs.readFileString(paths.join(scripts, HLJS_RUNTIME_FILE)).pipe(
          Effect.map((text) => text.replace(/\n+$/, "")),
          Effect.mapError(() => new ActionError({ message: `the plugin's ${HLJS_RUNTIME_FILE} is missing` })),
        );
        yield* Ref.set(runtime, text);
        return text;
      });

      return Skill.of({ scripts, guidance, highlightRuntime });
    }),
  );
}
