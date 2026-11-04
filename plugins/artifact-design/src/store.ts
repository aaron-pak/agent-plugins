// The artifacts folder: one folder per artifact, with index.json listing them, as the server keeps them.

import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "./config.ts";
import { localStamp } from "./drafts.ts";
import { ActionError, messageOf } from "./errors.ts";
import { expandUser, fileUri, partsBelow, resolvePath } from "./paths.ts";
import { pageTitle, publishedHere, unwrap } from "./publish.ts";

export type Entry = {
  source: string | null;
  version: number;
  created: string | null;
  page: "index.html" | "index.md";
  title?: string;
  updated?: string;
  description?: string | null;
  derived?: boolean; // the description was taken from the page, so the next publish takes it again
  icon?: string | null;
  sessions?: Array<string>; // the Claude Code sessions that published it, newest first
};
export type Index = Map<string, Entry>;

/** [published path, source path or null to remove] for each supporting file of a publish. */
export type FilePlan = ReadonlyArray<readonly [target: string, source: string | null]>;

// index.json as the server reads it: entries are kept as written, so a hand edit or an older build's
// fields survive, as long as each names its page.
const IndexFile = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.StructWithRest(Schema.Struct({ page: Schema.Literals(["index.html", "index.md"]) }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
);
const decodeIndex = Schema.decodeUnknownOption(IndexFile);

/** A value as Python's repr() shows it, for messages that quote what the caller passed. */
export function repr(value: unknown): string {
  if (typeof value !== "string") return value === null || value === undefined ? "None" : JSON.stringify(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/[\\\x00-\x1f\x7f-\xa0\xad\u2028\u2029]/g, (ch) => {
    const named: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    const code = ch.charCodeAt(0);
    return named[ch] ?? (code < 0x100 ? "\\x" : "\\u") + code.toString(16).padStart(code < 0x100 ? 2 : 4, "0");
  });
  return quote + (quote === "'" ? escaped.replaceAll("'", "\\'") : escaped) + quote;
}

/** An ISO time to the second, as the index keeps them: 2026-10-09T14:25:30+00:00. */
export function isoSeconds(date: Date): string {
  return date.toISOString().slice(0, 19) + "+00:00";
}

export function slugify(text: string): string {
  const ascii = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "artifact";
}

/** Whether an index key names a folder directly inside the store, so a hand-edited key can't reach outside it. */
const isSlug = (key: string): boolean => key !== "" && key !== "." && key !== ".." && !/[\\/\0]/.test(key);

/** Decode the %XX escapes that make UTF-8, and leave any others as they are. */
function unquote(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// A publish holds the lock for well under a second; one older than this was left by a publish that died.
const LOCK_STALE_MS = 30_000;

/** Whether a process with this pid is running (signal 0 tests without sending anything). */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export class Store extends Context.Service<
  Store,
  {
    /** The artifacts folder. */
    readonly path: string;
    /** The index, and a note when it had to be rebuilt. An unreadable index.json is rebuilt from the
     * folders; with repair (under the lock, before a write) it is first moved aside, and the note says so. */
    load(repair?: boolean): Effect.Effect<readonly [Index, string | null]>;
    save(index: Index): Effect.Effect<void, ActionError>;
    /** Run an effect holding the folder's lock, so publishes from several sessions don't drop index entries. */
    withLock<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ActionError, R>;
    /** Resolve a link (percent-encoded or not), a folder or page path, or a slug to its index entry. */
    find(url: unknown, index: Index): Effect.Effect<readonly [string, Entry] | null>;
    /** A path the caller gave, which must be absolute: the server's working directory is not the caller's. */
    absolute(value: unknown, name: string): Effect.Effect<string, ActionError>;
    /** For a file inside an artifact's folder: its slug, and whether the file is its page or a saved version. */
    pageOf(source: string, index: Index): readonly [string | null, boolean];
    /** The supporting files to write, each checked before anything is written. */
    planFiles(files: unknown, folder: string, pageDir: string, pageName: string): Effect.Effect<FilePlan, ActionError>;
    applyFiles(plan: FilePlan): Effect.Effect<void, ActionError>;
    /** Whether the artifact's folder holds anything besides its page and saved versions. */
    hasOtherFiles(folder: string, page: string): Effect.Effect<boolean>;
    linkOf(slug: string, entry: Entry): string;
    isFile(path: string): Effect.Effect<boolean>;
  }
>()("artifact-design/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const config = yield* ServerConfig;
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const store = config.store;
      const indexFile = paths.join(store, "index.json");
      const lockFile = paths.join(store, ".publish-lock");
      const resolve = (path: string) => resolvePath(path).pipe(Effect.provideContext(services));
      const failed = (error: { readonly message: string; readonly cause?: unknown }) =>
        new ActionError({ message: messageOf(error) });

      const typeOf = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((info) => info.type),
          Effect.orElseSucceed(() => null),
        );
      const isFile = (path: string) => Effect.map(typeOf(path), (type) => type === "File");
      const isDir = (path: string) => Effect.map(typeOf(path), (type) => type === "Directory");

      /** An index rebuilt from the artifact folders, for when index.json can't be read. */
      const rebuild = Effect.gen(function* () {
        const index: Index = new Map();
        if (!(yield* isDir(store))) return index;
        const names = (yield* fs.readDirectory(store).pipe(Effect.orElseSucceed(() => []))).sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const name of names) {
          const folder = paths.join(store, name);
          const page = (yield* isFile(paths.join(folder, "index.html")))
            ? "index.html"
            : (yield* isFile(paths.join(folder, "index.md")))
              ? "index.md"
              : null;
          if (name.startsWith(".") || !page) continue;
          const text = yield* fs.readFileString(paths.join(folder, page)).pipe(Effect.orElseSucceed(() => ""));
          if (page === "index.html" && !publishedHere(text)) continue; // not a page this server published
          const { content, description } = page === "index.html" ? unwrap(text) : { content: text, description: null };
          const versions = paths.join(folder, ".versions");
          const modified = yield* fs.stat(paths.join(folder, page)).pipe(
            Effect.map((info) => Option.getOrUndefined(info.mtime)),
            Effect.orElseSucceed(() => undefined),
          );
          const stamp = isoSeconds(modified ?? new Date(yield* Clock.currentTimeMillis));
          const count = (yield* isDir(versions))
            ? (yield* fs.readDirectory(versions).pipe(Effect.orElseSucceed(() => []))).length
            : 1;
          index.set(name, {
            source: null,
            version: Math.max(1, count),
            created: stamp,
            page,
            title: pageTitle(content) || name,
            updated: stamp,
            description,
            icon: null,
          });
        }
        return index;
      });

      const save = (index: Index) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(store, { recursive: true });
          const temp = paths.join(store, `index.${process.pid}.tmp`);
          yield* fs.writeFileString(temp, JSON.stringify(Object.fromEntries(index), null, 2));
          yield* fs.rename(temp, indexFile);
        }).pipe(Effect.mapError(failed));

      const load = (repair = false) =>
        Effect.gen(function* () {
          const read = yield* fs.readFile(indexFile).pipe(Effect.result);
          if (read._tag === "Failure" && read.failure.reason._tag === "NotFound") {
            return [yield* rebuild, null] as const;
          }
          if (read._tag === "Success") {
            const text = decodeUtf8(read.success);
            const decoded = text === null ? Option.none() : decodeIndex(text);
            if (Option.isSome(decoded) && Object.keys(decoded.value).every(isSlug)) {
              return [new Map(Object.entries(decoded.value) as Array<[string, Entry]>), null] as const;
            }
          }
          const index = yield* rebuild;
          if (!repair) return [index, null] as const;
          const backup = paths.join(
            store,
            `index.json.corrupt-${localStamp(new Date(yield* Clock.currentTimeMillis))}`,
          );
          const note = yield* Effect.gen(function* () {
            yield* fs.rename(indexFile, backup);
            // Put the old file back rather than leave no index at all.
            yield* save(index).pipe(Effect.tapError(() => fs.rename(backup, indexFile).pipe(Effect.ignore)));
            return (
              `The artifacts index (${indexFile}) could not be read; it was moved to ${paths.basename(backup)} and ` +
              "rebuilt from the artifact folders, which keep their pages but not their source files."
            );
          }).pipe(Effect.orElseSucceed(() => null));
          return [index, note] as const;
        });

      /** The lock file as it is now (inode, modification time and the pid in it), or null when there is none. */
      const lockState = Effect.gen(function* () {
        const info = yield* fs.stat(lockFile);
        const text = yield* fs.readFileString(lockFile);
        const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
        const now = yield* Clock.currentTimeMillis;
        return { id: `${Option.getOrUndefined(info.ino)}:${mtime}:${text}`, age: now - mtime, pid: Number(text) };
      }).pipe(Effect.orElseSucceed(() => null)); // removed meanwhile; the next try takes it

      /** Whether the lock was left by a process that is gone, or is too old (or, by a clock that moved, too new) to be live. */
      const isStale = ({ age, pid }: { age: number; pid: number }) =>
        Math.abs(age) > LOCK_STALE_MS || (pid ? !isRunning(pid) : age > 1000); // no pid: still being written

      const take: Effect.Effect<void, ActionError> = Effect.gen(function* () {
        yield* fs.makeDirectory(store, { recursive: true }).pipe(Effect.mapError(failed));
        for (;;) {
          const taken = yield* fs.writeFileString(lockFile, String(process.pid), { flag: "wx" }).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
            Effect.mapError(failed),
          );
          if (taken) return;
          // Remove a stale lock only while it is still the one judged stale: another waiter may have
          // removed it and taken the lock in between, and that lock is live.
          const lock = yield* lockState;
          if (lock && isStale(lock) && (yield* lockState)?.id === lock.id) {
            yield* fs.remove(lockFile, { force: true }).pipe(Effect.ignore);
          } else {
            // Waits without blocking, so other calls are answered meanwhile. take runs as acquire, which
            // can't be interrupted, so the wait opts back in: a shutdown needn't wait for the lock.
            yield* Effect.interruptible(Effect.sleep("50 millis"));
          }
        }
      });

      const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          take,
          () => effect,
          () => fs.remove(lockFile, { force: true }).pipe(Effect.ignore),
        );

      const linkOf = (slug: string, entry: Entry) => fileUri(paths.join(store, slug, entry.page), config.platform);

      const find = (url: unknown, index: Index) =>
        Effect.gen(function* () {
          let text = typeof url === "string" ? url.trim() : "";
          if (!text) return null;
          const direct = index.get(text);
          if (direct) return [text, direct] as const;
          if (/^file:/i.test(text)) {
            const local = text;
            text = yield* Effect.try(() => new URL(local)).pipe(
              Effect.flatMap(paths.fromFileUrl),
              Effect.orElseSucceed(() => unquote(local.replace(/^file:(\/\/[^/]*)?/i, ""))),
            );
          }
          let path = expandUser(text, config.home);
          path = yield* resolve(paths.isAbsolute(path) ? path : paths.join(store, path));
          if (paths.basename(path) === "index.html" || paths.basename(path) === "index.md") path = paths.dirname(path);
          const slug = paths.basename(path);
          const entry = index.get(slug);
          return paths.dirname(path) === store && entry ? ([slug, entry] as const) : null;
        }).pipe(Effect.orElseSucceed(() => null)); // a link that isn't a URL

      const absolute = (value: unknown, name: string) => {
        const path = expandUser(String(value), config.home);
        if (!paths.isAbsolute(path)) {
          return Effect.fail(
            new ActionError({
              message:
                `${name} ${repr(String(value))} is relative: pass an absolute path; this server runs in ` +
                `${config.cwd}, not your workspace`,
            }),
          );
        }
        return resolve(path);
      };

      const pageOf = (source: string, index: Index) => {
        const parts = partsBelow(paths, store, source);
        const entry = parts && parts.length >= 2 ? index.get(parts[0]!) : undefined;
        if (!parts || !entry) return [null, false] as const;
        return [parts[0]!, (parts.length === 2 && parts[1] === entry.page) || parts[1] === ".versions"] as const;
      };

      const planFiles = (files: unknown, folder: string, pageDir: string, pageName: string) =>
        Effect.gen(function* () {
          const refuse = (message: string) => Effect.fail(new ActionError({ message }));
          if (!files || (typeof files === "object" && Object.keys(files).length === 0)) return [];
          const pairs: Array<[string, string | null]> = [];
          const isList = Array.isArray(files);
          if (isList) {
            for (const item of files as Array<unknown>) {
              const spelled = item && typeof item === "object" ? (item as { path?: unknown }).path : item;
              if (typeof spelled !== "string" || !spelled) {
                return yield* refuse(
                  `files: each list entry is a path relative to the page's folder, not ${repr(item)}`,
                );
              }
              pairs.push([spelled, paths.join(pageDir, spelled)]);
            }
          } else if (typeof files === "object") {
            for (const [published, value] of Object.entries(files as Record<string, unknown>)) {
              let origin = value;
              if (origin && typeof origin === "object" && !Array.isArray(origin)) {
                origin = (origin as { from?: unknown }).from;
                if (typeof origin !== "string") {
                  return yield* refuse(
                    `files[${repr(published)}]: give the source as "/absolute/path" or {"from": "/absolute/path"}`,
                  );
                }
              } else if (origin !== null && typeof origin !== "string") {
                return yield* refuse(
                  `files[${repr(published)}]: the source must be a path, an object with \`from\`, or null`,
                );
              }
              pairs.push([published, origin]);
            }
          } else {
            return yield* refuse(
              'files maps published paths to source files ({"img/a.png": "/abs/a.png"}), or lists paths relative to the page',
            );
          }
          const root = yield* resolve(folder);
          const plan: Array<readonly [string, string | null]> = [];
          for (const [published, origin] of pairs) {
            if (published.startsWith("/") || published.startsWith("\\") || /^[A-Za-z]:/.test(published)) {
              return yield* refuse(
                `supporting file path ${repr(published)} must be relative, with no leading slash` +
                  (isList
                    ? "; a list names files by their path relative to the page's folder, and a file " +
                      'elsewhere goes in the map form, {"published/path": "/absolute/source"}'
                    : ""),
              );
            }
            const target = yield* resolve(paths.join(folder, published));
            const parts = partsBelow(paths, root, target);
            if (!parts) return yield* refuse(`supporting file path ${repr(published)} must stay inside the artifact`);
            const rel = parts.join("/");
            if ([pageName, "index.html", "index.md", ".versions"].includes(rel) || rel.startsWith(".versions/")) {
              return yield* refuse(
                `supporting file path ${repr(published)} is the artifact's own page; pick another name`,
              );
            }
            let blocked = yield* isDir(target);
            for (
              let parent = paths.dirname(target);
              !blocked && partsBelow(paths, root, parent);
              parent = paths.dirname(parent)
            ) {
              blocked = yield* isFile(parent);
            }
            if (blocked) {
              return yield* refuse(
                `supporting file path ${repr(published)} collides with a folder or file already in the ` +
                  "artifact; pick another path, or remove the old one with null first",
              );
            }
            if (origin === null) {
              plan.push([target, null]);
              continue;
            }
            const link = yield* fs.lstat(target).pipe(
              Effect.map((info) => info.type === "SymbolicLink"),
              Effect.orElseSucceed(() => false),
            );
            if (link) {
              return yield* refuse(
                `supporting file path ${repr(published)} is a link to a file that doesn't exist; remove it with null first`,
              );
            }
            const source = yield* absolute(origin, `files[${repr(published)}]`);
            if (!(yield* isFile(source))) {
              return yield* refuse(`supporting file ${source} doesn't exist; nothing was published`);
            }
            plan.push([target, source]);
          }
          return plan;
        });

      const applyFiles = (plan: FilePlan) =>
        Effect.forEach(
          plan,
          ([target, origin]) =>
            origin === null
              ? fs.remove(target, { force: true })
              : fs
                  .makeDirectory(paths.dirname(target), { recursive: true })
                  .pipe(Effect.andThen(fs.copyFile(origin, target))),
          { discard: true },
        ).pipe(Effect.mapError(failed));

      const hasOtherFiles = (folder: string, page: string) =>
        fs.readDirectory(folder).pipe(
          Effect.map((names) => names.some((name) => name !== ".versions" && paths.join(folder, name) !== page)),
          Effect.orElseSucceed(() => false),
        );

      return Store.of({
        path: store,
        load,
        save,
        withLock,
        find,
        absolute,
        pageOf,
        planFiles,
        applyFiles,
        hasOtherFiles,
        linkOf,
        isFile,
      });
    }),
  );
}

/** Bytes as UTF-8 text, or null when they aren't valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
