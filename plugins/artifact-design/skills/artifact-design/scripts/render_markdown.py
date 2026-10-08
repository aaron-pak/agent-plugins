"""Render a Markdown page the way Claude Code's Artifact tool publishes one.

Claude Code (2.1.294) renders a published `.md` file with marked (GitHub-flavored), turns
```mermaid fences into <pre class="mermaid"> blocks, and pours the result into its plan
template (markdown-template.html, byte for byte from the CLI bundle): the eyebrow reads
"Markdown · <file name>", the tab title is the file name, and a heading that opens the
document becomes the page's <h1>. This module does the same with a small renderer of its
own covering the GitHub-flavored Markdown that pages use (headings, paragraphs, emphasis,
links and images, code, lists and task lists, block quotes, tables, rules and raw HTML).
Standard library only.
"""

import html
import re
from pathlib import Path

TEMPLATE = Path(__file__).with_name("markdown-template.html")
HEADING_SLOTS = re.compile(r"\{\{(TITLE|TAB_TITLE|EYEBROW|SUMMARY)\}\}")
SECTIONS = re.compile(r"<section\b[\s\S]*</section>")


def escape(text):
    return html.escape(text, quote=True).replace("&#x27;", "&#39;")


# ---------------------------------------------------------------- inline

PUNCT = re.escape("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
ENTITY = re.compile(r"&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")
RAW_TAG = re.compile(
    r"<!--[\s\S]*?-->|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'=<>`]+))?)*\s*/?>"
    r"|</[A-Za-z][A-Za-z0-9-]*\s*>")
AUTOLINK = re.compile(r"<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>|<([\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+)>")
BARE_URL = re.compile(r"(?:https?://|www\.)[^\s<]+")
LINK_DEST = r"(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))"
LINK_TAIL = re.compile(r"\(\s*" + LINK_DEST + r"(?:\s+(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)")


def trim_url(url):
    """GFM's autolink end: drop trailing punctuation and unbalanced closing parentheses."""
    while url and (url[-1] in "?!.,:;*_~'\"" or url[-1] == ")" and url.count(")") > url.count("(")):
        url = url[:-1]
    return url


def unescape_md(text):
    return re.sub(r"\\([" + PUNCT + "])", r"\1", text)


def escape_text(text):
    """Escape text for HTML, keeping entity references the author wrote."""
    out, last = [], 0
    for match in ENTITY.finditer(text):
        out.append(escape(text[last:match.start()]))
        out.append(match.group(0))
        last = match.end()
    out.append(escape(text[last:]))
    return "".join(out)


class Inline:
    """Inline rendering: code spans, links, raw HTML and escapes become placeholders first, so
    emphasis never reaches inside them; then emphasis runs over what is left."""

    def __init__(self, refs):
        self.refs = refs
        self.slots = []

    def hold(self, rendered):
        self.slots.append(rendered)
        return f"\x00{len(self.slots) - 1}\x00"

    def render(self, text):
        text = self.tokens(text)
        text = self.emphasis(text)
        while "\x00" in text:
            text = re.sub(r"\x00(\d+)\x00", lambda m: self.slots[int(m.group(1))], text)
        return text

    def link(self, label, dest, title, image):
        href = escape(html.unescape(unescape_md(dest or "")))
        attrs = f' title="{escape(html.unescape(unescape_md(title)))}"' if title else ""
        if image:
            alt = re.sub(r"<[^>]*>", "", Inline(self.refs).render(label))
            return f'<img src="{href}" alt="{escape(html.unescape(alt))}"{attrs}>'
        return f'<a href="{href}"{attrs}>{Inline(self.refs).render(label)}</a>'

    def bracket(self, text, start):
        """Match [label] from start, allowing nested brackets; return the end index or -1."""
        depth, i = 0, start
        while i < len(text):
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                run = re.match(r"`+", text[i:]).group(0)
                close = text.find(run, i + len(run))
                i = close + len(run) if close != -1 else i + len(run)
                continue
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return -1

    def tokens(self, text):
        out, i = [], 0
        while i < len(text):
            ch = text[i]
            if ch == "\\" and i + 1 < len(text):
                nxt = text[i + 1]
                if nxt == "\n":
                    out.append(self.hold("<br>"))
                    i += 2
                    continue
                if re.match("[" + PUNCT + "]", nxt):
                    out.append(self.hold(escape(nxt)))
                    i += 2
                    continue
            if ch == "`":
                run = re.match(r"`+", text[i:]).group(0)
                close = re.compile(r"(?<!`)" + run + r"(?!`)").search(text, i + len(run))
                if close:
                    code = text[i + len(run):close.start()].replace("\n", " ")
                    if code.strip() and code.startswith(" ") and code.endswith(" "):
                        code = code[1:-1]
                    out.append(self.hold(f"<code>{escape(code)}</code>"))
                    i = close.end()
                    continue
                out.append(run)
                i += len(run)
                continue
            if ch == "<":
                auto = AUTOLINK.match(text, i)
                if auto:
                    url = auto.group(1) or auto.group(2)
                    href = url if auto.group(1) else "mailto:" + url
                    out.append(self.hold(f'<a href="{escape(href)}">{escape(url)}</a>'))
                    i = auto.end()
                    continue
                tag = RAW_TAG.match(text, i)
                if tag:
                    out.append(self.hold(tag.group(0)))
                    i = tag.end()
                    continue
            if ch in "![" and (ch == "[" or text.startswith("![", i)):
                image = ch == "!"
                start = i + 1 if image else i
                end = self.bracket(text, start)
                if end != -1:
                    label = text[start + 1:end]
                    tail = LINK_TAIL.match(text, end + 1)
                    if tail:
                        dest = tail.group(1) if tail.group(1) is not None else tail.group(2)
                        title = tail.group(3)[1:-1] if tail.group(3) else None
                        out.append(self.hold(self.link(label, dest, title, image)))
                        i = tail.end()
                        continue
                    ref = re.match(r"\[([^\]]*)\]", text[end + 1:])
                    key = normalize_label(ref.group(1) if ref and ref.group(1) else label)
                    if key in self.refs:
                        dest, title = self.refs[key]
                        out.append(self.hold(self.link(label, dest, title, image)))
                        i = end + 1 + (ref.end() if ref else 0)
                        continue
            if ch in "hHwW":
                bare = BARE_URL.match(text, i)
                url = trim_url(bare.group(0)) if bare else ""
                if url and "." in url.split("//")[-1] and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] in "/_")):
                    href = url if "://" in url else "http://" + url
                    out.append(self.hold(f'<a href="{escape(href)}">{escape(url)}</a>'))
                    i += len(url)
                    continue
            if ch == "\n":
                # A line ending in two or more spaces is a hard break; other line breaks stay.
                spaces = 0
                while out and out[-1] == " ":
                    out.pop()
                    spaces += 1
                out.append(self.hold("<br>") if spaces >= 2 else "\n")
                i += 1
                continue
            out.append(ch)
            i += 1
        # Placeholders survive escaping: \x00 and digits are not HTML-special.
        return escape_text("".join(out))

    def emphasis(self, text):
        rules = [
            (r"(?<![\w*])\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*(?![*])", "<em><strong>{}</strong></em>"),
            (r"(?<![\w_])___(?=\S)([\s\S]+?)(?<=\S)___(?![\w_])", "<em><strong>{}</strong></em>"),
            (r"\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*", "<strong>{}</strong>"),
            (r"(?<![\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])", "<strong>{}</strong>"),
            (r"(?<![*])\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?![*])", "<em>{}</em>"),
            (r"(?<![\w_])_(?=[^\s_])([\s\S]+?)(?<=[^\s_])_(?![\w_])", "<em>{}</em>"),
            (r"(?<!~)~~?(?=[^\s~])([\s\S]+?)(?<=[^\s~])~~?(?!~)", "<del>{}</del>"),
        ]
        for _ in range(3):  # nested emphasis, innermost-last
            before = text
            for pattern, template in rules:
                text = re.sub(pattern, lambda m, t=template: t.format(m.group(1)), text)
            if text == before:
                break
        return text


def normalize_label(label):
    return re.sub(r"\s+", " ", label.strip()).casefold()


# ---------------------------------------------------------------- blocks

FENCE = re.compile(r"^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$")
ATX = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
HR = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
QUOTE = re.compile(r"^ {0,3}> ?")
BULLET = re.compile(r"^( {0,3})([*+-])([ \t]+|$)")
ORDERED = re.compile(r"^( {0,3})(\d{1,9})([.)])([ \t]+|$)")
SETEXT = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
TABLE_DELIM = re.compile(r"^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
REF_DEF = re.compile(r"^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(\"[^\"]*\"|'[^']*'|\([^)]*\)))?[ \t]*$")
HTML_BLOCK = re.compile(
    r"^ {0,3}(?:<!--|<\?|<![A-Za-z]|<!\[CDATA\[|</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|pre|script|style|textarea|svg|canvas|video|audio|picture|img|figure|span|a|button|input|label|select|small|details)(?:[\s/>]|$))",
    re.IGNORECASE)


def expand_tabs(line):
    return line.expandtabs(4) if "\t" in line[:8] else line


def starts_block(line):
    """Whether a line interrupts a paragraph."""
    return bool(FENCE.match(line) or ATX.match(line) or HR.match(line) or QUOTE.match(line)
                or HTML_BLOCK.match(line) or BULLET.match(line) and line[BULLET.match(line).end():].strip()
                or ORDERED.match(line) and ORDERED.match(line).group(2) == "1" and line[ORDERED.match(line).end():].strip())


def split_cells(row):
    row = row.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|") and not row.endswith("\\|"):
        row = row[:-1]
    # As in GFM, every unescaped pipe splits cells, inside code spans too.
    cells, cur, i = [], [], 0
    while i < len(row):
        ch = row[i]
        if ch == "\\" and i + 1 < len(row) and row[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append("".join(cur).strip())
    return cells


class Blocks:
    def __init__(self, refs):
        self.refs = refs

    def inline(self, text):
        return Inline(self.refs).render(text)

    def render(self, lines):
        return self.blocks(lines)[0]

    def blocks(self, lines, tight=False):
        """Render block lines; also say whether a blank line separates two of the top-level blocks.
        In a tight list item (tight=True) top-level paragraphs lose their <p>."""
        out, i, spaced, gap = [], 0, False, False
        while i < len(lines):
            line = lines[i]
            if not line.strip():
                gap = bool(out)
                i += 1
                continue
            spaced, gap = spaced or gap, False
            fence = FENCE.match(line)
            if fence and not (fence.group(2)[0] == "`" and "`" in fence.group(3)):
                indent, marker, info = len(fence.group(1)), fence.group(2), fence.group(3)
                body, i = [], i + 1
                while i < len(lines):
                    close = re.match(r"^ {0,3}(" + re.escape(marker[0]) + "{" + str(len(marker)) + r",})[ \t]*$", lines[i])
                    if close:
                        i += 1
                        break
                    body.append(re.sub(r"^ {0," + str(indent) + "}", "", lines[i]))
                    i += 1
                code = "\n".join(body)
                lang = unescape_md(info).split()[0] if info.strip() else ""
                if lang.lower() == "mermaid":
                    out.append(f'<pre class="mermaid">{escape(code)}</pre>\n')
                else:
                    cls = f' class="language-{escape(lang)}"' if lang else ""
                    out.append(f"<pre><code{cls}>{escape(code)}{chr(10) if body else ''}</code></pre>\n")
                continue
            heading = ATX.match(line)
            if heading:
                level = len(heading.group(1))
                out.append(f"<h{level}>{self.inline((heading.group(2) or '').strip())}</h{level}>\n")
                i += 1
                continue
            if HR.match(line):
                out.append("<hr>\n")
                i += 1
                continue
            if QUOTE.match(line):
                body = []
                while i < len(lines) and lines[i].strip():
                    if QUOTE.match(lines[i]):
                        body.append(QUOTE.sub("", lines[i], count=1))
                    elif body and not starts_block(lines[i]):
                        body.append(lines[i])  # lazy continuation
                    else:
                        break
                    i += 1
                out.append(f"<blockquote>\n{self.render(body)}</blockquote>\n")
                continue
            if BULLET.match(line) or ORDERED.match(line):
                html_list, i = self.list(lines, i)
                out.append(html_list)
                continue
            if line.startswith("    "):
                body = []
                while i < len(lines) and (lines[i].startswith("    ") or not lines[i].strip()):
                    body.append(lines[i][4:])
                    i += 1
                while body and not body[-1].strip():
                    body.pop()
                out.append(f"<pre><code>{escape(chr(10).join(body))}\n</code></pre>\n")
                continue
            if HTML_BLOCK.match(line):
                body = []
                comment = line.lstrip().startswith("<!--")
                while i < len(lines) and (lines[i].strip() or comment):
                    body.append(lines[i])
                    i += 1
                    if comment and "-->" in body[-1]:
                        break
                out.append("\n".join(body) + "\n")
                continue
            if "|" in line and i + 1 < len(lines) and TABLE_DELIM.match(lines[i + 1]):
                header, aligns = split_cells(line), split_cells(lines[i + 1])
                if len(header) == len(aligns):
                    table, i = self.table(lines, i, header, aligns)
                    out.append(table)
                    continue
            # A paragraph, which may end in a setext underline.
            para, i = [line], i + 1
            level = 0
            while i < len(lines) and lines[i].strip():
                setext = SETEXT.match(lines[i])
                if setext:
                    level = 1 if setext.group(1)[0] == "=" else 2
                    i += 1
                    break
                if starts_block(lines[i]) or ("|" in lines[i] and i + 1 < len(lines) and TABLE_DELIM.match(lines[i + 1])):
                    break
                para.append(lines[i])
                i += 1
            text = "\n".join(part.lstrip() for part in para).rstrip()
            if level:
                out.append(f"<h{level}>{self.inline(text)}</h{level}>\n")
            elif tight:
                out.append(self.inline(text))
            else:
                out.append(f"<p>{self.inline(text)}</p>\n")
        return "".join(out), spaced

    def table(self, lines, i, header, aligns):
        def align(cell):
            left, right = cell.startswith(":"), cell.endswith(":")
            return ' align="center"' if left and right else ' align="right"' if right else ' align="left"' if left else ""
        attrs = [align(cell) for cell in aligns]
        out = ["<table>\n<thead>\n<tr>\n"]
        out += [f"<th{attrs[n]}>{self.inline(cell)}</th>\n" for n, cell in enumerate(header)]
        out.append("</tr>\n</thead>\n")
        i += 2
        rows = []
        while i < len(lines) and lines[i].strip() and not starts_block(lines[i]):
            cells = split_cells(lines[i])
            cells = (cells + [""] * len(header))[:len(header)]
            rows.append("<tr>\n" + "".join(f"<td{attrs[n]}>{self.inline(cell)}</td>\n" for n, cell in enumerate(cells)) + "</tr>\n")
            i += 1
        if rows:
            out.append("<tbody>" + "".join(rows) + "</tbody>")
        out.append("</table>\n")
        return "".join(out), i

    def list(self, lines, i):
        first = BULLET.match(lines[i]) or ORDERED.match(lines[i])
        ordered = first.re is ORDERED
        kind = (first.group(3) if ordered else first.group(2))
        start = int(first.group(2)) if ordered else None
        # As in marked, a list is loose when a blank line ends an item that another item follows,
        # or separates two blocks inside an item.
        items, loose, gap = [], False, False
        while i < len(lines):
            match = (ORDERED if ordered else BULLET).match(lines[i])
            if not match or (match.group(3) if ordered else match.group(2)) != kind:
                break
            loose = loose or gap
            spacing = match.group(4) if ordered else match.group(3)
            content_col = match.end() if 1 <= len(spacing) <= 4 else match.end() - len(spacing) + 1
            body = [lines[i][match.end():] if len(spacing) <= 4 else lines[i][content_col:]]
            i += 1
            gap = False
            while i < len(lines):
                line = lines[i]
                if not line.strip():
                    body.append("")
                    gap = True
                    i += 1
                    continue
                indent = len(line) - len(line.lstrip(" "))
                if indent >= content_col:
                    body.append(line[content_col:])
                    gap = False
                    i += 1
                    continue
                if not gap and not starts_block(line) and not (BULLET.match(line) or ORDERED.match(line)):
                    body.append(line.lstrip())  # lazy continuation of the item's paragraph
                    i += 1
                    continue
                break
            while body and not body[-1].strip():
                body.pop()
            items.append(body)
        tasks = []
        for body in items:
            check = re.match(r"^\[([ xX])\][ \t]+", body[0]) if body else None
            checked = 'checked="" ' if check and check.group(1) != " " else ""
            tasks.append(f'<input {checked}disabled="" type="checkbox"> ' if check else "")
            if check:
                body[0] = body[0][check.end():]
            loose = loose or self.blocks(body)[1]
        tag = "ol" if ordered else "ul"
        attr = f' start="{start}"' if ordered and start != 1 else ""
        out = [f"<{tag}{attr}>\n"]
        for task, body in zip(tasks, items):
            rendered = self.blocks(body, tight=not loose)[0]
            if not loose:
                rendered = task + rendered.rstrip("\n")
            elif task:
                rendered = rendered.replace("<p>", "<p>" + task, 1) if rendered.startswith("<p>") else task + rendered
            out.append(f"<li>{rendered}</li>\n")
        out.append(f"</{tag}>\n")
        return "".join(out), i


def collect_refs(lines):
    """Pull out link reference definitions ([label]: url "title") outside code fences."""
    refs, kept, fence = {}, [], None
    for line in lines:
        match = FENCE.match(line)
        if fence:
            if re.match(r"^ {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}[ \t]*$", line):
                fence = None
        elif match:
            fence = match.group(2)
        elif REF_DEF.match(line):
            ref = REF_DEF.match(line)
            key = normalize_label(ref.group(1))
            if key not in refs:
                title = ref.group(4)[1:-1] if ref.group(4) else None
                refs[key] = (ref.group(2) if ref.group(2) is not None else ref.group(3), title)
            continue
        kept.append(line)
    return refs, kept


def render(text):
    """Markdown to HTML, the shapes marked produces for the same input."""
    lines = [expand_tabs(line) for line in text.split("\n")]
    refs, lines = collect_refs(lines)
    return Blocks(refs).render(lines)


# ---------------------------------------------------------------- the page

FRONT_MATTER = re.compile(r"^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)")
YAML_LINE = re.compile(r"^(?:[ \t]*$|[ \t]+\S|- |[\w\"'.-][^:#]*:(?:[ \t]|$))")


def opening_heading(text):
    """The heading that opens the document (after YAML front matter and comments), as (start, end, level, text)."""
    pos = 0
    front = FRONT_MATTER.match(text)
    if front and all(YAML_LINE.match(line) and not ATX.match(line) for line in (front.group(1) or "").splitlines()):
        pos = front.end()
    while True:
        rest = text[pos:]
        stripped = rest.lstrip(" \t\n")
        if stripped.startswith("<!--") and "-->" in stripped:
            pos = len(text) - len(stripped) + stripped.index("-->") + 3
            continue
        pos = len(text) - len(stripped)
        break
    line_end = text.find("\n", pos)
    line = text[pos:line_end if line_end != -1 else len(text)]
    atx = ATX.match(line)
    if atx:
        end = line_end + 1 if line_end != -1 else len(text)
        return pos, end, len(atx.group(1)), (atx.group(2) or "").strip()
    if line.strip() and line_end != -1:
        next_end = text.find("\n", line_end + 1)
        underline = text[line_end + 1:next_end if next_end != -1 else len(text)]
        setext = SETEXT.match(underline)
        if setext and not starts_block(line):
            end = next_end + 1 if next_end != -1 else len(text)
            return pos, end, 1 if setext.group(1)[0] == "=" else 2, line.strip()
    return None


def page(text, filename):
    """The published page content for a Markdown file: (html, title). As in Claude Code, a heading
    that opens the document becomes the template's <h1> and leaves the body; with no heading at all
    the <h1> shows the file name; otherwise the <h1> stays empty and the first heading names the page."""
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = [expand_tabs(line) for line in text.split("\n")]
    refs, _ = collect_refs(lines)
    heading = opening_heading(text)
    body_text = text[:heading[0]] + text[heading[1]:] if heading else text
    body = render(body_text)
    plain = lambda fragment: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", fragment))).strip()
    if heading:
        title_html = Inline(refs).render(heading[3])
        title = plain(title_html)
        if not title and not re.search(r"<\w", title_html):
            title_html, title = escape(filename), filename
    else:
        first = re.search(r"<h[1-6]>([\s\S]*?)</h[1-6]>", body)
        title = plain(first.group(1)) if first else ""
        title_html = "" if title else escape(filename)
    template = re.sub(r"^\ufeff?<!--[\s\S]*?-->\s*", "", TEMPLATE.read_text(encoding="utf-8"))
    slots = {"TITLE": title_html, "TAB_TITLE": escape(filename), "EYEBROW": escape(f"Markdown \u00b7 {filename}"),
             "SUMMARY": ""}
    filled = HEADING_SLOTS.sub(lambda m: slots[m.group(1)], template)
    filled = SECTIONS.sub(lambda m: f"<section>{body}</section>", filled, count=1)
    return filled, title[:120].strip() or filename
