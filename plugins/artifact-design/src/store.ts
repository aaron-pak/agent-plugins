// The artifacts folder: one folder per artifact, with index.json listing them, as the server keeps them.

import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { localStamp } from "./drafts.ts";
import { expandUser, fileUri, partsBelow, resolvePath } from "./paths.ts";
import { pageTitle, publishedHere, unwrap } from "./publish.ts";

export type Entry = {
  source: string | null;
  version: number;
  created: string | null;
  page: string;
  title?: string;
  updated?: string;
  description?: string | null;
  icon?: string | null;
};
export type Index = Map<string, Entry>;

// Resolved once at startup, so a relative ARTIFACTS_DIR means the folder the server started in.
export const STORE = resolvePath(process.env.ARTIFACTS_DIR || join(homedir(), "artifacts"));
export const INDEX = join(STORE, "index.json");

/** A value as Python's repr() shows it, for messages that quote what the caller passed. */
export function repr(value: unknown): string {
  if (typeof value !== "string") return value === null || value === undefined ? "None" : JSON.stringify(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/[\\\x00-\x1f\x7f-\xa0\xad\u2028\u2029]/g, (ch) => {
    const named: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    return (
      named[ch] ??
      (ch.charCodeAt(0) < 0x100 ? "\\x" : "\\u") +
        ch
          .charCodeAt(0)
          .toString(16)
          .padStart(ch.charCodeAt(0) < 0x100 ? 2 : 4, "0")
    );
  });
  return quote + (quote === "'" ? escaped.replaceAll("'", "\\'") : escaped) + quote;
}

/** An ISO time to the second, as the index keeps them: 2026-10-09T14:25:30+00:00. */
export function isoSeconds(date: Date): string {
  return date.toISOString().slice(0, 19) + "+00:00";
}

/** An index rebuilt from the artifact folders, for when index.json can't be read. */
function rebuildIndex(): Index {
  const index: Index = new Map();
  if (!isDir(STORE)) return index;
  for (const name of readdirSync(STORE).sort()) {
    const folder = join(STORE, name);
    const page = ["index.html", "index.md"].find((file) => isFile(join(folder, file)));
    if (name.startsWith(".") || !page) continue;
    const text = readFileSync(join(folder, page), "utf8");
    if (page === "index.html" && !publishedHere(text)) continue; // not a page this server published
    const { content, description } = page === "index.html" ? unwrap(text) : { content: text, description: null };
    const versions = join(folder, ".versions");
    const stamp = isoSeconds(statSync(join(folder, page)).mtime);
    const count = isDir(versions) ? readdirSync(versions).length : 1;
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
}

/** The index, and a note when it had to be rebuilt. An unreadable index.json is rebuilt from the
 * folders; with repair (under the store lock, before a write) it is first moved aside, and the note says so. */
export function loadIndex(repair = false): [Index, string | null] {
  let text: string | null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(INDEX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [rebuildIndex(), null];
    text = null;
  }
  try {
    const parsed: unknown = text !== null ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (
        entries.every(
          ([slug, entry]) =>
            isSlug(slug) && !!entry && typeof entry === "object" && !Array.isArray(entry) && "page" in entry,
        )
      ) {
        return [new Map(entries as [string, Entry][]), null];
      }
    }
  } catch {
    // not JSON
  }
  let note: string | null = null;
  const index = rebuildIndex();
  if (repair) {
    const backup = join(STORE, `index.json.corrupt-${localStamp()}`);
    try {
      renameSync(INDEX, backup);
      try {
        saveIndex(index);
      } catch (error) {
        renameSync(backup, INDEX); // keep the old file where it was rather than leave no index at all
        throw error;
      }
      note =
        `The artifacts index (${INDEX}) could not be read; it was moved to ${basename(backup)} and ` +
        "rebuilt from the artifact folders, which keep their pages but not their source files.";
    } catch {
      // left as it was
    }
  }
  return [index, note];
}

/** Whether an index key names a folder directly inside the store, so a hand-edited key can't reach outside it. */
function isSlug(key: string): boolean {
  return key !== "" && key !== "." && key !== ".." && !/[\\/\0]/.test(key);
}

export function saveIndex(index: Index): void {
  mkdirSync(STORE, { recursive: true });
  const tmp = join(STORE, `index.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(index), null, 2));
  renameSync(tmp, INDEX);
}

const LOCK = join(STORE, ".publish-lock");
// A publish holds the lock for well under a second; one older than this was left by a publish that died.
const LOCK_STALE_MS = 30_000;

/** The lock file as it is now (inode, modification time and the pid in it), or null when there is none. */
function lockState(): { id: string; age: number; pid: number } | null {
  try {
    const stat = statSync(LOCK);
    const text = readFileSync(LOCK, "utf8");
    return { id: `${stat.ino}:${stat.mtimeMs}:${text}`, age: Date.now() - stat.mtimeMs, pid: Number(text) };
  } catch {
    return null; // removed meanwhile; the next try takes it
  }
}

/** Whether the lock was left by a process that is gone, or is too old (or, by a clock that moved, too new) to be live. */
function isStale({ age, pid }: { age: number; pid: number }): boolean {
  if (Math.abs(age) > LOCK_STALE_MS) return true;
  if (!pid) return age > 1000; // still being written, or not a lock this server wrote
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Run fn holding the artifacts folder's lock, so publishes from several sessions don't drop index entries.
 * It waits without blocking, so the server keeps answering other calls meanwhile. */
export async function withStoreLock<T>(fn: () => T): Promise<T> {
  mkdirSync(STORE, { recursive: true });
  for (;;) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Remove a stale lock only while it is still the one judged stale: another waiter may have
      // removed it and taken the lock in between, and that lock is live.
      const lock = lockState();
      if (lock && isStale(lock) && lockState()?.id === lock.id) rmSync(LOCK, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK, { force: true });
  }
}

export function slugify(text: string): string {
  const ascii = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "artifact";
}

export function linkOf(slug: string, entry: Entry): string {
  return fileUri(join(STORE, slug, entry.page));
}

/** Resolve a link (percent-encoded or not), a folder or page path, or a slug to its index entry. */
export function find(url: unknown, index: Index): [string, Entry] | [null, null] {
  let text = typeof url === "string" ? url.trim() : "";
  if (!text) return [null, null];
  const direct = index.get(text);
  if (direct) return [text, direct];
  if (/^file:/i.test(text)) {
    try {
      text = fileURLToPath(new URL(text));
    } catch {
      text = unquote(text.replace(/^file:(\/\/[^/]*)?/i, ""));
    }
  }
  let path = expandUser(text);
  path = isAbsolute(path) ? path : join(STORE, path);
  path = resolvePath(path);
  if (basename(path) === "index.html" || basename(path) === "index.md") path = dirname(path);
  const slug = basename(path);
  const entry = index.get(slug);
  return dirname(path) === STORE && entry ? [slug, entry] : [null, null];
}

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

/** A path the caller gave, which must be absolute: the server's working directory is not the caller's. */
export function absolute(value: unknown, name: string): string {
  const path = expandUser(String(value));
  if (!isAbsolute(path)) {
    throw new Error(
      `${name} ${repr(String(value))} is relative: pass an absolute path; this server runs in ${process.cwd()}, not your workspace`,
    );
  }
  return resolvePath(path);
}

/** For a file inside an artifact's folder: the artifact's slug, and whether the file is that artifact's page or a saved version. */
export function storePageOf(source: string, index: Index): [string | null, boolean] {
  const parts = partsBelow(STORE, source);
  if (!parts || parts.length < 2 || !index.has(parts[0]!)) return [null, false];
  const own = (parts.length === 2 && parts[1] === index.get(parts[0]!)!.page) || parts[1] === ".versions";
  return [parts[0]!, own];
}

/** The supporting files to write, each checked before anything is written: [target, source, or null to remove]. */
export function planFiles(
  files: unknown,
  folder: string,
  pageDir: string,
  pageName: string,
): [string, string | null][] {
  if (!files || (typeof files === "object" && !Array.isArray(files) && Object.keys(files).length === 0)) return [];
  if (Array.isArray(files) && files.length === 0) return [];
  const pairs: [string, string | null][] = [];
  const isList = Array.isArray(files);
  if (isList) {
    for (const item of files) {
      const spelled = item && typeof item === "object" ? (item as { path?: unknown }).path : item;
      if (typeof spelled !== "string" || !spelled) {
        throw new Error(`files: each list entry is a path relative to the page's folder, not ${repr(item)}`);
      }
      pairs.push([spelled, join(pageDir, spelled)]);
    }
  } else if (typeof files === "object") {
    for (const [published, value] of Object.entries(files as Record<string, unknown>)) {
      let origin = value;
      if (origin && typeof origin === "object" && !Array.isArray(origin)) {
        origin = (origin as { from?: unknown }).from;
        if (typeof origin !== "string") {
          throw new Error(
            `files[${repr(published)}]: give the source as "/absolute/path" or {"from": "/absolute/path"}`,
          );
        }
      } else if (origin !== null && typeof origin !== "string") {
        throw new Error(`files[${repr(published)}]: the source must be a path, an object with \`from\`, or null`);
      }
      pairs.push([published, origin as string | null]);
    }
  } else {
    throw new Error(
      'files maps published paths to source files ({"img/a.png": "/abs/a.png"}), or lists paths relative to the page',
    );
  }
  const root = resolvePath(folder);
  const plan: [string, string | null][] = [];
  for (const [published, origin] of pairs) {
    if (published.startsWith("/") || published.startsWith("\\") || /^[A-Za-z]:/.test(published)) {
      throw new Error(
        `supporting file path ${repr(published)} must be relative, with no leading slash` +
          (isList
            ? "; a list names files by their path relative to the page's folder, and a file " +
              'elsewhere goes in the map form, {"published/path": "/absolute/source"}'
            : ""),
      );
    }
    const target = resolvePath(join(folder, published));
    const parts = partsBelow(root, target);
    if (!parts) throw new Error(`supporting file path ${repr(published)} must stay inside the artifact`);
    const rel = parts.join("/");
    if ([pageName, "index.html", "index.md", ".versions"].includes(rel) || rel.startsWith(".versions/")) {
      throw new Error(`supporting file path ${repr(published)} is the artifact's own page; pick another name`);
    }
    let blocked = isDir(target);
    for (let parent = dirname(target); !blocked && partsBelow(root, parent); parent = dirname(parent)) {
      blocked = isFile(parent);
    }
    if (blocked) {
      throw new Error(
        `supporting file path ${repr(published)} collides with a folder or file already in the ` +
          "artifact; pick another path, or remove the old one with null first",
      );
    }
    if (origin === null) {
      plan.push([target, null]);
      continue;
    }
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(
        `supporting file path ${repr(published)} is a link to a file that doesn't exist; remove it with null first`,
      );
    }
    const source = absolute(origin, `files[${repr(published)}]`);
    if (!isFile(source)) {
      throw new Error(`supporting file ${source} doesn't exist; nothing was published`);
    }
    plan.push([target, source]);
  }
  return plan;
}

/** Write the planned supporting files into the artifact's folder. */
export function applyFiles(plan: [string, string | null][]): void {
  for (const [target, origin] of plan) {
    if (origin === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(origin, target);
  }
}

/** Whether the artifact's folder holds anything besides its page and saved versions. */
export function hasOtherFiles(folder: string, page: string): boolean {
  return readdirSync(folder).some((name) => name !== ".versions" && join(folder, name) !== page);
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
