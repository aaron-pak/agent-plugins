// Paths as the tool handles them: ~ expanded, symlinks resolved as far as a path exists, and
// file: links percent-encoded as Python's Path.as_uri() encodes them.

import { Effect, FileSystem, Path } from "effect";

/** A path with ~ expanded against home. */
export const expandUser = (path: string, home: string): string =>
  path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? home + path.slice(1) : path;

/** A path made absolute (against the working directory), with its symlinks resolved as far as it
 * exists, as Python's Path.resolve() does. */
export const resolvePath = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const resolveFrom = (absolute: string): Effect.Effect<string> =>
    fs.realPath(absolute).pipe(
      Effect.catch(() => {
        const parent = paths.dirname(absolute);
        return parent === absolute
          ? Effect.succeed(absolute)
          : Effect.map(resolveFrom(parent), (resolved) => paths.join(resolved, paths.basename(absolute)));
      }),
    );
  return yield* resolveFrom(paths.resolve(path));
});

/** A path as a file: URI, percent-encoded as Python's Path.as_uri() encodes it. */
export function fileUri(path: string, platform: string = process.platform): string {
  const quote = (text: string) =>
    Array.from(new TextEncoder().encode(text), (byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9_.~\-/]/.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }).join("");
  if (platform === "win32") {
    const posix = path.replaceAll("\\", "/");
    const drive = /^[A-Za-z]:/.exec(posix);
    return drive ? `file:///${drive[0]}${quote(posix.slice(2))}` : `file:${quote(posix)}`;
  }
  return "file://" + quote(path);
}

/** The parts of path below folder, or null when it isn't below it. */
export function partsBelow(paths: Path.Path, folder: string, path: string): Array<string> | null {
  const rel = paths.relative(folder, path);
  if (!rel || rel === ".." || rel.startsWith(".." + paths.sep) || paths.isAbsolute(rel)) return null;
  return rel.split(paths.sep);
}
