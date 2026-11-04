// The memory store on disk: where a project's memories live, and reading, listing and saving them
// the way Claude Code's memory_list, memory_read and memory_write tools do.
//
// The layout is Claude Code's own: <root>/projects/<project key>/memory/, with MEMORY.md as the index.
// Claude Code puts it under ~/.claude, or under CLAUDE_CODE_REMOTE_MEMORY_DIR when that is set, which
// is how its auto memory shares this store (see the README). The project key is Claude Code's too:
// the real path of the repository's main working tree (so worktrees and subfolders share one memory),
// or of the folder itself outside a repository, with each character other than a letter or digit
// turned into "-", and a hash after the first 200 characters of a longer one.

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";

import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { MemoryConfig } from "./config.ts";
import { MemoryError, memoryError } from "./errors.ts";

export const INDEX = "MEMORY.md";
export const STORE_ID = "personal";
export const READ_CAP = 102400; // bytes: Claude Code refuses to read or write a bigger document
export const LIST_CAP = 50; // entries per memory_list page

// ---------------------------------------------------------------- the project key

/** Claude Code's hash for a long key: a 32-bit string hash, as a positive base-36 number. */
function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** A path as Claude Code names its project folder. */
export function sanitize(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= 200 ? name : `${name.slice(0, 200)}-${hash(path)}`;
}

// ---------------------------------------------------------------- documents

export type Doc = { readonly content: string; readonly updatedAt: string; readonly bytes: number };
export type Entry = { readonly path: string; readonly bytes: number; readonly updatedAt: string };

/** A document's version token: the first 12 hex digits of its SHA-256. */
export const version = (content: string) => createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);

const EXTENSIONS = [".md", ".txt", ".json", ".jsonl"];
// Names a memory write may not use for any part of its path, as in Claude Code: folders other tools
// run or load files from.
const RESERVED = new Set([
  ".git",
  "hooks",
  ".husky",
  ".githooks",
  "node_modules",
  ".vscode",
  ".idea",
  "head",
  "config",
  "objects",
  "refs",
  ".claude",
  "skills",
  "commands",
  "agents",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);

/** A path part as Claude Code compares it with RESERVED: folded case, no stream, no trailing dots. */
function folded(part: string): string {
  const lower = part
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u017f/g, "s");
  return (
    lower
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .replace(/:.*$/, "")
      .replace(/[. ]+$/, "") || lower
  );
}
// Characters a memory path may not hold, as in Claude Code: controls, format and unassigned
// characters, private use, surrogates, default-ignorables, line and paragraph separators, backslash.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029\\]/u;

/** A path as the tools take it: absolute within the store, with no doubled slashes. */
export const storePath = (path: string) => (path.startsWith("/") ? path : `/${path}`).replace(/\/{2,}/g, "/");

const quote = (text: string) => JSON.stringify(text);

/** Why a path can't be used, in Claude Code's words, or null when it can. */
export function pathProblem(path: string, { forList = false, forWrite = false } = {}): string | null {
  if (!path.startsWith("/")) return `Memory paths are absolute and start with "/" — use ${quote(storePath(path))}.`;
  const trimmed = forList && path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.slice(1) === "" ? [] : trimmed.slice(1).split("/");
  const ok =
    Buffer.byteLength(path, "utf8") <= 1024 &&
    !UNSAFE.test(path) &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    (!forWrite || parts.every((part) => !RESERVED.has(folded(part)))) &&
    (forList
      ? parts.every((part) => !part.startsWith("."))
      : parts.length > 0 &&
        parts.every((part) => !part.startsWith(".")) &&
        EXTENSIONS.some((ext) => parts.at(-1)!.endsWith(ext)));
  if (ok) return null;
  const reserved = forWrite
    ? " and are not reserved names (skills, commands, agents, hooks, and similar — creating or changing documents there is blocked, though existing ones can be read and listed)"
    : "";
  return `${quote(path)} is not a valid memory path: use at most 1024 bytes, folder segments that do not start with "."${reserved}, a filename ending in .md, .txt, .json, or .jsonl, and no control characters or backslashes.`;
}

/**
 * Content as memory_write saves it: LF line endings, invisible and format characters dropped, and
 * other control characters (but tab and newline) replaced with U+FFFD.
 */
export function clean(content: string): string {
  return content
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/[\p{Cc}]/gu, (c) => (c === "\n" || c === "\t" ? c : "�"));
}

// ---------------------------------------------------------------- the store

export class Store extends Context.Service<
  Store,
  {
    /** The memory folder for a session started in `cwd`, ending in a separator as Claude Code shows it. */
    readonly dirFor: (cwd: string) => Effect.Effect<string>;
    /** Make the store folder, as Claude Code does at the start of a session. */
    readonly ensure: (dir: string) => Effect.Effect<void>;
    /** The document a store path names, or null when there is none. */
    readonly read: (dir: string, path: string) => Effect.Effect<Doc | null, MemoryError>;
    /** Every document in the store under `prefix` (a folder path ending in "/"), sorted by path. */
    readonly list: (dir: string, prefix?: string) => Effect.Effect<ReadonlyArray<Entry>, MemoryError>;
    /** Write a document whole: to a temporary file beside it, then renamed over it. */
    readonly write: (dir: string, path: string, content: string) => Effect.Effect<void, MemoryError>;
  }
>()("auto-memory/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const { root } = yield* MemoryConfig;

      // The native call gives the on-disk case on a case-insensitive disk, as the folder Claude Code
      // keys by; FileSystem's realPath walks the path in JavaScript and keeps the case it was given.
      const real = (path: string) => Effect.try(() => realpathSync.native(path)).pipe(Effect.orElseSucceed(() => path));
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));

      // The folder a session's memory belongs to: the main working tree of the Git repository holding
      // `cwd` (a linked worktree's main one), else `cwd` itself, as real paths.
      const projectBase = Effect.fn("Store.projectBase")(function* (cwd: string) {
        const start = yield* real(paths.resolve(cwd));
        for (let dir = start; ; dir = paths.dirname(dir)) {
          const dotGit = paths.join(dir, ".git");
          const info = yield* fs.lstat(dotGit).pipe(Effect.option);
          if (Option.isNone(info)) {
            if (paths.dirname(dir) === dir) return start;
            continue;
          }
          if (info.value.type === "Directory") return dir;
          // A linked worktree or a submodule: .git is a file naming the Git directory. A worktree's Git
          // directory has a commondir file leading to the repository's own: the main working tree's
          // .git, or a bare repository, which Claude Code takes as the project itself.
          return yield* Effect.gen(function* () {
            const gitdir = /^gitdir:\s*(.+)$/m.exec(yield* fs.readFileString(dotGit))?.[1]?.trim();
            if (!gitdir) return dir;
            const gitDir = paths.resolve(dir, gitdir);
            const common = (yield* fs.readFileString(paths.join(gitDir, "commondir"))).trim();
            const commonDir = yield* real(paths.resolve(gitDir, common));
            return paths.basename(commonDir) === ".git" ? paths.dirname(commonDir) : commonDir;
          }).pipe(Effect.orElseSucceed(() => dir));
        }
      });

      // The deepest folder or file on the way to `path` that exists.
      const existing = Effect.fn("Store.existing")(function* (path: string) {
        let probe = path;
        while (!(yield* exists(probe)) && paths.dirname(probe) !== probe) probe = paths.dirname(probe);
        return probe;
      });

      // `path` with its existing part resolved through links, and the rest as given.
      const realFrom = Effect.fn("Store.realFrom")(function* (path: string) {
        const found = yield* existing(path);
        return found === path ? yield* real(path) : paths.join(yield* real(found), path.slice(found.length));
      });

      // The file a store path names, refusing one that leaves the store through `..` or a link.
      const fileOf = Effect.fn("Store.fileOf")(function* (dir: string, path: string) {
        const file = paths.join(dir, ...path.slice(1).split("/"));
        const store = dir.replace(/[/\\]+$/, "");
        const base = yield* realFrom(store);
        // The deepest part of the path that exists must resolve inside the store, unless that is a
        // folder above a store that doesn't exist yet, which holds no links.
        const found = yield* existing(file);
        const above = found !== store && (store + paths.sep).startsWith(found.replace(/[/\\]+$/, "") + paths.sep);
        const resolved = yield* real(found);
        if (!above && resolved !== base && !resolved.startsWith(base + paths.sep))
          return yield* new MemoryError({ message: `${quote(path)} leads outside the memory store` });
        return file;
      });

      const stamp = (info: FileSystem.File.Info) => Option.getOrElse(info.mtime, () => new Date(0)).toISOString();

      const read = Effect.fn("Store.read")(function* (dir: string, path: string) {
        const file = yield* fileOf(dir, path);
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return null;
        // Decoded as Node's readFileSync does, keeping a byte order mark, so the version token matches
        // Claude Code's for a file someone saved with one.
        const bytes = yield* fs.readFile(file).pipe(Effect.mapError(memoryError));
        const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
        return { content, updatedAt: stamp(info.value), bytes: Number(info.value.size) } satisfies Doc;
      });

      const list = Effect.fn("Store.list")(function* (dir: string, prefix: string = "/") {
        const entries: Array<Entry> = [];
        const walk = (folder: string, at: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): Array<string> => []));
            for (const name of names) {
              if (name.startsWith(".")) continue;
              const file = paths.join(folder, name);
              const info = yield* fs.lstat(file).pipe(Effect.option);
              if (Option.isNone(info)) continue;
              const path = `${at}${name}`;
              if (info.value.type === "Directory") yield* walk(file, `${path}/`);
              else if (info.value.type === "File" && EXTENSIONS.some((ext) => name.endsWith(ext)))
                entries.push({ path, bytes: Number(info.value.size), updatedAt: stamp(info.value) });
            }
          });
        yield* walk(yield* fileOf(dir, prefix === "/" ? "/" : prefix.slice(0, -1)), prefix);
        return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      });

      const write = Effect.fn("Store.write")(function* (dir: string, path: string, content: string) {
        const file = yield* fileOf(dir, path);
        yield* fs.makeDirectory(paths.dirname(file), { recursive: true }).pipe(Effect.mapError(memoryError));
        // A folder on the way that is a file, or the reverse, can't hold the document.
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type !== "File")
          return yield* new MemoryError({ message: `${quote(path)} is a folder` });
        const temp = `${file}.tmp.${randomBytes(4).toString("hex")}`;
        yield* fs.writeFileString(temp, content, { flag: "wx" }).pipe(
          Effect.andThen(fs.rename(temp, file)),
          Effect.mapError(memoryError),
          // On a failure or a cancelled call, so no temporary file is left in the store.
          Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
        );
      });

      return Store.of({
        dirFor: (cwd) =>
          projectBase(cwd).pipe(
            Effect.map((base) => paths.join(root, "projects", sanitize(base), "memory") + paths.sep),
          ),
        ensure: (dir) => fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore),
        read,
        list,
        write,
      });
    }),
  );
}
