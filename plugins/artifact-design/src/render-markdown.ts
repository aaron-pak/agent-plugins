// Render a Markdown page the way Claude Code's Artifact tool publishes one.
//
// Claude Code (2.1.294) renders a published `.md` file with marked (GitHub-flavored), turns
// ```mermaid fences into <pre class="mermaid"> blocks, and pours the result into its plan
// template (markdown-template.html, byte for byte from the CLI bundle): the eyebrow reads
// "Markdown · <file name>", the tab title is the file name, and a heading that opens the
// document becomes the page's <h1>. This module does the same with a small renderer of its
// own covering the GitHub-flavored Markdown that pages use (headings, paragraphs, emphasis,
// links and images, code, lists and task lists, block quotes, tables, rules and raw HTML).

import { escape as escapeHtml, unescape } from "./html.ts";
import TEMPLATE from "../skills/artifact-design/scripts/markdown-template.html" with { type: "text" };

const HEADING_SLOTS = /\{\{(TITLE|TAB_TITLE|EYEBROW|SUMMARY)\}\}/g;
const SECTIONS = /<section\b[\s\S]*<\/section>/;

// Escapes as Python's html.escape did, with ' as &#39;.
const escape = (text: string) => escapeHtml(text).replaceAll("&#x27;", "&#39;");

/** Match a pattern at exactly this position, as Python's pattern.match(text, pos) does. */
const stickies = new WeakMap<RegExp, RegExp>();
function matchAt(pattern: RegExp, text: string, pos = 0): RegExpExecArray | null {
  let sticky = stickies.get(pattern);
  if (!sticky) {
    sticky = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "y");
    stickies.set(pattern, sticky);
  }
  sticky.lastIndex = pos;
  return sticky.exec(text);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** How many of these characters the text starts with. */
const leading = (text: string, chars: string) => {
  let n = 0;
  while (n < text.length && chars.includes(text[n]!)) n++;
  return n;
};
const lstrip = (text: string, chars: string) => text.slice(leading(text, chars));
const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

// ---------------------------------------------------------------- inline

const PUNCT = "!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~";
const PUNCT_CHAR = new RegExp(`^[${PUNCT}]$`);
const WORD = "\\p{L}\\p{N}_"; // Python's \w: Unicode letters and digits, and the underscore
const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const RAW_TAG = new RegExp(
  `<!--[\\s\\S]*?-->|<[A-Za-z][A-Za-z0-9-]*(?:\\s+[A-Za-z_:][${WORD}.:-]*(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?)*\\s*/?>` +
    "|</[A-Za-z][A-Za-z0-9-]*\\s*>|<\\?[\\s\\S]*?\\?>|<![A-Za-z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  "u",
);
const AUTOLINK = new RegExp(
  `<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\s<>]*)>|<([${WORD}.!#$%&'*+/=?^\`{|}~-]+@[${WORD}-]+(?:\\.[${WORD}-]+)+)>`,
  "u",
);
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]+/;
// GFM's bare e-mail address, as marked links it: from the first character of the run of address
// characters before the @ that its local part allows.
const EMAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*[A-Za-z0-9])+(?![-_])/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_AT = /[A-Za-z0-9._+-]+@/;
const EM_UNDERSCORE = new RegExp(`(_+)(?=[^\\s_])[\\s\\S]*?[^\\s_]\\1(?![${WORD}_])`, "u");
const PLACEHOLDER = /\x00(\d+)\x00/g;
const LINK_DEST = "(?:<([^<>\\n]*)>|((?:[^\\s()\\\\]|\\\\.|\\((?:[^\\s()\\\\]|\\\\.)*\\))*))";
const LINK_TAIL = new RegExp(
  `\\(\\s*${LINK_DEST}(?:\\s+("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\((?:[^()\\\\]|\\\\.)*\\)))?\\s*\\)`,
);
const isAlnum = (ch: string) => /^[\p{L}\p{N}]$/u.test(ch);

/** GFM's autolink end: drop trailing punctuation and unbalanced closing parentheses. */
function trimUrl(url: string): string {
  const count = (ch: string) => url.split(ch).length - 1;
  while (url && ("?!.,:;*_~'\"".includes(url.at(-1)!) || (url.at(-1) === ")" && count(")") > count("(")))) {
    url = url.slice(0, -1);
  }
  return url;
}

const unescapeMd = (text: string) => text.replace(new RegExp(`\\\\([${PUNCT}])`, "g"), "$1");

/** Escape text for HTML, keeping entity references the author wrote. */
function escapeText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(ENTITY)) {
    out += escape(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + escape(text.slice(last));
}

type Refs = Map<string, [string, string | null]>;

const EMPHASIS: [RegExp, string, string][] = [
  [
    new RegExp(`(?<![${WORD}*])\\*\\*\\*(?=\\S)([\\s\\S]+?)(?<=\\S)\\*\\*\\*(?![*])`, "gu"),
    "<em><strong>",
    "</strong></em>",
  ],
  [
    new RegExp(`(?<![${WORD}_])___(?=\\S)([\\s\\S]+?)(?<=\\S)___(?![${WORD}_])`, "gu"),
    "<em><strong>",
    "</strong></em>",
  ],
  [/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, "<strong>", "</strong>"],
  [new RegExp(`(?<![${WORD}_])__(?=\\S)([\\s\\S]+?)(?<=\\S)__(?![${WORD}_])`, "gu"), "<strong>", "</strong>"],
  [/(?<![*])\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?![*])/g, "<em>", "</em>"],
  [new RegExp(`(?<![${WORD}_])_(?=[^\\s_])([\\s\\S]+?)(?<=[^\\s_])_(?![${WORD}_])`, "gu"), "<em>", "</em>"],
  [/(?<!~)~~?(?=[^\s~])([\s\S]+?)(?<=[^\s~])~~?(?!~)/g, "<del>", "</del>"],
];

/** Inline rendering: code spans, links, raw HTML and escapes become placeholders first, so
 * emphasis never reaches inside them; then emphasis runs over what is left. */
class Inline {
  slots: string[] = [];

  constructor(
    readonly refs: Refs,
    public inLink = false, // as in marked, no bare URL or e-mail autolinks inside a link's text
  ) {}

  hold(rendered: string): string {
    this.slots.push(rendered);
    return `\x00${this.slots.length - 1}\x00`;
  }

  render(text: string): string {
    text = this.emphasis(this.tokens(text));
    // One pass: every slot holds finished HTML. render() and page() turn a NUL in the source
    // into U+FFFD, and a stray one that names no slot is left as it is.
    return text.replace(PLACEHOLDER, (whole, n: string) =>
      Number(n) < this.slots.length ? this.slots[Number(n)]! : whole,
    );
  }

  link(label: string, dest: string | undefined, title: string | null, image: boolean): string {
    const href = escape(unescape(unescapeMd(dest ?? "")));
    const attrs = title ? ` title="${escape(unescape(unescapeMd(title)))}"` : "";
    if (image) {
      const alt = new Inline(this.refs, true).render(label).replace(/<[^>]*>/g, "");
      return `<img src="${href}" alt="${escape(unescape(alt))}"${attrs}>`;
    }
    return `<a href="${href}"${attrs}>${new Inline(this.refs, true).render(label)}</a>`;
  }

  /** Match [label] from start, allowing nested brackets; return the end index or -1. */
  bracket(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        const run = matchAt(/`+/, text, i)![0];
        const close = text.indexOf(run, i + run.length);
        i = close !== -1 ? close + run.length : i + run.length;
        continue;
      }
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) return i;
      }
      i += 1;
    }
    return -1;
  }

  tokens(text: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1]!;
        if (next === "\n") {
          out.push(this.hold("<br>"));
          i += 2;
          continue;
        }
        if (PUNCT_CHAR.test(next)) {
          out.push(this.hold(escape(next)));
          i += 2;
          continue;
        }
      }
      if (ch === "`") {
        const run = matchAt(/`+/, text, i)![0];
        const closer = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
        closer.lastIndex = i + run.length;
        const close = closer.exec(text);
        if (close) {
          let code = text.slice(i + run.length, close.index).replaceAll("\n", " ");
          if (code.trim() && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
          out.push(this.hold(`<code>${escape(code)}</code>`));
          i = close.index + close[0].length;
          continue;
        }
        out.push(run);
        i += run.length;
        continue;
      }
      if (ch === "<") {
        const auto = matchAt(AUTOLINK, text, i);
        if (auto) {
          const url = auto[1] || auto[2]!;
          const href = auto[1] ? url : "mailto:" + url;
          out.push(this.hold(`<a href="${escape(href)}">${escape(url)}</a>`));
          i += auto[0].length;
          continue;
        }
        const tag = matchAt(RAW_TAG, text, i);
        if (tag) {
          out.push(this.hold(tag[0]));
          // Like marked, no autolinks between a raw <a ...> and its </a> either.
          if (/^<a /i.test(tag[0])) this.inLink = true;
          else if (/^<\/a>/i.test(tag[0])) this.inLink = false;
          i += tag[0].length;
          continue;
        }
      }
      if (ch === "[" || (ch === "!" && text.startsWith("![", i))) {
        const image = ch === "!";
        const start = image ? i + 1 : i;
        const end = this.bracket(text, start);
        if (end !== -1) {
          const label = text.slice(start + 1, end);
          const tail = matchAt(LINK_TAIL, text, end + 1);
          if (tail) {
            const dest = tail[1] !== undefined ? tail[1] : tail[2];
            const title = tail[3] ? tail[3].slice(1, -1) : null;
            out.push(this.hold(this.link(label, dest, title, image)));
            i = end + 1 + tail[0].length;
            continue;
          }
          const ref = matchAt(/\[([^\]]*)\]/, text, end + 1);
          const key = normalizeLabel(ref && ref[1] ? ref[1] : label);
          const found = this.refs.get(key);
          if (found) {
            out.push(this.hold(this.link(label, found[0], found[1], image)));
            i = end + 1 + (ref ? ref[0].length : 0);
            continue;
          }
        }
      }
      if ("hHwW".includes(ch) && !this.inLink) {
        const bare = matchAt(BARE_URL, text, i);
        const url = bare ? trimUrl(bare[0]) : "";
        const host = url.split("//").at(-1)!;
        if (url && host.includes(".") && (i === 0 || !(isAlnum(text[i - 1]!) || "/_".includes(text[i - 1]!)))) {
          const href = url.includes("://") ? url : "http://" + url;
          out.push(this.hold(`<a href="${escape(href)}">${escape(url)}</a>`));
          i += url.length;
          continue;
        }
      }
      if (EMAIL_LOCAL.test(ch) && !this.inLink && (i === 0 || !EMAIL_LOCAL.test(text[i - 1]!))) {
        let start = i;
        let end = text.length;
        const opener = ch === "_" && matchAt(EMAIL_AT, text, i) ? matchAt(EM_UNDERSCORE, text, i) : null;
        if (opener) {
          // marked tries emphasis first: the address is what the _emphasis_ holds
          start = i + opener[1]!.length;
          end = i + opener[0].length - opener[1]!.length;
        }
        const mail = matchAt(EMAIL, text.slice(0, end), start);
        if (mail) {
          out.push(text.slice(i, start));
          out.push(this.hold(`<a href="mailto:${escape(mail[0])}">${escape(mail[0])}</a>`));
          i = start + mail[0].length;
          continue;
        }
      }
      if (ch === "\n") {
        // A line ending in two or more spaces is a hard break; other line breaks stay.
        let spaces = 0;
        while (out.length && out.at(-1) === " ") {
          out.pop();
          spaces += 1;
        }
        out.push(spaces >= 2 ? this.hold("<br>") : "\n");
        i += 1;
        continue;
      }
      out.push(ch);
      i += 1;
    }
    // Placeholders survive escaping: \x00 and digits are not HTML-special.
    return escapeText(out.join(""));
  }

  emphasis(text: string): string {
    for (let round = 0; round < 3; round++) {
      // nested emphasis, innermost-last
      const before = text;
      for (const [pattern, open, close] of EMPHASIS) {
        text = text.replace(pattern, (_whole, inner: string) => open + inner + close);
      }
      if (text === before) break;
    }
    return text;
  }
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------- blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^( {0,3})([*+-])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
// Tabs stay as written. Indentation is measured as marked measures it: an indented code line starts
// with four spaces or a tab, and a list item's continuation lines have each tab read as four spaces.
const INDENTED = /^(?: {4}| {0,3}\t)/;
const UNINDENT = /^(?: {1,4}| {0,3}\t)/;
// HTML blocks, CommonMark's seven kinds as marked reads them. Kinds 1-5 (<pre>, <script>, <style>
// and <textarea>; comments; <?...?>; <!X...>; CDATA) run to the line holding their end marker. Kind 6
// (a block-level tag name) and kind 7 (a line that is one whole open or closing tag of any other
// name, such as <img ...> or </span>) run to a blank line. Inline tags that start a line of text
// leave it a paragraph. Only kinds 1, 2 and 6 interrupt a paragraph, and only from the first column.
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|" +
  "div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|" +
  "legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|" +
  "summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK = new RegExp(
  "^ {0,3}(?:<(script|pre|style|textarea)(?:[\\s>]|$)|(<!--|<\\?|<!\\[CDATA\\[|<![A-Za-z])" +
    `|</?(?:${BLOCK_TAGS})(?: |/?>|$)` +
    "|(?:<(?!script|pre|style|textarea)[A-Za-z][A-Za-z0-9_-]*" +
    "(?: +[A-Za-z_:][A-Za-z0-9_.:-]*(?: *= *\"[^\"]*\"| *= *'[^']*'| *= *[^\\s\"'=<>`]+)?)* */?>" +
    "|</(?!script|pre|style|textarea)[A-Za-z][A-Za-z0-9_-]*\\s*>)[ \\t]*$)",
  "i",
);
const HTML_ENDS: Record<string, string> = { "<!--": "-->", "<?": "?>", "<![CDATA[": "]]>" }; // and ">" for <!X
const HTML_INTERRUPT = new RegExp(`^(?:</?(?:${BLOCK_TAGS})(?: |/?>|$)|<(?:script|pre|style|textarea|!--))`);
// marked ends a list item at a line, outside the item, that starts with anything like a tag.
const LIST_HTML = /^ {0,3}<(?:[a-z].*>|!--)/i;

/** Whether a line interrupts a paragraph. */
function startsBlock(line: string): boolean {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || HTML_INTERRUPT.test(line)) return true;
  const bullet = BULLET.exec(line);
  if (bullet && line.slice(bullet[0].length).trim()) return true;
  const ordered = ORDERED.exec(line);
  return !!(ordered && ordered[2] === "1" && line.slice(ordered[0].length).trim());
}

/** The marker that ends an HTML block opened by this HTML_BLOCK match, or null for one that runs to a blank line. */
function htmlBlockEnd(start: RegExpExecArray): string | null {
  if (start[1]) return `</${start[1].toLowerCase()}>`;
  if (start[2]) return HTML_ENDS[start[2]] ?? ">";
  return null;
}

function splitCells(row: string): string[] {
  row = row.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  // As in GFM, every unescaped pipe splits cells, inside code spans too.
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (ch === "\\" && i + 1 < row.length && row[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
    i += 1;
  }
  cells.push(cur.trim());
  return cells;
}

// Rendered blocks. Paragraphs are held as { p: html } until join(), because in a tight list item
// top-level paragraphs lose their <p>.
type Part = string | { p: string };

class Blocks {
  constructor(readonly refs: Refs) {}

  inline(text: string): string {
    return new Inline(this.refs).render(text);
  }

  render(lines: string[]): string {
    return Blocks.join(this.blocks(lines)[0]);
  }

  static join(parts: Part[], tight = false): string {
    return parts.map((part) => (typeof part === "string" ? part : tight ? part.p : `<p>${part.p}</p>\n`)).join("");
  }

  /** Render block lines into parts for join(); also say whether a blank line separates two of
   * the top-level blocks. */
  blocks(lines: string[]): [Part[], boolean] {
    const out: Part[] = [];
    let i = 0;
    let spaced = false;
    let gap = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        gap = out.length > 0;
        i += 1;
        continue;
      }
      spaced = spaced || gap;
      gap = false;
      const fence = FENCE.exec(line);
      if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
        const marker = fence[2]!;
        const info = fence[3]!;
        // Like marked, take a ``` fence's own indentation off each line indented at least as
        // far (spaces or tabs, a character each), and leave ~~~ fence lines as they are.
        const indent = marker[0] === "`" ? fence[1]!.length : 0;
        const closing = new RegExp(`^ {0,3}(${escapeRegExp(marker[0]!)}{${marker.length},})[ \\t]*$`);
        const body: string[] = [];
        i += 1;
        while (i < lines.length) {
          if (closing.test(lines[i]!)) {
            i += 1;
            break;
          }
          body.push(indentOf(lines[i]!) >= indent ? lines[i]!.slice(indent) : lines[i]!);
          i += 1;
        }
        const code = body.join("\n");
        const lang = info.trim() ? unescapeMd(info).trim().split(/\s+/)[0]! : "";
        if (lang.toLowerCase() === "mermaid") {
          out.push(`<pre class="mermaid">${escape(code)}</pre>\n`);
        } else {
          const cls = lang ? ` class="language-${escape(lang)}"` : "";
          out.push(`<pre><code${cls}>${escape(code)}${body.length ? "\n" : ""}</code></pre>\n`);
        }
        continue;
      }
      const heading = ATX.exec(line);
      if (heading) {
        const level = heading[1]!.length;
        out.push(`<h${level}>${this.inline((heading[2] ?? "").trim())}</h${level}>\n`);
        i += 1;
        continue;
      }
      if (HR.test(line)) {
        out.push("<hr>\n");
        i += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const body: string[] = [];
        while (i < lines.length && !isBlank(lines[i]!)) {
          if (QUOTE.test(lines[i]!)) body.push(lines[i]!.replace(QUOTE, ""));
          else if (body.length && !isBlank(body.at(-1)!) && !startsBlock(lines[i]!)) body.push(lines[i]!); // lazy continuation
          else break;
          i += 1;
        }
        out.push(`<blockquote>\n${this.render(body)}</blockquote>\n`);
        continue;
      }
      if (BULLET.test(line) || ORDERED.test(line)) {
        const [list, next] = this.list(lines, i);
        out.push(list);
        i = next;
        continue;
      }
      if (INDENTED.test(line)) {
        const body: string[] = [];
        while (i < lines.length && (INDENTED.test(lines[i]!) || isBlank(lines[i]!))) {
          body.push(lines[i]!.replace(UNINDENT, ""));
          i += 1;
        }
        while (body.length && isBlank(body.at(-1)!)) body.pop();
        out.push(`<pre><code>${escape(body.join("\n"))}\n</code></pre>\n`);
        continue;
      }
      const start = HTML_BLOCK.exec(line);
      if (start) {
        const end = htmlBlockEnd(start);
        const body = [line];
        i += 1;
        if (end) {
          // to the line holding the end marker (marked's <!--> and <!---> end at once)
          const rest = line.slice(start[0].length).toLowerCase();
          let done = rest.includes(end) || (end === "-->" && /^-?>/.test(rest));
          while (!done && i < lines.length) {
            body.push(lines[i]!);
            done = lines[i]!.toLowerCase().includes(end);
            i += 1;
          }
        } else {
          // to a blank line
          while (i < lines.length && !isBlank(lines[i]!)) {
            body.push(lines[i]!);
            i += 1;
          }
        }
        out.push(body.join("\n") + "\n");
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!)) {
        const header = splitCells(line);
        const aligns = splitCells(lines[i + 1]!);
        if (header.length === aligns.length) {
          const [table, next] = this.table(lines, i, header, aligns);
          out.push(table);
          i = next;
          continue;
        }
      }
      // A paragraph, which may end in a setext underline.
      const para = [line];
      i += 1;
      let level = 0;
      while (i < lines.length && !isBlank(lines[i]!)) {
        const setext = SETEXT.exec(lines[i]!);
        if (setext) {
          level = setext[1]![0] === "=" ? 1 : 2;
          i += 1;
          break;
        }
        if (
          startsBlock(lines[i]!) ||
          (lines[i]!.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!))
        ) {
          break;
        }
        para.push(lines[i]!);
        i += 1;
      }
      const text = para
        .map((part) => part.trimStart())
        .join("\n")
        .trimEnd();
      if (level) out.push(`<h${level}>${this.inline(text)}</h${level}>\n`);
      else out.push({ p: this.inline(text) });
    }
    return [out, spaced];
  }

  table(lines: string[], i: number, header: string[], aligns: string[]): [string, number] {
    const align = (cell: string) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      return left && right ? ' align="center"' : right ? ' align="right"' : left ? ' align="left"' : "";
    };
    const attrs = aligns.map(align);
    let out = "<table>\n<thead>\n<tr>\n";
    out += header.map((cell, n) => `<th${attrs[n]}>${this.inline(cell)}</th>\n`).join("");
    out += "</tr>\n</thead>\n";
    i += 2;
    const rows: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
      const cells = [...splitCells(lines[i]!), ...header.map(() => "")].slice(0, header.length);
      rows.push("<tr>\n" + cells.map((cell, n) => `<td${attrs[n]}>${this.inline(cell)}</td>\n`).join("") + "</tr>\n");
      i += 1;
    }
    if (rows.length) out += "<tbody>" + rows.join("") + "</tbody>";
    out += "</table>\n";
    return [out, i];
  }

  list(lines: string[], i: number): [string, number] {
    const ordered = !BULLET.test(lines[i]!);
    const pattern = ordered ? ORDERED : BULLET;
    const first = pattern.exec(lines[i]!)!;
    const kind = ordered ? first[3] : first[2];
    const start = ordered ? parseInt(first[2]!, 10) : null;
    // As in marked, a list is loose when a blank line ends an item that another item follows,
    // or separates two blocks inside an item.
    const items: string[][] = [];
    let loose = false;
    let gap = false;
    while (i < lines.length) {
      const match = pattern.exec(lines[i]!);
      if (!match || (ordered ? match[3] : match[2]) !== kind) break;
      loose = loose || gap;
      // The content column, as marked finds it: after the spaces that follow the marker (a tab
      // there counts as content, and its leading tabs read as three spaces each), or one column
      // after the marker when more than four spaces follow it or the line is blank.
      const markerEnd = match[0].length - (ordered ? match[4]! : match[3]!).length;
      const rest = lines[i]!.slice(markerEnd);
      let contentCol: number;
      let body: string[];
      if (rest.trim()) {
        const lead = leading(rest, " ");
        contentCol = lead <= 4 ? lead : 1;
        body = [rest.replace(/^\t+/, (tabs) => "   ".repeat(tabs.length)).slice(contentCol)];
        contentCol += markerEnd;
      } else {
        contentCol = markerEnd + 1;
        body = [""];
      }
      i += 1;
      gap = false;
      while (i < lines.length) {
        const line = lines[i]!;
        if (isBlank(line)) {
          body.push("");
          gap = true;
          i += 1;
          continue;
        }
        const expanded = line.replaceAll("\t", "    "); // as marked reads (and keeps) an item's lines
        if (leading(expanded, " ") >= contentCol) {
          body.push(expanded.slice(contentCol));
          gap = false;
          i += 1;
          continue;
        }
        if (!gap && !startsBlock(line) && !LIST_HTML.test(line) && !(BULLET.test(line) || ORDERED.test(line))) {
          body.push(line.trimStart()); // lazy continuation of the item's paragraph
          i += 1;
          continue;
        }
        break;
      }
      while (body.length && isBlank(body.at(-1)!)) body.pop();
      items.push(body);
    }
    // Each item is rendered once; whether the list is loose only decides how its paragraphs join.
    const tasks: string[] = [];
    const itemParts: Part[][] = [];
    for (const body of items) {
      const check = body.length ? /^\[([ xX])\][ \t]+/.exec(body[0]!) : null;
      const checked = check && check[1] !== " " ? 'checked="" ' : "";
      tasks.push(check ? `<input ${checked}disabled="" type="checkbox"> ` : "");
      if (check) body[0] = body[0]!.slice(check[0].length);
      const [parts, spaced] = this.blocks(body);
      loose = loose || spaced;
      itemParts.push(parts);
    }
    const tag = ordered ? "ol" : "ul";
    const attr = ordered && start !== 1 ? ` start="${start}"` : "";
    let out = `<${tag}${attr}>\n`;
    itemParts.forEach((parts, n) => {
      const task = tasks[n]!;
      let rendered = Blocks.join(parts, !loose);
      if (!loose) rendered = task + rendered.replace(/\n+$/, "");
      else if (task)
        rendered = rendered.startsWith("<p>") ? rendered.replace("<p>", () => "<p>" + task) : task + rendered;
      out += `<li>${rendered}</li>\n`;
    });
    out += `</${tag}>\n`;
    return [out, i];
  }
}

/** Pull out link reference definitions ([label]: url "title") outside code fences. */
function collectRefs(lines: string[]): [Refs, string[]] {
  const refs: Refs = new Map();
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${escapeRegExp(fence[0]!)}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
    } else if (match) {
      fence = match[2]!;
    } else {
      const ref = REF_DEF.exec(line);
      if (ref) {
        const key = normalizeLabel(ref[1]!);
        if (!refs.has(key))
          refs.set(key, [ref[2] !== undefined ? ref[2] : ref[3]!, ref[4] ? ref[4].slice(1, -1) : null]);
        continue;
      }
    }
    kept.push(line);
  }
  return [refs, kept];
}

/** Markdown to HTML, the shapes marked produces for the same input. As in CommonMark, a NUL
 * character becomes U+FFFD. */
export function render(text: string): string {
  const [refs, lines] = collectRefs(text.replaceAll("\x00", "\ufffd").split("\n"));
  return new Blocks(refs).render(lines);
}

// ---------------------------------------------------------------- the page

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/;
const YAML_LINE = new RegExp(`^(?:[ \\t]*$|[ \\t]+\\S|- |[${WORD}"'.-][^:#]*:(?:[ \\t]|$))`, "u");
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Lines as Python's str.splitlines() gives them: no empty last line for a trailing break. */
function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAKS);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The heading that opens the document (after YAML front matter and comments), as [start, end, level, text]. */
function openingHeading(text: string): [number, number, number, string] | null {
  let pos = 0;
  const front = FRONT_MATTER.exec(text);
  if (front && splitLines(front[1] ?? "").every((line) => YAML_LINE.test(line) && !ATX.test(line))) {
    pos = front[0].length;
  }
  for (;;) {
    const stripped = lstrip(text.slice(pos), " \t\n");
    if (stripped.startsWith("<!--") && stripped.includes("-->")) {
      pos = text.length - stripped.length + stripped.indexOf("-->") + 3;
      continue;
    }
    pos = text.length - stripped.length;
    break;
  }
  const lineEnd = text.indexOf("\n", pos);
  const line = text.slice(pos, lineEnd !== -1 ? lineEnd : text.length);
  const atx = ATX.exec(line);
  if (atx) {
    const end = lineEnd !== -1 ? lineEnd + 1 : text.length;
    return [pos, end, atx[1]!.length, (atx[2] ?? "").trim()];
  }
  if (line.trim() && lineEnd !== -1) {
    const nextEnd = text.indexOf("\n", lineEnd + 1);
    const underline = text.slice(lineEnd + 1, nextEnd !== -1 ? nextEnd : text.length);
    const setext = SETEXT.exec(underline);
    if (setext && !startsBlock(line)) {
      const end = nextEnd !== -1 ? nextEnd + 1 : text.length;
      return [pos, end, setext[1]![0] === "=" ? 1 : 2, line.trim()];
    }
  }
  return null;
}

const plain = (fragment: string) =>
  unescape(fragment.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** The published page content for a Markdown file: [html, title]. As in Claude Code, a heading
 * that opens the document becomes the template's <h1> and leaves the body; with no heading at all
 * the <h1> shows the file name; otherwise the <h1> stays empty and the first heading names the page. */
export function page(source: string, filename: string): [string, string] {
  const text = source
    .replace(/^\ufeff+/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\x00", "\ufffd");
  const [refs] = collectRefs(text.split("\n"));
  const heading = openingHeading(text);
  const body = render(heading ? text.slice(0, heading[0]) + text.slice(heading[1]) : text);
  let title: string;
  let titleHtml: string;
  if (heading) {
    // As Claude Code fills the <h1>: the heading's HTML with whitespace collapsed, or, when that
    // holds a <section> tag (which would take the template's own section), its text escaped.
    titleHtml = new Inline(refs).render(heading[3]).trim().replace(/\s+/g, " ");
    if (/<\/?section\b/i.test(titleHtml)) titleHtml = escape(heading[3].replace(/\s+/g, " ").trim());
    title = plain(titleHtml);
    if (!title && !new RegExp(`<[${WORD}]`, "u").test(titleHtml.replace(/<!--[\s\S]*?-->/g, ""))) {
      titleHtml = escape(filename);
      title = filename;
    }
  } else {
    const first = /<h[1-6]>([\s\S]*?)<\/h[1-6]>/.exec(body);
    title = first ? plain(first[1]!) : "";
    titleHtml = title ? "" : escape(filename);
  }
  const template = String(TEMPLATE).replace(/^\ufeff?<!--[\s\S]*?-->\s*/, "");
  const slots: Record<string, string> = {
    TITLE: titleHtml,
    TAB_TITLE: escape(filename),
    EYEBROW: escape(`Markdown \u00b7 ${filename}`),
    SUMMARY: "",
  };
  const filled = template
    .replace(HEADING_SLOTS, (_whole, slot: string) => slots[slot]!)
    .replace(SECTIONS, () => `<section>${body}</section>`);
  return [filled, title.slice(0, 120).trim() || filename];
}
