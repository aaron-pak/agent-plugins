// Claude Code shows the model a scratchpad only when its own Artifact tool is on, so page files
// written for this plugin's tool would land in the person's project. They go to a private drafts
// folder instead, one per server process (one session), as a scratchpad is. The server makes the
// folder; writes into it get each harness's usual check, which auto mode's reviewer in Claude Code
// and Codex's sandbox (it allows the temp folder) pass without asking.

import { rmdir } from "node:fs/promises";

import { Clock, Context, Data, Effect, FileSystem, Layer, Option, Path } from "effect";

import { ServerConfig } from "./config.ts";

/** The local time as 20261009-142530. */
export function localStamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

const DAY = 86_400_000;

class NotOwnFolder extends Data.TaggedError("NotOwnFolder")<{ readonly path: string }> {}

export class Drafts extends Context.Service<
  Drafts,
  {
    /** The folder every session's drafts folder sits in, one per user. */
    readonly root: string;
    /** This session's drafts folder. */
    readonly folder: string;
    /** Whether root is a real folder this user owns, so nobody else can read the drafts or plant the folder. */
    readonly rootIsOwn: Effect.Effect<boolean>;
  }
>()("artifact-design/Drafts") {
  static readonly layer = Layer.effect(
    Drafts,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const { temp } = yield* ServerConfig;
      const uid = process.getuid?.();
      const root = paths.join(temp, uid === undefined ? "artifact-drafts" : `artifact-drafts-${uid}`);

      const rootIsOwn = fs.lstat(root).pipe(
        Effect.map(
          (info) => info.type === "Directory" && (uid === undefined || Option.getOrUndefined(info.uid) === uid),
        ),
        Effect.orElseSucceed(() => false),
      );

      // A private (0700) folder for this session under root; empty folders a day old go.
      const own = Effect.gen(function* () {
        yield* fs
          .makeDirectory(root, { mode: 0o700 })
          .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
        // Someone else's folder (or a link) in its place: the drafts go to a fresh folder in temp instead.
        if (!(yield* rootIsOwn)) return yield* new NotOwnFolder({ path: root });
        const now = yield* Clock.currentTimeMillis;
        for (const name of yield* fs.readDirectory(root)) {
          const old = paths.join(root, name);
          // Only empty folders go. FileSystem has no rmdir, whose refusal of a folder with anything in
          // it is what keeps a draft written meanwhile.
          yield* fs.stat(old).pipe(
            Effect.flatMap((info) =>
              info.type === "Directory" && now - Option.getOrElse(info.mtime, () => new Date(now)).getTime() > DAY
                ? Effect.tryPromise(() => rmdir(old))
                : Effect.void,
            ),
            Effect.ignore,
          );
        }
        return yield* fs.makeTempDirectory({ directory: root, prefix: `${localStamp(new Date(now))}-` });
      });

      const folder = yield* own.pipe(
        Effect.catch(() => fs.makeTempDirectory({ directory: temp, prefix: "artifact-drafts-" })),
      );
      return Drafts.of({ root, folder, rootIsOwn });
    }),
  );
}
