#!/usr/bin/env python3
"""Publish an HTML artifact as a local file, the way Claude Code's Artifact tool publishes one.

Write the page content exactly as the skill describes for the Artifact tool: no doctype,
<html>, <head> or <body> tags, with the page's <title> and <style> first. Then run

    python3 publish.py page.html [--description "One sentence."] [--title "Name"]
                                 [--out other.html] [--no-open] [--quiet]

Like the Artifact tool, it leaves page.html as written and publishes a copy: page.published.html
beside it (or --out), so relative paths to the page's own files still resolve. The copy is
wrapped in the tool's publish skeleton, carries a Content-Security-Policy that mirrors the
claude.ai artifact allowlist (so a load that claude.ai blocks fails here too), and draws
<pre class="mermaid"> blocks with the Mermaid runtime Claude Code adds. A Markdown file
(.md) is rendered into the document template Claude Code uses for one. The script prints the
published path, the local stand-in for the artifact's link, and opens it in the browser.
To update, edit page.html and publish it again. A file that already carries the skeleton
is unwrapped first instead of nested; any other full HTML document is wrapped as it is.
"""

import argparse
import html
import os
import re
import subprocess
import sys
from pathlib import Path

# The skeleton the Artifact tool wraps around every published page (Claude Code 2.1.293).
# A page whose own viewport meta leaves out viewport-fit=cover gets the plain variant,
# without the safe-area padding, as the tool does.
SKELETON_START = "<!doctype html><html><head><meta charset=utf8>"
VIEWPORT_COVER = '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
VIEWPORT_PLAIN = '<meta name=viewport content="width=device-width,initial-scale=1">'
SKELETON_HEAD = SKELETON_START + VIEWPORT_COVER
RESET_BASE = (
    "body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;"
    "background:#faf9f5;color:#141413}"
    "img{max-width:100%}"
    "[hidden]:not([hidden=until-found i]){display:none!important}</style>"
)
SKELETON_RESET = (
    "<style>:root{color-scheme:light;box-sizing:border-box;"
    "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "html{scroll-padding-top:env(safe-area-inset-top,0px)}" + RESET_BASE
)
PLAIN_RESET = "<style>:root{color-scheme:light}" + RESET_BASE
SKELETON_BODY = "</head><body>\n"
SKELETON_END = "\n</body></html>"

# Claude Code's own model of the artifact viewer's content policy (its preview's, 2.1.294),
# with the five script CDNs the page contract allows, as a CSP. Its `webrtc 'block'` directive is
# left out: Chromium doesn't know it and logs an error for it on every load of the page.
SCRIPT_HOSTS = (
    "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com "
    "https://cdn.tailwindcss.com https://code.jquery.com"
)
CSP = "; ".join([
    "default-src 'self'",
    f"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: {SCRIPT_HOSTS}",
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
])

GENERATOR = '<meta name="generator" content="artifact-design publish.py">'
TAIL_MARK = "<!-- artifact-design publish.py -->"
# The Mermaid runtime Claude Code 2.1.293 adds to a page with a <pre class="mermaid"> block,
# byte for byte, except that Mermaid 11.16.1 loads from jsDelivr (the same file, checked by
# sha256) instead of claude.ai's /_runtime/ path.
MERMAID = (Path(__file__).with_name("mermaid-runtime.html")).read_text(encoding="utf-8")
SIZE_LIMIT = 16 * 1024 * 1024
TITLE_SCAN = 8192  # the Artifact tool reads a page's <title> from this many characters
TITLE_MAX = 280


def read_source(path):
    """The page file's text, as UTF-8 (a byte-order mark is dropped). Like the Artifact tool,
    a file in another encoding is refused rather than published garbled."""
    data = Path(path).read_bytes()
    bom = 3 if data.startswith(b"\xef\xbb\xbf") else 0
    try:
        return data[bom:].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(
            f"the source file is not valid UTF-8 text (first invalid byte at {bom + error.start}). It may be "
            "saved in another encoding or contain binary data. Save the page as UTF-8, then publish again. "
            "Nothing was published.") from None


def page_title(content):
    """The page's name, read as the Artifact tool reads it: the first <title> in the first 8192
    characters, comments left out and nothing from the first <svg> on (an icon's <title> names
    the icon, not the page), entities decoded, whitespace collapsed, at most 280 characters."""
    head = re.sub(r"<!--[\s\S]*?(?:-->|$)", "", content[:TITLE_SCAN])
    svg = re.search(r"<svg", head, re.IGNORECASE)
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", head[:svg.start()] if svg else head, re.IGNORECASE)
    if not match:
        return None
    text = "".join(" " if ord(ch) <= 31 or 127 <= ord(ch) <= 159 else ch for ch in html.unescape(match.group(1)))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:TITLE_MAX] or None


# What publishing puts around a page: the skeleton, with this script's metas when it published
# the page, and the diagram runtimes before the end. A page that carries exactly this (one this
# script or the Artifact tool published, read back or downloaded) is unwrapped before it is
# wrapped again, as the Artifact tool unwraps its own skeleton; nothing else is. Its line breaks
# may be CRLF, as a page written as text on Windows has them.
SKELETON_RE = re.compile(
    r'(?i:<!doctype html>)<html(?: lang="([^"]{1,35})")?><head><meta charset=utf8>'
    r'<meta name=viewport content="width=device-width,initial-scale=1(,viewport-fit=cover)?">'
    r'((?:<meta http-equiv="Content-Security-Policy" content="[^"]*">)?(?:' + re.escape(GENERATOR) + r')?'
    r'(?:<link rel="icon" href="[^"]*">)?(?:<meta name="description" content="([^"]*)">)?)'
    r'<style>[^<]*</style></head><body>\r?\n')
TAIL_RE = re.compile(r"\r?\n" + re.escape(TAIL_MARK) + r"\r?\n")
RUNTIME_BLOCKS = re.compile(
    r"(?:\r?\n)?<!--claude-(mermaid|hljs|chart)-runtime-begin:\d+-->[\s\S]*?<!--claude-\1-runtime-end-->(?:\r?\n)?")


def unwrap(text):
    """Return (content, description, lang, cover) with an earlier publish skeleton removed.
    lang and cover are what the skeleton carried, for wrapping the page the same way again;
    cover is None when there was no skeleton. Leading and trailing newlines are dropped."""
    rest = text.lstrip()
    match = SKELETON_RE.match(rest)
    if not match or not rest.rstrip().endswith("</body></html>"):
        return text.strip("\r\n"), None, None, None
    body = rest[match.end():rest.rstrip().rfind("</body></html>")]
    tail = TAIL_RE.search(body)
    if tail:
        body = body[:tail.start()]
    body = RUNTIME_BLOCKS.sub("", body)
    description = html.unescape(match.group(4)) if match.group(4) is not None else None
    return body.strip("\r\n"), description, match.group(1), bool(match.group(2))


def is_full_document(content):
    """Whether the page was written as a whole HTML document (doctype or <html> first)."""
    lead = re.sub(r"^(?:\s|<!--[\s\S]*?-->)*", "", content)
    return bool(re.match(r"<!doctype\b|<html[\s>]", lead, re.IGNORECASE))


def covers_safe_area(content, default=True):
    """Whether the page runs edge to edge: true unless its own viewport meta leaves out viewport-fit=cover."""
    viewports = re.findall(r"<meta\b[^>]*\bname\s*=\s*[\"']?viewport\b[^>]*>", content, re.IGNORECASE)
    if not viewports:
        return default
    return any(re.search(r"viewport-fit\s*=\s*cover", tag, re.IGNORECASE) for tag in viewports)


def uses_mermaid(content):
    """Whether the page has a <pre> element with the class mermaid, the only element Claude Code draws as a diagram.

    Comments and the raw text of script, style, textarea and template elements can mention
    <pre class="mermaid"> without making a diagram, so they are left out. A page that loads
    Mermaid itself with a <script src> draws its own diagrams and gets no second runtime.
    """
    markup = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    if re.search(r"""<script\b[^>]*?\ssrc\s*=\s*["']?[^"'\s>]*mermaid""", markup, re.IGNORECASE):
        return False
    markup = re.sub(r"<(script|style|textarea|template|title)\b[^>]*>.*?</\1\s*>", "", markup,
                    flags=re.DOTALL | re.IGNORECASE)
    for match in re.finditer(r"""<pre(?=[\s/>])[^<>]*?\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
                             markup, re.IGNORECASE):
        if "mermaid" in (match.group(1) or match.group(2) or match.group(3) or "").split():
            return True
    return False


def wrap(content, description, lang=None, cover=None):
    """The published page: the skeleton around the content as it is (a full document included,
    whose <html> and <body> attributes the browser then carries over), as the Artifact tool wraps
    it. lang and cover come from an unwrapped skeleton, as the tool keeps them on a round trip."""
    cover = covers_safe_area(content, True if cover is None else cover)
    head = SKELETON_START.replace("<html>", f'<html lang="{lang}">' if lang else "<html>")
    head += VIEWPORT_COVER if cover else VIEWPORT_PLAIN
    head += f'<meta http-equiv="Content-Security-Policy" content="{CSP}">' + GENERATOR
    if description:
        head += f'<meta name="description" content="{html.escape(description, quote=True)}">'
    head += (SKELETON_RESET if cover else PLAIN_RESET) + SKELETON_BODY
    tail = ""
    if uses_mermaid(content):
        tail = "\n" + TAIL_MARK + "\n" + MERMAID.rstrip("\n")
    return head + content + tail + SKELETON_END


def markdown_page(text, filename):
    """A Markdown file's page content and title, laid out as the Artifact tool lays one out."""
    import render_markdown
    return render_markdown.page(text, filename)


FULL_DOCUMENT_NOTE = ("The file was a full HTML document; it was published inside the skeleton as it is. "
                      "Publishing adds the skeleton, so write only the page content next time.")
OWN_FILES_FETCH_NOTE = ("The page fetch()es its own files. claude.ai serves them, but a browser refuses fetch() "
                        "over file://, so the page opened from this machine can't load them, and preview "
                        "doesn't serve them either.")


def fetches_own_files(content):
    return bool(re.search(r"""fetch\(\s*[`'"](?![a-z]+:)""", content))


def open_in_browser(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        elif os.name == "nt":
            os.startfile(str(path))  # noqa: S606
        elif os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            subprocess.Popen(["xdg-open", str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        else:
            return False
        return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description="Publish an HTML artifact as a local file.")
    parser.add_argument("page", type=Path, help="the page file to publish (.html, or .md)")
    parser.add_argument("--description", help="one sentence explaining the page (the Artifact tool's description)")
    parser.add_argument("--title", help="name to use when the page has no <title> (the Artifact tool's title)")
    parser.add_argument("--out", type=Path, help="write the published page here instead of beside the file")
    parser.add_argument("--no-open", action="store_true", help="don't open the page in a browser")
    parser.add_argument("--quiet", action="store_true", help="print only the output path")
    args = parser.parse_args()

    page = args.page
    try:
        raw = read_source(page)
    except (OSError, ValueError) as error:
        sys.exit(f"publish.py: {page}: {error}")
    warnings = []
    lang = cover = None
    if page.suffix.lower() in (".md", ".markdown"):
        content, _ = markdown_page(raw, page.name)
        old_description = None
    else:
        content, old_description, lang, cover = unwrap(raw)
        if cover is None and is_full_document(content):
            warnings.append(FULL_DOCUMENT_NOTE)
        if not page_title(content):
            if args.title:
                content = f"<title>{html.escape(args.title)}</title>\n" + content
            else:
                warnings.append("no <title> in the first 8KB, so the page has no name; add one or pass --title")
    description = args.description or old_description
    if not description:
        warnings.append("no --description; give the page a one-sentence explanation")

    if args.out:
        out = args.out
    elif page.name.endswith(".published.html"):
        out = page
    else:
        out = page.with_name(page.stem + ".published.html")
    if fetches_own_files(content):
        warnings.append(OWN_FILES_FETCH_NOTE.replace("preview doesn't", "preview.mjs doesn't"))
    published = wrap(content, description, lang, cover)
    out.write_bytes(published.encode("utf-8"))  # as written: write_text would turn \n into \r\n on Windows
    if len(published.encode("utf-8")) > SIZE_LIMIT:
        warnings.append("the page is over 16MB, which claude.ai would refuse")

    resolved = out.resolve()
    if args.quiet:
        print(resolved)
    else:
        print(f"Published {page.resolve()} at {resolved.as_uri()}")
        if out != page:
            print(f"To update: edit {page} and publish it again; {out.name} is replaced. "
                  "Give the user the published path, not the file you wrote.")
        for warning in warnings:
            print(f"warning: {warning}")
    if not args.no_open and not args.quiet and not open_in_browser(resolved):
        print("No browser to open here, so the page was not opened; give the user the path above.")


if __name__ == "__main__":
    main()
