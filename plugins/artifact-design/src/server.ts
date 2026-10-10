// An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.
//
// It exposes one tool, `Artifact`, with the claude.ai tool's actions that make sense on a
// local machine:
//
// - quickstart: the page contract and design guidance, the same text the claude.ai tool's
//   quickstart returns for a plain page (read from the bundled artifact-design skill).
// - publish: wraps the page in the claude.ai publish skeleton and writes it to an artifacts
//   folder (ARTIFACTS_DIR, default ~/artifacts), one folder per artifact. Publishing the same
//   file again in the same session (this server process) updates the same artifact, as the
//   Artifact tool keeps its file-to-artifact map per session; `url` updates any artifact.
//   A Markdown file is rendered into the document template Claude Code uses for one.
// - preview: renders the page at 1280 and 390px wide in light and dark, as Claude Code's
//   ArtifactCheck does, and returns the captures and what breaks (scripts/preview.mjs). It is
//   listed only when Playwright and a Chromium are found at startup, and ARTIFACT_PREVIEW=0
//   leaves it out.
// - list, read, open, delete: the published artifacts.
//
// Codex reads at most 1,000 bytes of an MCP tool's description and strips every description
// from an input schema over 5,000 bytes, so a Codex client gets a compact tool whose text fits
// those limits and points to quickstart for the rest.
//
// Speaks MCP over stdio, both the 2026-07-28 revision and the earlier ones, with the MCP SDK.
// scripts/build.ts bundles it into mcp/server.mjs, which runs on Node.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  pageTitle,
  readSource,
  unwrap,
  wrap,
} from "./publish.ts";
import { makeDrafts } from "./drafts.ts";
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
import { INSTRUCTIONS, tool, unknownParameter, type Setting } from "./tool.ts";

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

/** Run a script with this runtime, as preview.mjs and publish.mjs expect, and collect its output. */
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
  } catch (error) {
    Object.assign(PREVIEW, { ok: false, reason: `the preview check failed (${(error as Error).message})` });
  } finally {
    PREVIEW.checked = true;
  }
})();

async function previewOffered(): Promise<boolean> {
  const wait = Math.max(0, STARTED + PREVIEW_WAIT - Date.now());
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([previewCheck, new Promise((done) => (timer = setTimeout(done, wait)))]);
  clearTimeout(timer);
  return PREVIEW.checked && PREVIEW.ok;
}

// ---------------------------------------------------------------- publishing

// The source files this server process published, and their artifacts: like the Artifact tool's
// per-session map, a path republished in this session updates its artifact, and nothing else does.
const SESSION_SOURCES = new Map<string, string>();

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

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function actQuickstart(args: Args): string {
  const text = readFileSync(GUIDANCE, "utf8");
  const start = text.indexOf("## Page contract");
  if (start === -1) throw new Error(`${GUIDANCE} has no "## Page contract" section`);
  // Claude Code's quickstart leaves the empty dataviz callout's blank lines before "## Process".
  const guidance = text
    .slice(start)
    .trim()
    .replace("\n\n## Process", () => "\n\n\n\n## Process");
  const onlyPlain =
    args.intent !== undefined && args.intent !== null && args.intent !== "other"
      ? "Only plain pages can be made here: Slides, Design, Docs and Design System Artifact types exist " +
        "only on claude.ai.\n\n"
      : "";
  return (
    "Quickstart. This one result stands in for listing the Artifact types \u2014 do not make that call as well.\n\n" +
    "No published Artifact types are listed for this account (the type catalog isn't available to this account).\n\n" +
    onlyPlain +
    "For a plain page, the page-design guidance follows. It is the `artifact-design` skill's own " +
    "text, so do not load that skill as well. Write the page to a file and publish it in the same " +
    "message: the two calls run in order. Unless the person named a location, the file goes in " +
    `${DRAFTS} (or in the scratchpad directory, when the system prompt lists one), not in the project.\n\n` +
    guidance +
    "\n\n\n[Design systems not listed: this account lists no Design System type, so there are none to choose from.]"
  );
}

function publish(args: Args): string {
  if (!args.file_path) throw new Error("publish needs file_path: write the page to a file first");
  const source = absolute(args.file_path, "file_path");
  if (!isFile(source)) throw new Error(`${source} doesn't exist; write the page there first`);
  let raw: string;
  try {
    raw = readSource(source);
  } catch (error) {
    throw new Error(`file_path: ${(error as Error).message}`);
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
      if (earlier) {
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
    // Rendered into the document template the Artifact tool uses for Markdown; its tab shows the
    // file name and the artifact takes the document's heading as its name.
    let heading: string;
    [content, heading] = markdownPage(raw, name);
    title = str(args.title) ?? heading;
  } else {
    ({ content, description: oldDescription, lang, cover } = unwrap(raw));
    if (cover === null && isFullDocument(content)) notes.push(FULL_DOCUMENT_NOTE);
    title = pageTitle(content);
    if (!title && str(args.title)) {
      title = str(args.title)!;
      content = `<title>${escape(title)}</title>\n` + content;
    }
    if (!title) {
      notes.push(
        "The page has no <title> in its first 8KB (one after an <svg> doesn't count), so the " +
          "artifact is named after the file: put a <title> at the top, or pass `title`.",
      );
    }
  }
  const description = str(args.description) ?? (entry?.description || null) ?? oldDescription;
  if (!description) notes.push("No `description`: pass a one-sentence explanation of the page.");
  const icon = str(args.icon) ?? (entry?.icon || null);
  if (fetchesOwnFiles(content)) notes.push(OWN_FILES_FETCH_NOTE);
  const published = wrapPage(content, description, icon, lang, cover);
  if (Buffer.byteLength(published, "utf8") > SIZE_LIMIT) {
    throw new Error("the page is over 16MB; shrink it or move data into supporting files");
  }

  const first = slug === null;
  if (slug === null || entry === null) {
    // A new folder never reuses one already on disk, whether or not the index knows it.
    const base = slugify(title || basename(name, extname(name)));
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
  entry.created = entry.created || now;
  index.set(slug, entry);
  saveIndex(index);
  SESSION_SOURCES.set(source, slug);

  const link = linkOf(slug, entry);
  const lines = [
    `Published ${source} at ${link} (Version ${entry.version})` + (first && icon ? ` Icon: "${icon}".` : ""),
  ];
  lines.push(...notes);
  lines.push(
    "To update: publish the same file path again in this session (keeps this link); pass `url` to " +
      "update this artifact from another file or a later session.",
  );
  lines.push(
    "The link is a file on this machine. If the page is meant for someone else, tell the user when you " +
      "present the page that to share it they send the published page, " +
      (hasOtherFiles(folder, pageFile) ? `the whole ${folder} folder` : pageFile) +
      ", not the source file, which lacks the page skeleton.",
  );
  lines.push(
    "The files you sent are still on disk. To change the artifact, Edit them there and publish again " +
      "in the same message; no read is needed.",
  );
  if (first) {
    if (!OPEN_PAGES) lines.push("The page was not opened in a browser (ARTIFACT_OPEN=0); give the user the link.");
    else if (openInBrowser(pageFile)) lines.push("Opened it in the browser.");
    else lines.push("There is no browser to open here, so the page was not opened; give the user the link.");
  }
  return lines.join("\n\n");
}

async function actPreview(args: Args): Promise<Result> {
  const extra = Object.keys(args)
    .filter((key) => key !== "action" && key !== "file_path")
    .sort();
  if (extra.length) {
    throw new Error(
      `preview takes only file_path \u2014 remove ${extra.join(", ")}.` +
        (extra.includes("files")
          ? " Preview renders the single page file; files published beside it are not loaded locally."
          : ""),
    );
  }
  if (!(await previewOffered()))
    throw new Error(`preview isn't available here (${PREVIEW.reason}). Skip the look and publish.`);
  if (!args.file_path) throw new Error("preview needs `file_path`: the local .html page to render.");
  const source = absolute(args.file_path, "file_path");
  if (!isFile(source)) throw new Error(`${source} doesn't exist`);
  // Captures stay on disk, as Claude Code's do, in this session's private drafts folder.
  const previews = join(DRAFTS, ".previews");
  mkdirSync(previews, { recursive: true, mode: 0o700 });
  const stem = basename(source, extname(source));
  return runPreview(source, mkdtempSync(join(previews, `${stem.slice(0, 40)}-`)));
}

type Report = { text: string; shots?: { label: string; path: string }[]; failed?: boolean };

async function runPreview(source: string, out: string): Promise<CallToolResult> {
  const run = await runScript([join(SCRIPTS, "preview.mjs"), source, "--json", "--out", out], 240_000);
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

const ACTIONS: Record<string, (args: Args) => Result | Promise<Result>> = {
  publish: (args) => withStoreLock(() => publish(args)),
  quickstart: actQuickstart,
  preview: actPreview,
  read: actRead,
  list: actList,
  open: actOpen,
  delete: actDelete,
};

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

async function call(args: Args): Promise<CallToolResult> {
  const problem = unknownParameter(args, await previewOffered());
  if (problem) return textResult(problem, true);
  const action = args.action || "publish";
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action) || (action === "preview" && !PREVIEW_SWITCH)) {
    return textResult(`Unknown action ${repr(action)}.`, true);
  }
  try {
    const result = await ACTIONS[action]!(args);
    return typeof result === "string" ? textResult(result) : result;
  } catch (error) {
    // reported to the model as a tool error
    return textResult(`${action} failed: ${(error as Error).message}`, true);
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
    tools: [tool(await previewOffered(), clientName(server, ctx), SETTING)],
  }));
  server.setRequestHandler("tools/call", async (request) => {
    if (request.params.name !== "Artifact") {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    return server.projectCallToolResult(await call(request.params.arguments ?? {}), undefined);
  });
  return server;
});

// Exit when the client closes stdin, without waiting for a preview check still running.
process.stdin.on("close", () => process.exit(0));
