// Publish an HTML artifact as a local file, the way Claude Code's Artifact tool publishes one: the
// page skeleton, the content policy, the Mermaid runtime, the page's name, and Markdown pages.
// The MCP server and the publish.mjs script both build on this.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { escape, unescape } from "./html.ts";
import { page as renderMarkdownPage } from "./render-markdown.ts";
import MERMAID_RUNTIME from "../skills/artifact-design/scripts/mermaid-runtime.html" with { type: "text" };

// The skeleton the Artifact tool wraps around every published page (Claude Code 2.1.296).
// A page whose own viewport meta leaves out viewport-fit=cover gets the plain variant,
// without the safe-area padding, as the tool does.
const SKELETON_START = "<!doctype html><html><head><meta charset=utf8>";
const VIEWPORT_COVER = '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">';
const VIEWPORT_PLAIN = '<meta name=viewport content="width=device-width,initial-scale=1">';
const RESET_BASE =
  "body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;" +
  "background:#fff;color:#000}" +
  "img{max-width:100%}" +
  "[hidden]:not([hidden=until-found i]){display:none!important}</style>";
const SKELETON_RESET =
  "<style>:root{color-scheme:light;box-sizing:border-box;" +
  "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}" +
  "html{scroll-padding-top:env(safe-area-inset-top,0px)}" +
  RESET_BASE;
const PLAIN_RESET = "<style>:root{color-scheme:light}" + RESET_BASE;
const SKELETON_BODY = "</head><body>\n";
const SKELETON_END = "\n</body></html>";

// Claude Code's own model of the artifact viewer's content policy (its preview's, 2.1.294),
// with the five script CDNs the page contract allows, as a CSP. Its `webrtc 'block'` directive is
// left out: Chromium doesn't know it and logs an error for it on every load of the page.
const SCRIPT_HOSTS =
  "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com " +
  "https://cdn.tailwindcss.com https://code.jquery.com";
export const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${SCRIPT_HOSTS}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

export const GENERATOR = '<meta name="generator" content="artifact-design">';
const TAIL_MARK = "<!-- artifact-design -->";
// The markers pages published by the plugin's earlier Python scripts carry, still recognized.
const GENERATOR_MARKS = /<meta name="generator" content="artifact-design(?: publish\.py)?">/;
// The Mermaid runtime Claude Code 2.1.293 adds to a page with a <pre class="mermaid"> block,
// byte for byte, except that Mermaid 11.16.1 loads from jsDelivr (the same file, checked by
// sha256) instead of claude.ai's /_runtime/ path.
const MERMAID = String(MERMAID_RUNTIME).replace(/\n+$/, "");
export const SIZE_LIMIT = 16 * 1024 * 1024;
const TITLE_SCAN = 8192; // the Artifact tool reads a page's <title> from this many characters
const TITLE_MAX = 280;

/** Whether a page carries the marker publishing adds, in its first 8192 characters. */
export function publishedHere(text: string): boolean {
  return GENERATOR_MARKS.test(text.slice(0, TITLE_SCAN));
}

/** The index of the first byte that isn't valid UTF-8, or -1. */
function invalidUtf8At(data: Uint8Array, from: number): number {
  let i = from;
  while (i < data.length) {
    const lead = data[i]!;
    if (lead < 0x80) {
      i++;
      continue;
    }
    const more =
      lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
    if (!more) return i;
    const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    const second = data[i + 1];
    if (second === undefined || second < low || second > high) return i;
    for (let k = 2; k <= more; k++) {
      const next = data[i + k];
      if (next === undefined || next < 0x80 || next > 0xbf) return i;
    }
    i += more + 1;
  }
  return -1;
}

/** The page file's text, as UTF-8 (a byte-order mark is dropped). Like the Artifact tool, a file
 * in another encoding is refused rather than published garbled. */
export function readSource(path: string): string {
  const data = readFileSync(path);
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(bom));
  } catch {
    throw new Error(
      `the source file is not valid UTF-8 text (first invalid byte at ${invalidUtf8At(data, bom)}). It may be ` +
        "saved in another encoding or contain binary data. Save the page as UTF-8, then publish again. " +
        "Nothing was published.",
    );
  }
}

/** The page's name, read as the Artifact tool reads it: the first <title> in the first 8192
 * characters, comments left out and nothing from the first <svg> on (an icon's <title> names
 * the icon, not the page), entities decoded, whitespace collapsed, at most 280 characters. */
export function pageTitle(content: string): string | null {
  const head = content.slice(0, TITLE_SCAN).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const svg = head.search(/<svg/i);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(svg === -1 ? head : head.slice(0, svg));
  if (!match) return null;
  const text = unescape(match[1]!)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, TITLE_MAX) || null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What publishing puts around a page: the skeleton, with this tool's metas when it published
// the page, and the diagram runtimes before the end. A page that carries exactly this (one this
// tool or the Artifact tool published, read back or downloaded) is unwrapped before it is
// wrapped again, as the Artifact tool unwraps its own skeleton; nothing else is. Its line breaks
// may be CRLF, as a page written as text on Windows has them.
const SKELETON_RE = new RegExp(
  '^<![dD][oO][cC][tT][yY][pP][eE] [hH][tT][mM][lL]><html(?: lang="([^"]{1,35})")?><head><meta charset=utf8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1(,viewport-fit=cover)?">' +
    '((?:<meta http-equiv="Content-Security-Policy" content="[^"]*">)?(?:' +
    GENERATOR_MARKS.source +
    ')?(?:<link rel="icon" href="[^"]*">)?(?:<meta name="description" content="([^"]*)">)?)' +
    "<style>[^<]*</style></head><body>\\r?\\n",
);
const TAIL_RE = new RegExp(`\\r?\\n(?:${escapeRegExp(TAIL_MARK)}|<!-- artifact-design publish\\.py -->)\\r?\\n`);
const RUNTIME_BLOCKS =
  /(?:\r?\n)?<!--claude-(mermaid|hljs|chart)-runtime-begin:\d+-->[\s\S]*?<!--claude-\1-runtime-end-->(?:\r?\n)?/g;

/** Strip these characters from both ends, as Python's str.strip(chars) does. */
const stripChars = (text: string, chars: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start++;
  while (end > start && chars.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
};

export type Unwrapped = {
  content: string;
  description: string | null;
  lang: string | null;
  cover: boolean | null;
};

/** The page with an earlier publish skeleton removed. lang and cover are what the skeleton
 * carried, for wrapping the page the same way again; cover is null when there was no skeleton.
 * Leading and trailing newlines are dropped. */
export function unwrap(text: string): Unwrapped {
  const rest = text.trimStart();
  const match = SKELETON_RE.exec(rest);
  const end = rest.trimEnd();
  if (!match || !end.endsWith("</body></html>")) {
    return { content: stripChars(text, "\r\n"), description: null, lang: null, cover: null };
  }
  let body = rest.slice(match[0].length, end.lastIndexOf("</body></html>"));
  const tail = TAIL_RE.exec(body);
  if (tail) body = body.slice(0, tail.index);
  body = body.replace(RUNTIME_BLOCKS, "");
  return {
    content: stripChars(body, "\r\n"),
    description: match[4] !== undefined ? unescape(match[4]) : null,
    lang: match[1] ?? null,
    cover: match[2] !== undefined,
  };
}

/** Whether the page was written as a whole HTML document (doctype or <html> first). */
export function isFullDocument(content: string): boolean {
  const lead = content.replace(/^(?:\s|<!--[\s\S]*?-->)*/, "");
  return /^(?:<!doctype\b|<html[\s>])/i.test(lead);
}

/** Whether the page runs edge to edge: true unless its own viewport meta leaves out viewport-fit=cover. */
function coversSafeArea(content: string, fallback: boolean): boolean {
  const viewports = content.match(/<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/gi);
  if (!viewports) return fallback;
  return viewports.some((tag) => /viewport-fit\s*=\s*cover/i.test(tag));
}

/** Whether the page has a <pre> element with the class mermaid, the only element Claude Code draws as a diagram.
 *
 * Comments and the raw text of script, style, textarea and template elements can mention
 * <pre class="mermaid"> without making a diagram, so they are left out. A page that loads
 * Mermaid itself with a <script src> draws its own diagrams and gets no second runtime. */
export function usesMermaid(content: string): boolean {
  let markup = content.replace(/<!--[\s\S]*?-->/g, "");
  if (/<script\b[^>]*?\ssrc\s*=\s*["']?[^"'\s>]*mermaid/i.test(markup)) return false;
  markup = markup.replace(/<(script|style|textarea|template|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const match of markup.matchAll(/<pre(?=[\s/>])[^<>]*?\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const classes = (match[1] || match[2] || match[3] || "").split(/\s+/);
    if (classes.includes("mermaid")) return true;
  }
  return false;
}

/** The published page: the skeleton around the content as it is (a full document included,
 * whose <html> and <body> attributes the browser then carries over), as the Artifact tool wraps
 * it. lang and cover come from an unwrapped skeleton, as the tool keeps them on a round trip. */
export function wrap(
  content: string,
  description: string | null,
  lang: string | null = null,
  cover: boolean | null = null,
): string {
  const covers = coversSafeArea(content, cover ?? true);
  let head = SKELETON_START.replace("<html>", lang ? `<html lang="${lang}">` : "<html>");
  head += covers ? VIEWPORT_COVER : VIEWPORT_PLAIN;
  head += `<meta http-equiv="Content-Security-Policy" content="${CSP}">` + GENERATOR;
  if (description) head += `<meta name="description" content="${escape(description)}">`;
  head += (covers ? SKELETON_RESET : PLAIN_RESET) + SKELETON_BODY;
  const tail = usesMermaid(content) ? "\n" + TAIL_MARK + "\n" + MERMAID : "";
  return head + content + tail + SKELETON_END;
}

/** A Markdown file's page content and title, laid out as the Artifact tool lays one out. */
export function markdownPage(text: string, filename: string): [string, string] {
  return renderMarkdownPage(text, filename);
}

export const FULL_DOCUMENT_NOTE =
  "The file was a full HTML document; it was published inside the skeleton as it is. " +
  "Publishing adds the skeleton, so write only the page content next time.";
export const OWN_FILES_FETCH_NOTE =
  "The page fetch()es its own files. claude.ai serves them, but a browser refuses fetch() " +
  "over file://, so the page opened from this machine can't load them, and preview " +
  "doesn't serve them either.";

export function fetchesOwnFiles(content: string): boolean {
  return /fetch\(\s*[`'"](?![a-z]+:)/.test(content);
}

/** The command that opens a file in the browser here, or null: macOS, Windows, or a Linux desktop session. */
export function opener(): string | null {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer.exe";
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  const found = (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, "xdg-open")));
  return found ? "xdg-open" : null;
}

export function openInBrowser(path: string): boolean {
  const command = opener();
  if (!command) return false;
  try {
    const child = spawn(command, [path], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
