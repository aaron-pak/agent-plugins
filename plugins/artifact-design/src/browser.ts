// Opening a published page in the person's browser, where this machine has a way to: macOS's open,
// Windows' explorer.exe, or xdg-open in a Linux desktop session.

import { Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "./config.ts";

export class Browser extends Context.Service<
  Browser,
  {
    /** Whether there is a browser to open pages in here. */
    readonly available: boolean;
    /** Open a file in the browser; false when there is no way to here. */
    open(path: string): Effect.Effect<boolean>;
  }
>()("artifact-design/Browser") {
  static readonly layer = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { opener } = yield* ServerConfig;
      const open = (path: string) =>
        opener === null
          ? Effect.succeed(false)
          : // The opener goes on alone: unreferenced, it outlives the scope, and the server neither
            // waits for it nor stops it.
            spawner
              .spawn(ChildProcess.make(opener, [path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
              .pipe(
                Effect.flatMap((handle) => handle.unref),
                Effect.scoped,
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
      return Browser.of({ available: opener !== null, open });
    }),
  );
}
