// An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.
//
// It exposes `Artifact`, with the claude.ai tool's actions that make sense on a local machine,
// and, where preview can run, `ArtifactCheck`:
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
//   widths and themes given), as Claude Code's ArtifactCheck does, and returns the captures and what breaks (scripts/preview.mjs). The
//   tool is listed only when Playwright and a Chromium are found at startup, and ARTIFACT_PREVIEW=0
//   leaves it out. Claude Code's ArtifactCheck also has verify, which reads what claude.ai viewers'
//   browsers reported; there is nothing like it here.
//
// Codex strips every description from an input schema over 5,000 bytes, so a Codex client gets a
// compact tool whose text fits and points to quickstart for the rest.
//
// Speaks MCP over stdio, both the 2026-07-28 revision and the earlier ones, with the MCP SDK.
// scripts/build.ts bundles it into mcp/server.mjs, which runs on Node.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLIENT_INFO_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { escape } from "./html.ts";
import {
  FULL_DOCUMENT_NOTE,
  GENERATOR,
  OWN_FILES_FETCH_NOTE,
  SIZE_LIMIT,
  fetchesOwnFiles,
  isFullDocument,
  markdownPage,
  openInBrowser,
  opener,
  pageDescription,
  pageTitle,
  readSource,
  unwrap,
  wrap,
} from "./publish.ts";
import { DRAFTS_ROOT, draftsRootIsOwn, makeDrafts } from "./drafts.ts";
import { partsBelow } from "./paths.ts";
import { applyEdits, editsOf, missMessage, savedMessage, type Edit } from "./edits.ts";
import {
  STORE,
  absolute,
  applyFiles,
  find,
  hasOtherFiles,
  isFile,
  isoSeconds,
  linkOf,
  loadIndex,
  planFiles,
  repr,
  saveIndex,
  slugify,
  storePageOf,
  withStoreLock,
  type Entry,
} from "./store.ts";
import { INSTRUCTIONS, checkTool, isCodex, tool, unknownParameter, type Setting } from "./tool.ts";

// Anything printed goes to stderr: stdout carries only protocol messages.
console.log = console.info = console.debug = console.error;

// The server reads the bundled artifact-design skill's text and scripts, so there is one copy of each.
// Both this file and the bundle (mcp/server.mjs) sit one folder below the plugin's root.
const SKILL_DIR = fileURLToPath(new URL("../skills/artifact-design/", import.meta.url));
const GUIDANCE = join(SKILL_DIR, "SKILL.md");
const SCRIPTS = join(SKILL_DIR, "scripts");

const DRAFTS = makeDrafts();
const OPEN_PAGES = (process.env.ARTIFACT_OPEN ?? "1") !== "0";
const CAN_OPEN = opener() !== null;
const PREVIEW_SWITCH = (process.env.ARTIFACT_PREVIEW ?? "1") !== "0";
const STARTED = Date.now();
const PREVIEW_WAIT = 10_000; // how long tools/list waits for the startup preview check
const SETTING: Setting = { store: STORE, drafts: DRAFTS, opens: OPEN_PAGES && CAN_OPEN };

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Run a script with this runtime, as preview.mjs expects, and collect its output. */
function runScript(args: string[], timeout: number): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        done({
          code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
          stdout,
          stderr: failure && !stderr ? failure.message : stderr,
          timedOut: !!failure?.killed,
        });
      },
    ).stdin?.end();
  });
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).at(-1) ?? "";

// ---------------------------------------------------------------- preview availability

const PREVIEW = { ok: false, reason: "the preview check has not finished", checked: false };

// The last check's answer, kept in this user's own drafts folder so that tools/list can answer at
// once instead of making Claude Code start its first turn without the tool. Each setup (runtime,
// search path, Playwright's browser folder and preview.mjs) keeps its own answer; a setup with none
// yet (after an update to the plugin, say) takes the newest one, and this start's check adds its own
// for the next start.
const previewKey = (() => {
  try {
    const script = statSync(join(SCRIPTS, "preview.mjs"));
    return JSON.stringify([
      process.execPath,
      process.env.PATH ?? "",
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
      script.size,
      script.mtimeMs,
    ]);
  } catch {
    return null;
  }
})();
const PREVIEW_CACHE =
  previewKey === null
    ? null
    : join(DRAFTS_ROOT, `preview-${createHash("sha256").update(previewKey).digest("hex").slice(0, 16)}.json`);
const isPreviewCache = (name: string) => /^preview-[0-9a-f]{16}\.json$/.test(name);

/** A cached answer: a regular file of this user's in their own drafts folder, or null. */
function readCached(path: string): { ok: boolean; mtimeMs: number } | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return null;
    const cached = JSON.parse(readFileSync(path, "utf8")) as { ok?: unknown };
    return typeof cached.ok === "boolean" ? { ok: cached.ok, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

const CACHED = ((): { ok: boolean; current: boolean } | null => {
  if (!PREVIEW_SWITCH || PREVIEW_CACHE === null || !draftsRootIsOwn()) return null;
  const own = readCached(PREVIEW_CACHE);
  if (own) return { ok: own.ok, current: true };
  let newest: { ok: boolean; mtimeMs: number } | null = null;
  try {
    for (const name of readdirSync(DRAFTS_ROOT)) {
      if (!isPreviewCache(name)) continue;
      const cached = readCached(join(DRAFTS_ROOT, name));
      if (cached && (!newest || cached.mtimeMs > newest.mtimeMs)) newest = cached;
    }
  } catch {
    return null;
  }
  return newest && { ok: newest.ok, current: false };
})();

/** Keep this start's answer for the next start, written whole, and drop answers no start has
 * written for a month, and temp files a crash left. */
function saveCached(ok: boolean): void {
  if (PREVIEW_CACHE === null || !draftsRootIsOwn()) return;
  try {
    const temp = `${PREVIEW_CACHE}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ok }), { mode: 0o600 });
    renameSync(temp, PREVIEW_CACHE);
    for (const name of readdirSync(DRAFTS_ROOT)) {
      const path = join(DRAFTS_ROOT, name);
      const age = Date.now() - lstatSync(path).mtimeMs;
      const leftover = /^preview-[0-9a-f]{16}\.json\.\d+\.tmp$/.test(name) && age > 86_400_000;
      if ((isPreviewCache(name) && age > 30 * 86_400_000) || leftover) rmSync(path, { force: true });
    }
  } catch {
    // the next start checks again
  }
}

/** Whether preview can run here: Playwright and a Chromium (preview.mjs --check). */
const previewCheck = (async () => {
  try {
    if (!PREVIEW_SWITCH) {
      Object.assign(PREVIEW, { ok: false, reason: "ARTIFACT_PREVIEW=0 turns preview off" });
      return;
    }
    const run = await runScript([join(SCRIPTS, "preview.mjs"), "--check"], 30_000);
    const found = JSON.parse(lastLine(run.stdout)) as { ok?: unknown; reason?: unknown };
    Object.assign(PREVIEW, { ok: !!found.ok, reason: found.reason ?? null });
    if (!PREVIEW.ok) console.error(`artifact: no preview here: ${String(PREVIEW.reason)}`);
    saveCached(PREVIEW.ok); // every start, so a setup still in use never ages out
  } catch (error) {
    Object.assign(PREVIEW, { ok: false, reason: `the preview check failed (${(error as Error).message})` });
  } finally {
    PREVIEW.checked = true;
  }
})();

/** Whether this start's own check found preview can run, waiting for it within PREVIEW_WAIT. */
async function previewReady(): Promise<boolean> {
  const wait = Math.max(0, STARTED + PREVIEW_WAIT - Date.now());
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([previewCheck, new Promise((done) => (timer = setTimeout(done, wait)))]);
  clearTimeout(timer);
  return PREVIEW.checked && PREVIEW.ok;
}

/** Whether the tool lists preview: the last check's answer when there is one, so the list comes
 * back at once and stays the same all session, and otherwise this start's own. A call to preview
 * always waits for this start's. */
async function previewOffered(): Promise<boolean> {
  return CACHED ? CACHED.ok : previewReady();
}

// ---------------------------------------------------------------- publishing

// The source files this server process published, and their artifacts: like the Artifact tool's
// per-session map, a path republished in this session updates its artifact. A session goes on past
// its server, though: a resumed one starts a new server, and Claude Code can switch sessions under a
// running one, so a republish also finds an artifact this session published before (see `ours`).
const SESSION_SOURCES = new Map<string, string>();
// Claude Code passes its session ID to the servers it starts, and a resumed session keeps it.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || null;
// How many sessions an artifact remembers, newest first, for when another one updates it with `url`.
const SESSIONS_KEPT = 8;

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Whether a publish of `source` continues the session that published `entry` before: the entry
 * lists this session's ID, or the file is in a drafts folder. Each server start makes its own drafts
 * folder, so a later server meets a file in one only when the conversation that wrote it goes on,
 * which covers Codex, where no session ID reaches the server, and a session switched to under a
 * running Claude Code server, which keeps the ID it started with. */
function ours(source: string, entry: Entry): boolean {
  if (SESSION_ID && entry.sessions?.includes(SESSION_ID)) return true;
  const roots = new Set([DRAFTS_ROOT, realOr(DRAFTS_ROOT)]);
  const paths = new Set([source, realOr(source)]);
  return [...roots].some((root) => [...paths].some((path) => (partsBelow(root, path)?.length ?? 0) >= 2));
}

// The tab icon: a letter on a dark tile, with its angle brackets percent-encoded so that nothing
// reading the page's head (the title rule stops at the first "<svg") takes it for markup.
const ICON_SVG =
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' " +
  "fill='%23141413'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='17' text-anchor='middle' " +
  "fill='%23faf9f5'%3E{letter}%3C/text%3E%3C/svg%3E";

function wrapPage(
  content: string,
  description: string | null,
  icon: string | null,
  lang: string | null,
  cover: boolean | null,
): string {
  const published = wrap(content, description, lang, cover);
  if (!icon) return published;
  const letter =
    icon
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 1)
      .toUpperCase() || "A";
  const link = `<link rel="icon" href="data:image/svg+xml,${ICON_SVG.replace("{letter}", letter)}">`;
  return published.replace(GENERATOR, () => GENERATOR + link);
}

type Args = Record<string, unknown>;
type Result = string | CallToolResult;

/** A refusal the tool returns as it is, without the "<action> failed:" prefix. */
class Refusal extends Error {}

// The most of a file a refused publish with edits shows back, so that the result stays under what
// Claude Code passes on from an MCP tool.
const MISS_ROOM = 40_000;

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

async function actQuickstart(client?: string): Promise<string> {
  const text = readFileSync(GUIDANCE, "utf8");
  const start = text.indexOf("## Page contract");
  if (start === -1) throw new Error(`${GUIDANCE} has no "## Page contract" section`);
  // Claude Code's quickstart leaves the empty dataviz callout's blank lines before "## Process".
  let guidance = text
    .slice(start)
    .trim()
    .replace("\n\n## Process", () => "\n\n\n\n## Process");
  // Name ArtifactCheck only where it is listed.
  if (!(PREVIEW_SWITCH && (await previewOffered()))) {
    guidance = guidance.replace(
      "one `ArtifactCheck` preview, or else one screenshot of the local file; if the session offers none of these, " +
        "skip the look. The preview renders desktop and phone widths in light and dark and lists overflow, colors " +
        "that ignore the theme, blocked loads and console errors, including a script that fails to parse, so nothing " +
        "it covers needs a check of your own.",
      () => "one screenshot of the local file; if the session offers no way, skip the look.",
    );
  }
  return (
    "For a plain page, the page-design guidance follows. It is the `artifact-design` skill's own " +
    "text, so do not load that skill as well. Write the page to a file and publish it in the same " +
    "message: the two calls run in order. Unless the person named a location, the file goes in " +
    `${DRAFTS}, not in the project. In this text, Claude means you.\n\n` +
    guidance +
    "\n\nWhen the page includes a diagram, also load the `artifact-diagramming` skill" +
    (isCodex(client) ? "" : " (`artifact-design:artifact-diagramming` in the Skill tool)") +
    " before writing it."
  );
}

function publish(args: Args): string {
  if (!args.file_path) throw new Error("publish needs file_path: write the page to a file first");
  const source = absolute(args.file_path, "file_path");
  if (!isFile(source)) throw new Error(`${source} doesn't exist; write the page there first`);
  let edits: Edit[] | null = null;
  if (args.edits !== undefined) {
    const parsed = editsOf(args.edits);
    if (typeof parsed === "string") throw new Refusal(`${parsed} Nothing was published.`);
    if (args.files !== undefined) {
      throw new Refusal(
        "`edits` changes only the file at `file_path`: not with `files` (publish the other files in a call " +
          "without edits). Nothing was published.",
      );
    }
    const below = partsBelow(STORE, source);
    if (below && below.length >= 2 && loadIndex()[0].has(below[0]!)) {
      throw new Refusal(
        `No edits were applied and nothing was published: ${source} is a file inside the published artifact ` +
          `${below[0]} in ${STORE}, and \`edits\` changes a page's source file. Publish the source file with edits instead, or ` +
          "edit this file and publish it without edits.",
      );
    }
    edits = parsed;
  }
  const bytes = readFileSync(source);
  let raw: string;
  try {
    raw = readSource(source, bytes);
  } catch (error) {
    if (edits) throw new Refusal(`No edits were applied: ${(error as Error).message}`);
    throw new Error(`file_path: ${(error as Error).message}`);
  }
  if (edits) {
    const applied = applyEdits(raw, edits);
    if (!applied.ok) throw new Refusal(missMessage(applied.miss, edits, raw, MISS_ROOM));
    raw = applied.text;
  }
  const [index, repaired] = loadIndex(true);
  const notes = repaired ? [repaired] : [];
  let slug: string | null = null;
  let entry: Entry | null = null;
  if (args.url) {
    [slug, entry] = find(args.url, index);
    if (!slug) throw new Error(`no published artifact has the link ${String(args.url)}; list them with action "list"`);
  } else {
    // A file inside an artifact's folder is that artifact's own page, edited in place: an update.
    const [inside, own] = storePageOf(source, index);
    if (inside && !own) {
      throw new Error(
        `${source} is a file inside the published artifact ${inside}; publish its source ` +
          `(${index.get(inside)!.source || "unknown"}) or copy the file out of ${STORE} first`,
      );
    }
    const known = SESSION_SOURCES.get(source);
    if (inside) {
      slug = inside;
      entry = index.get(inside)!;
      if (entry.source && entry.source !== source) {
        notes.push(
          "That file is the artifact's published page, so the artifact was updated in place; " +
            `its source file ${entry.source} doesn't have this change.`,
        );
      }
    } else if (known !== undefined && index.get(known)?.source === source) {
      slug = known;
      entry = index.get(known)!;
    } else {
      let earlier: [string, Entry] | null = null;
      for (const [other, otherEntry] of index) {
        if (otherEntry.source !== source) continue;
        if (!earlier || (otherEntry.updated || "") > (earlier[1].updated || "")) earlier = [other, otherEntry];
      }
      if (earlier && ours(source, earlier[1])) {
        [slug, entry] = earlier;
      } else if (earlier) {
        notes.push(
          `This path was published before as ${linkOf(...earlier)}, in an earlier session; ` +
            "that artifact is unchanged. Pass `url` to update that one instead.",
        );
      }
    }
  }

  const name = basename(source);
  const isMarkdown = [".md", ".markdown"].includes(extname(name).toLowerCase());
  let content: string;
  let title: string | null;
  let oldDescription: string | null = null;
  let lang: string | null = null;
  let cover: boolean | null = null;
  if (isMarkdown) {
    // Rendered into the document template the Artifact tool uses for Markdown, whose tab shows the
    // file name; like the Artifact tool's, the artifact keeps its file's name, or the one it has.
    [content] = markdownPage(raw, name);
    title = entry?.title || name;
  } else {
    ({ content, description: oldDescription, lang, cover } = unwrap(raw));
    if (cover === null && isFullDocument(content)) notes.push(FULL_DOCUMENT_NOTE);
    title = pageTitle(content);
    const asked = str(typeof args.title === "string" ? args.title.trim() : null);
    if (!title && asked) {
      title = asked;
      content = `<title>${escape(title)}</title>\n` + content;
    } else if (title && asked && title !== asked && title !== pageTitle(`<title>${asked}</title>`)) {
      const cut = (text: string) => ([...text].length > 120 ? `${[...text].slice(0, 120).join("")}\u2026` : text);
      notes.push(
        `The document's own <title> ("${cut(title)}") names this artifact; the \`title\` parameter ("${cut(asked)}") ` +
          "was not applied \u2014 the tag always wins. To rename, edit the <title> in the HTML.",
      );
    }
    if (!title) {
      notes.push(
        "The page has no <title> in its first 8KB (one after an <svg> doesn't count), so the " +
          "artifact is named after the file: put a <title> at the top, or pass `title`.",
      );
    }
  }
  // A description passed now or before stays; otherwise, as the Artifact tool does, each publish
  // takes one from the page again.
  const given = str(args.description) ?? (entry && !entry.derived ? entry.description || null : null) ?? oldDescription;
  const description = given ?? (isMarkdown ? null : pageDescription(content, basename(name, extname(name))) || null);
  const icon = str(args.icon) ?? (entry?.icon || null);
  if (fetchesOwnFiles(content)) notes.push(OWN_FILES_FETCH_NOTE);
  const published = wrapPage(content, description, icon, lang, cover);
  if (Buffer.byteLength(published, "utf8") > SIZE_LIMIT) {
    throw new Error("the page is over 16MB; shrink it or move data into supporting files");
  }

  const first = slug === null;
  if (slug === null || entry === null) {
    // A new folder never reuses one already on disk, whether or not the index knows it.
    const base = slugify((isMarkdown ? null : title) || basename(name, extname(name)));
    slug = base;
    for (let n = 2; index.has(slug) || existsSync(join(STORE, slug)); n++) slug = `${base}-${n}`;
    entry = { source, version: 0, created: null, page: "index.html" };
  }
  const folder = join(STORE, slug);
  const plan = planFiles(args.files, folder, dirname(source), "index.html");

  mkdirSync(folder, { recursive: true });
  applyFiles(plan);
  if (entry.page === "index.md") rmSync(join(folder, "index.md"), { force: true }); // published before Markdown was rendered
  const pageFile = join(folder, "index.html");
  writeFileSync(pageFile, published);
  entry.version = (entry.version ?? 0) + 1;
  mkdirSync(join(folder, ".versions"), { recursive: true });
  writeFileSync(join(folder, ".versions", `${entry.version}.html`), published);
  const now = isoSeconds(new Date());
  if (first || !storePageOf(source, index)[1]) entry.source = source;
  Object.assign(entry, {
    page: "index.html",
    title: title || (isMarkdown ? name : basename(name, extname(name))),
    updated: now,
    description,
    icon,
  });
  if (SESSION_ID) {
    entry.sessions = [SESSION_ID, ...(entry.sessions ?? []).filter((id) => id !== SESSION_ID)].slice(0, SESSIONS_KEPT);
  }
  if (given === null && description !== null) entry.derived = true;
  else delete entry.derived;
  entry.created = entry.created || now;
  index.set(slug, entry);
  saveIndex(index);
  SESSION_SOURCES.set(source, slug);

  const link = linkOf(slug, entry);
  const lines = [
    `Published ${source} at ${link} (Version ${entry.version})` + (first && icon ? ` Icon: "${icon}".` : ""),
  ];
  if (edits) lines.push(saveEdits(source, bytes, raw, edits.length));
  lines.push(...notes);
  lines.push(
    "To update: publish the same file path again in this session (keeps this link); pass `url` to " +
      "update this artifact from another file or a later session.",
  );
  lines.push(
    "The link is a file on this machine. If the page is meant for someone else, tell the user when you " +
      "present the page that to share it they send the published page, " +
      (hasOtherFiles(folder, pageFile) ? `the ${folder} folder, without its .versions folder` : pageFile) +
      ", not the source file, which lacks the page skeleton.",
  );
  lines.push(
    "The files you sent are still on disk. For the next small change to this file, send it as `edits` on a " +
      "publish of the same file_path (old_str/new_str pairs copied exactly from the file as it now stands): that " +
      "one call changes the file and what is published together, with no separate read or edit. To change several " +
      "files, or to rewrite most of the page, edit the files and publish them in the same response; if an edit " +
      "did not apply, correct it and publish again. If the file's text is no longer in this conversation, read " +
      "it first.",
  );
  if (first) {
    if (!OPEN_PAGES) lines.push("The page was not opened in a browser (ARTIFACT_OPEN=0); give the user the link.");
    else if (openInBrowser(pageFile)) lines.push("Opened it in the browser.");
    else lines.push("This server can't open a browser here, so the page was not opened; give the user the link.");
  }
  return lines.join("\n\n");
}

/** Write a publish's edited text back to its file, unless the file changed while it was published
 * or has other names, and say how that went. */
function saveEdits(source: string, before: Buffer, text: string, count: number): string {
  try {
    if (!readFileSync(source).equals(before)) return savedMessage(count, "changed_during_publish");
    if (statSync(source).nlink > 1) return savedMessage(count, "hard_linked");
  } catch {
    return savedMessage(count, "changed_during_publish");
  }
  const bom = before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf ? "\uFEFF" : "";
  let fd: number;
  try {
    fd = openSync(source, "r+"); // opening doesn't truncate, so a file that can't be written stays whole
  } catch {
    return savedMessage(count, "not_writable");
  }
  try {
    const data = Buffer.from(bom + text, "utf8");
    writeFileSync(fd, data); // from the start, where r+ opens, and on until every byte is written
    ftruncateSync(fd, data.length);
  } catch {
    return savedMessage(count, "write_failed");
  } finally {
    closeSync(fd);
  }
  return savedMessage(count);
}

async function actPreview(args: Args): Promise<Result> {
  if (!(await previewReady()))
    throw new Error(`preview isn't available here (${PREVIEW.reason}). Skip the look and publish.`);
  if (!args.file_path) throw new Error("preview needs `file_path`: the local .html page to render.");
  const source = absolute(args.file_path, "file_path");
  if (!isFile(source)) throw new Error(`${source} doesn't exist`);
  // Captures stay on disk, as Claude Code's do, in this session's private drafts folder.
  const previews = join(DRAFTS, ".previews");
  mkdirSync(previews, { recursive: true, mode: 0o700 });
  const stem = basename(source, extname(source));
  const out = mkdtempSync(join(previews, `${stem.slice(0, 40)}-`));
  // preview.mjs renders the page as publish wraps it; it refuses anything but a non-empty .html page
  // before reading this copy.
  const wrapped = join(out, "published.html");
  if ([".html", ".htm"].includes(extname(source).toLowerCase())) {
    let raw: string;
    try {
      raw = readSource(source);
    } catch (error) {
      const why = (error as Error).message.replace("then publish again. Nothing was published.", "then preview again.");
      return textResult(`Could not preview ${basename(source)}: ${why}`, true);
    }
    const { content, lang, cover } = unwrap(raw);
    writeFileSync(wrapped, wrapPage(content, null, null, lang, cover));
  }
  return runPreview(source, wrapped, out, args.widths, args.themes);
}

type Report = { text: string; shots?: { label: string; path: string }[]; failed?: boolean };

async function runPreview(
  source: string,
  wrapped: string,
  out: string,
  widths: unknown,
  themes: unknown,
): Promise<CallToolResult> {
  const args = [join(SCRIPTS, "preview.mjs"), source, "--wrapped", wrapped, "--json", "--out", out];
  // preview.mjs clamps and filters these as Claude Code does.
  if (Array.isArray(widths)) args.push("--widths", widths.filter((w) => typeof w === "number").join(","));
  if (Array.isArray(themes)) args.push("--themes", themes.filter((t) => typeof t === "string").join(","));
  const run = await runScript(args, 240_000);
  if (run.timedOut) {
    throw new Error("the preview ran for 4 minutes without finishing and was stopped; skip the look and publish");
  }
  let report: Report | null = null;
  try {
    const parsed: unknown = JSON.parse(lastLine(run.stdout));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Report;
  } catch {
    // no report
  }
  if (run.code !== 0 || !report) {
    const output = (run.stdout + run.stderr).trim().slice(-2000);
    return { content: [{ type: "text", text: `preview failed: ${output || "no output"}` }], isError: true };
  }
  // Like Claude Code's preview, the result carries each capture as an image after the report,
  // and a preview that captured nothing is an error.
  const content: CallToolResult["content"] = [{ type: "text", text: report.text }];
  (report.shots ?? []).forEach((shot, n) => {
    let data: string;
    try {
      data = readFileSync(shot.path).toString("base64");
    } catch {
      return;
    }
    if (!data.startsWith("/9j/") || data.length > 1_400_000) return;
    content.push({ type: "text", text: `Capture ${n + 1} (${shot.label}):` });
    content.push({ type: "image", data, mimeType: "image/jpeg" });
  });
  return { content, isError: !!report.failed };
}

const pyStr = (value: unknown) => (value === null || value === undefined ? "None" : String(value));

function actList(): string {
  const [index] = loadIndex();
  if (!index.size) return `No artifacts published yet (folder: ${STORE}).`;
  const rows = [...index].sort(([, a], [, b]) => {
    const [x, y] = [a.updated || "", b.updated || ""];
    return x < y ? 1 : x > y ? -1 : 0;
  });
  return rows
    .map(
      ([slug, entry]) =>
        `- ${entry.title || slug} \u2014 ${linkOf(slug, entry)} (updated ${pyStr(entry.updated)}, ` +
        `source ${entry.source || "unknown"})`,
    )
    .join("\n");
}

function actRead(args: Args): string {
  const [index] = loadIndex();
  const [slug, entry] = find(args.url, index);
  if (!slug) throw new Error('read needs the `url` of a published artifact; list them with action "list"');
  const text = readFileSync(join(STORE, slug, entry.page), "utf8");
  const content = entry.page.endsWith(".html") ? unwrap(text).content : text;
  return (
    `${linkOf(slug, entry)} (Version ${pyStr(entry.version)}, source ${entry.source || "unknown"})\n` +
    "This is the page content without the skeleton (doctype, head, base styles, Mermaid runtime); " +
    "publishing adds the skeleton again.\n\n" +
    content
  );
}

async function actDelete(args: Args): Promise<string> {
  const [slug, entry, repaired] = await withStoreLock(() => {
    const [index, note] = loadIndex(true);
    const [found, foundEntry] = find(args.url, index);
    if (!found) throw new Error('delete needs the `url` of a published artifact; list them with action "list"');
    try {
      rmSync(join(STORE, found), { recursive: true, force: true });
    } catch {
      // whatever is left stays on disk, out of the index
    }
    index.delete(found);
    saveIndex(index);
    return [found, foundEntry, note] as const;
  });
  for (const [source, owner] of SESSION_SOURCES) if (owner === slug) SESSION_SOURCES.delete(source);
  return (
    (repaired ? repaired + "\n\n" : "") +
    `Deleted ${entry.title || slug} and its versions; its link no longer opens. ` +
    `The source file ${entry.source || "(unknown)"} is untouched.`
  );
}

function actOpen(args: Args): string {
  const [index] = loadIndex();
  const [slug, entry] = find(args.url, index);
  if (!slug) throw new Error("open needs the `url` of a published artifact");
  const link = linkOf(slug, entry);
  return openInBrowser(join(STORE, slug, entry.page))
    ? `Opened ${link}.`
    : `There is no browser to open here; the page is ${link}.`;
}

const ACTIONS: Record<string, (args: Args, client?: string) => Result | Promise<Result>> = {
  publish: (args) => withStoreLock(() => publish(args)),
  quickstart: (args, client) => actQuickstart(client),
  read: actRead,
  list: actList,
  open: actOpen,
  delete: actDelete,
};

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

async function call(args: Args, client?: string): Promise<CallToolResult> {
  const problem = unknownParameter(args);
  if (problem) return textResult(problem, true);
  const action = args.action || "publish";
  if (action === "preview" && PREVIEW_SWITCH && (await previewOffered())) {
    return textResult("preview is an action of the ArtifactCheck tool: call ArtifactCheck with `file_path`.", true);
  }
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
    return textResult(`Unknown action ${repr(action)}.`, true);
  }
  if (args.edits !== undefined && action !== "publish") {
    return textResult(
      `\`edits\` applies only to a publish of \`file_path\` \u2014 remove it from this "${action}" call.`,
      true,
    );
  }
  try {
    const result = await ACTIONS[action]!(args, client);
    return typeof result === "string" ? textResult(result) : result;
  } catch (error) {
    // reported to the model as a tool error
    if (error instanceof Refusal) return textResult(error.message, true);
    return textResult(`${action} failed: ${(error as Error).message}`, true);
  }
}

/** A refusal for widths or themes outside what ArtifactCheck's schema allows, or null. */
function badPreviewOption(args: Args): string | null {
  const { widths, themes } = args;
  const ok = (list: unknown, max: number, item: (value: unknown) => boolean) =>
    list === undefined || (Array.isArray(list) && list.length >= 1 && list.length <= max && list.every(item));
  if (!ok(widths, 3, (w) => Number.isInteger(w) && (w as number) >= 320 && (w as number) <= 2560)) {
    return "`widths` takes one to three whole numbers of CSS pixels from 320 to 2560. Nothing was rendered.";
  }
  if (!ok(themes, 2, (t) => t === "light" || t === "dark")) {
    return "`themes` takes 'light', 'dark' or both. Nothing was rendered.";
  }
  return null;
}

async function callCheck(args: Args): Promise<CallToolResult> {
  const problem = unknownParameter(args, true) ?? badPreviewOption(args);
  if (problem) return textResult(problem, true);
  const action = args.action ?? "preview";
  if (action !== "preview") return textResult(`Unknown action ${repr(action)}.`, true);
  try {
    const result = await actPreview({ file_path: args.file_path, widths: args.widths, themes: args.themes });
    return typeof result === "string" ? textResult(result) : result;
  } catch (error) {
    return textResult(`preview failed: ${(error as Error).message}`, true);
  }
}

// ---------------------------------------------------------------- MCP over stdio

function clientName(server: Server, ctx: ServerContext): string | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, { name?: string } | undefined> | undefined;
  return envelope?.[CLIENT_INFO_META_KEY]?.name ?? server.getClientVersion()?.name;
}

serveStdio(() => {
  const server = new Server(
    { name: "artifact", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async (_request, ctx) => ({
    tools: [
      tool(clientName(server, ctx), SETTING),
      ...(PREVIEW_SWITCH && (await previewOffered()) ? [checkTool()] : []),
    ],
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const args = request.params.arguments ?? {};
    const name = request.params.name;
    if (name !== "Artifact" && !(name === "ArtifactCheck" && PREVIEW_SWITCH)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const result = name === "Artifact" ? call(args, clientName(server, ctx)) : callCheck(args);
    return server.projectCallToolResult(await result, undefined);
  });
  return server;
});

// Exit when the client closes stdin, without waiting for a preview check still running.
process.stdin.on("close", () => process.exit(0));
