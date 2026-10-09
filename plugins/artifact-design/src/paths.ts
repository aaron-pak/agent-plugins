// Paths as the tool handles them: ~ expanded, symlinks resolved as far as a path exists, and
// file: links percent-encoded as Python's Path.as_uri() encodes them.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A path with ~ expanded, made absolute, and its symlinks resolved as far as it exists, as Python's Path.resolve() does. */
export function resolvePath(path: string): string {
  const absolute = resolve(expandUser(path));
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolvePath(parent), basename(absolute));
  }
}

export function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? homedir() + path.slice(1) : path;
}

/** A path as a file: URI, percent-encoded as Python's Path.as_uri() encodes it. */
export function fileUri(path: string): string {
  const quote = (text: string) =>
    Array.from(new TextEncoder().encode(text), (byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9_.~\-/]/.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }).join("");
  if (process.platform === "win32") {
    const posix = path.replaceAll("\\", "/");
    const drive = /^[A-Za-z]:/.exec(posix);
    return drive ? `file:///${drive[0]}${quote(posix.slice(2))}` : `file:${quote(posix)}`;
  }
  return "file://" + quote(path);
}

/** The parts of path below folder, or null when it isn't below it. */
export function partsBelow(folder: string, path: string): string[] | null {
  const rel = relative(folder, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel.split(sep);
}
