// Render a Markdown page the way Claude Code's Artifact tool publishes one (2.1.296): marked
// 16.1.0 with GitHub-flavored Markdown, ```mermaid fences as <pre class="mermaid"> blocks, and the
// result poured into Claude Code's plan template (markdown-template.html, byte for byte from the
// CLI). The eyebrow reads "Markdown · <file name>", the tab title is the file name, and a heading
// that opens the document becomes the page's <h1>. The functions below follow the CLI's, rule for rule.

import { Marked, type Token, type Tokens, type TokensList } from "marked";

import { escape } from "./html.ts";
import TEMPLATE from "../skills/artifact-design/scripts/markdown-template.html" with { type: "text" };

/** A ```mermaid fence as a diagram block; marked renders any other code block itself. */
function mermaidBlock(text: string, lang: string | undefined): string | false {
  if (((lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "") !== "mermaid") return false;
  return `<pre class="mermaid">${escape(text)}</pre>\n`;
}

const marked = new Marked({ gfm: true });
marked.use({ renderer: { code: ({ text, lang }) => mermaidBlock(text, lang) } });

/** Markdown to HTML. */
export function render(text: string): string {
  return marked.parse(text, { async: false });
}

const lex = (text: string): TokensList => marked.lexer(text);

// Documents longer than this skip the token scans and look for a heading line instead.
const SCAN_LIMIT = 65536;
const ATX_LINE = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/m;

/** An ATX heading's text without its closing run of #s. */
function stripClosingHashes(text: string): string {
  const isSpace = (ch: string) => /\s/.test(ch);
  let n = text.length;
  while (n > 0 && isSpace(text[n - 1]!)) n--;
  const end = n;
  while (n > 0 && text[n - 1] === "#") n--;
  if (n === end || (n > 0 && text[n - 1] !== " ")) return text.slice(0, end);
  while (n > 0 && isSpace(text[n - 1]!)) n--;
  return text.slice(0, n);
}

/** The text after YAML front matter: a --- line, lines with no blank one among them, a closing --- line. */
function stripFrontMatter(text: string): string {
  const open = text.match(/^---[ \t]*\n/);
  if (!open) return text;
  const rest = text.slice(open[0].length);
  const close = rest.match(/^---[ \t]*$/m);
  if (!close) return text;
  const blank = rest.match(/^[ \t]*$/m);
  if (blank && blank.index! < close.index!) return text;
  return rest.slice(close.index! + close[0].length + 1);
}

/** The text of the document's first heading, wherever it is. */
function firstHeadingText(text: string): string | undefined {
  const body = stripFrontMatter(text);
  if (body.length <= SCAN_LIMIT) {
    let tokens: TokensList;
    try {
      tokens = lex(body);
    } catch {
      return undefined;
    }
    const heading = tokens.find((token) => token.type === "heading");
    return heading && "text" in heading ? heading.text : undefined;
  }
  const line = body.match(ATX_LINE)?.[1];
  return line === undefined ? undefined : stripClosingHashes(line).slice(0, SCAN_LIMIT);
}

function onlyComments(html: string): boolean {
  let rest = html.trim();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->", 4);
    if (end === -1) return false;
    rest = rest.slice(end + 3).trimStart();
  }
  return rest === "";
}

type Opening = { token: Token; offset: number; links: TokensList["links"] };

/** The first block that starts at or after `from` and isn't blank space or comments. */
function firstBlock(text: string, from: number): Opening | null {
  let tokens: TokensList;
  try {
    tokens = lex(text);
  } catch {
    return null;
  }
  let pos = 0;
  for (const token of tokens) {
    if (!text.startsWith(token.raw, pos)) return null;
    const end = pos + token.raw.length;
    if (end <= from || (pos < from && text.slice(from, end).trim() === "")) {
      pos = end;
      continue;
    }
    if (pos < from) return null;
    if (token.type === "space" || (token.type === "html" && onlyComments(token.raw))) {
      pos = end;
      continue;
    }
    return { token, offset: pos, links: tokens.links ?? {} };
  }
  return null;
}

const YAML_LINE = /^(?:[ \t]*$|[ \t]+\S|- |[\w"'.-][^:#]*:(?:[ \t]|$))/;

/** The heading that opens the document, after front matter that reads as YAML. When the front
 * matter doesn't, its heading line or first line that isn't YAML can still name the page. */
function openingHeading(text: string): { heading: Opening | null; packedHeading: string | undefined } {
  const frontLength = text.length - stripFrontMatter(text).length;
  const front = text.slice(0, frontLength);
  const lines = front.replace(/\n$/, "").split("\n").slice(1, -1);
  const yaml = lines.every((line) => YAML_LINE.test(line) && !ATX_LINE.test(line));
  const first = firstBlock(text, yaml ? frontLength : 0);
  const heading = first && first.token.type === "heading" ? first : null;
  let packedHeading: string | undefined;
  if (!yaml) {
    const atx = ATX_LINE.exec(front);
    packedHeading = atx
      ? stripClosingHashes(atx[1] ?? "")
      : lines.find((line) => !YAML_LINE.test(line) || ATX_LINE.test(line))?.trim();
  }
  return { heading, packedHeading };
}

/** The link reference definitions the document made, written out again for rendering one heading alone. */
function linkDefinitions(links: TokensList["links"]): string {
  return Object.entries(links)
    .map(([label, link]) => {
      if (!link?.href || /[<>\n]/.test(link.href) || /[\]\n]/.test(label)) return "";
      const href = /[\s()]/.test(link.href) ? `<${link.href}>` : link.href;
      const title = link.title ?? "";
      const quoted =
        !title || /\n/.test(title)
          ? ""
          : !title.includes('"')
            ? ` "${title}"`
            : !title.includes("'")
              ? ` '${title}'`
              : !/[()]/.test(title)
                ? ` (${title})`
                : "";
      return `[${label}]: ${href}${quoted}\n`;
    })
    .join("");
}

/** The opening heading's inner HTML, whitespace collapsed; its text escaped when the HTML holds a
 * <section> tag, which would take the template's own section. */
function headingHtml(token: Tokens.Heading, links: TokensList["links"]): string {
  const source = token.raw.replace(/\n*$/, "\n\n") + linkDefinitions(links);
  const inner = /^\s*<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>\s*$/.exec(render(source))?.[1]?.trim();
  if (inner === undefined || /<\/?section\b/i.test(inner)) return escape(token.text.replace(/\s+/g, " ").trim());
  return inner.replace(/\s+/g, " ");
}

/** HTML as plain text: images by their alt text, tags dropped, the basic references decoded. */
function plainText(html: string): string {
  return html
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref: string) => {
      const name = ref.toLowerCase();
      if (name === "amp") return "&";
      if (name === "lt") return "<";
      if (name === "gt") return ">";
      if (name === "quot") return '"';
      if (name === "apos") return "'";
      const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const LINK = /!?\[([^\]]{0,400})\]\([^\s)]{0,1500}\)/g;

/** Markdown outside code spans as text: links by their label, emphasis marks dropped. */
function unmark(text: string): string {
  for (let pass = 0; pass < 3; pass++) {
    const next = text.replace(LINK, (whole, label: string, offset: number, all: string) =>
      (offset > 0 && all[offset - 1] === "\\") || label.endsWith("\\") ? whole : label,
    );
    if (next === text) break;
    text = next;
  }
  return text.replace(/[*`]|~~/g, "").replace(/(?<![\p{L}\p{N}])(?<!_)_+(?!_)|(?<!_)_+(?!_)(?![\p{L}\p{N}])/gu, "");
}

/** A line of Markdown as text, code spans kept as written. */
function markdownText(text: string): string {
  const ticks = [...text.matchAll(/`+/g)].map((match) => ({ start: match.index, len: match[0].length }));
  let out = "";
  let pos = 0;
  let i = 0;
  while (i < ticks.length) {
    const open = ticks[i]!;
    let j = i + 1;
    while (j < ticks.length && ticks[j]!.len !== open.len) j++;
    if (j < ticks.length) {
      const close = ticks[j]!;
      out += unmark(text.slice(pos, open.start)) + text.slice(open.start + open.len, close.start);
      pos = close.start + close.len;
      i = j + 1;
    } else i++;
  }
  return out + unmark(text.slice(pos));
}

/** The page's <h1> HTML and its name. With no opening heading, the <h1> stays empty and the first
 * heading anywhere names the page; with no heading at all, the file name fills both. */
function title(
  text: string,
  heading: Opening | null,
  packedHeading: string | undefined,
  fallback: string,
): { titleHtml: string; title: string } {
  if (heading) {
    const html = headingHtml(heading.token as Tokens.Heading, heading.links);
    const plain = plainText(html);
    return plain === "" && !/<\w/.test(html.replace(/<!--[\s\S]*?-->/g, ""))
      ? { titleHtml: escape(fallback), title: fallback }
      : { titleHtml: html, title: plain || fallback };
  }
  const found = [firstHeadingText(text), packedHeading].find((line) => line !== undefined && line.trim() !== "");
  return found === undefined
    ? { titleHtml: escape(fallback), title: fallback }
    : { titleHtml: "", title: markdownText(found).replace(/\s+/g, " ").trim() || fallback };
}

type Slots = { titleHtml: string; tabTitle: string; eyebrow: string; summary: string; body: string };

/** The template with its placeholders filled and its run of sections replaced by the body. */
function fillTemplate(template: string, slots: Slots): string | null {
  const page = template.replace(/^﻿?<!--[\s\S]*?-->\s*/, "");
  const sections = /<section\b[\s\S]*<\/section>/;
  if (!sections.test(page)) return null;
  const values: Record<string, string> = {
    TITLE: slots.titleHtml,
    TAB_TITLE: escape(slots.tabTitle),
    EYEBROW: escape(slots.eyebrow),
    SUMMARY: escape(slots.summary),
  };
  return page
    .replace(/\{\{(TITLE|TAB_TITLE|EYEBROW|SUMMARY)\}\}/g, (_whole, slot: string) => values[slot] ?? "")
    .replace(sections, () => `<section>${slots.body}</section>`);
}

/** The published page content for a Markdown file, and the artifact's name: [html, title]. */
export function page(source: string, filename: string): [string, string] {
  const text = source.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n");
  const { heading, packedHeading } =
    text.length > SCAN_LIMIT ? { heading: null, packedHeading: undefined } : openingHeading(text);
  const named = title(text, heading, packedHeading, filename);
  const rest = heading ? text.slice(0, heading.offset) + text.slice(heading.offset + heading.token.raw.length) : text;
  const html = fillTemplate(String(TEMPLATE), {
    titleHtml: named.titleHtml,
    tabTitle: filename,
    eyebrow: `Markdown · ${filename}`,
    summary: "",
    body: render(rest),
  });
  if (html === null) throw new Error("markdown-template.html has no <section> to fill");
  return [html, [...named.title].slice(0, 120).join("").trim() || filename];
}
