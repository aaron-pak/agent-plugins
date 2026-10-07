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
<pre class="mermaid"> blocks with the Mermaid runtime Claude Code adds. The script prints the
published path, the local stand-in for the artifact's link, and opens it in the browser.
To update, edit page.html and publish it again. A file that already carries the skeleton
is unwrapped first instead of nested.
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

# The claude.ai artifact allowlist from the skill's page contract, as a CSP.
SCRIPT_HOSTS = (
    "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com "
    "https://cdn.tailwindcss.com https://code.jquery.com"
)
CSP = "; ".join([
    "default-src 'self' data: blob:",
    f"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: {SCRIPT_HOSTS}",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
])

GENERATOR = '<meta name="generator" content="artifact-design publish.py">'
TAIL_MARK = "<!-- artifact-design publish.py -->"
# The Mermaid runtime Claude Code 2.1.293 adds to a page with a <pre class="mermaid"> block,
# byte for byte, except that Mermaid 11.16.1 loads from jsDelivr (the same file, checked by
# sha256) instead of claude.ai's /_runtime/ path.
MERMAID = (Path(__file__).with_name("mermaid-runtime.html")).read_text(encoding="utf-8")
SIZE_LIMIT = 16 * 1024 * 1024


def unwrap(text):
    """Return (content, description) with any earlier publish skeleton removed."""
    description = None
    if text.lstrip().startswith(SKELETON_START) and GENERATOR in text:
        head, _, rest = text.partition(SKELETON_BODY)
        match = re.search(r'<meta name="description" content="([^"]*)">', head)
        if match:
            description = html.unescape(match.group(1))
        tail = rest.find(TAIL_MARK)
        if tail == -1:
            tail = rest.rfind("</body></html>")
        text = rest[:tail] if tail != -1 else rest
        return text.strip("\n"), description

    # A full document written by hand: keep what it put in the head and body.
    if re.match(r"\s*(<!doctype[^>]*>\s*)?<html", text, re.IGNORECASE):
        head = re.search(r"<head[^>]*>(.*?)</head>", text, re.IGNORECASE | re.DOTALL)
        body = re.search(r"<body[^>]*>(.*)</body>", text, re.IGNORECASE | re.DOTALL)
        head_html = head.group(1) if head else ""
        head_html = re.sub(r"<meta\s+charset[^>]*>", "", head_html, flags=re.IGNORECASE)
        print("note: the file was a full HTML document; publish.py adds the skeleton, "
              "so write only the page content next time.", file=sys.stderr)
        text = head_html.strip() + "\n" + (body.group(1).strip() if body else "")
    return text.strip("\n"), description


def covers_safe_area(content):
    """Whether the page runs edge to edge: true unless its own viewport meta leaves out viewport-fit=cover."""
    viewports = re.findall(r"<meta\b[^>]*\bname\s*=\s*[\"']?viewport\b[^>]*>", content, re.IGNORECASE)
    return not viewports or any(re.search(r"viewport-fit\s*=\s*cover", tag, re.IGNORECASE) for tag in viewports)


def uses_mermaid(content):
    """Whether the page has a <pre> element with the class mermaid, the only element Claude Code draws as a diagram.

    Comments and the raw text of script, style, textarea and template elements can mention
    <pre class="mermaid"> without making a diagram, so they are left out.
    """
    if "mermaid.min.js" in content:
        return False
    markup = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    markup = re.sub(r"<(script|style|textarea|template|title)\b[^>]*>.*?</\1\s*>", "", markup,
                    flags=re.DOTALL | re.IGNORECASE)
    for match in re.finditer(r"""<pre(?=[\s/>])[^<>]*?\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
                             markup, re.IGNORECASE):
        if "mermaid" in (match.group(1) or match.group(2) or match.group(3) or "").split():
            return True
    return False


def wrap(content, description):
    cover = covers_safe_area(content)
    head = SKELETON_START + (VIEWPORT_COVER if cover else VIEWPORT_PLAIN)
    head += f'<meta http-equiv="Content-Security-Policy" content="{CSP}">' + GENERATOR
    if description:
        head += f'<meta name="description" content="{html.escape(description, quote=True)}">'
    head += (SKELETON_RESET if cover else PLAIN_RESET) + SKELETON_BODY
    tail = ""
    if uses_mermaid(content):
        tail = "\n" + TAIL_MARK + "\n" + MERMAID.rstrip("\n")
    return head + content + tail + SKELETON_END


def open_in_browser(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif os.name == "nt":
            os.startfile(str(path))  # noqa: S606
        elif os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            return False
        return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description="Publish an HTML artifact as a local file.")
    parser.add_argument("page", type=Path, help="the page file to publish")
    parser.add_argument("--description", help="one sentence explaining the page (the Artifact tool's description)")
    parser.add_argument("--title", help="name to use when the page has no <title> (the Artifact tool's title)")
    parser.add_argument("--out", type=Path, help="write the published page here instead of beside the file")
    parser.add_argument("--no-open", action="store_true", help="don't open the page in a browser")
    parser.add_argument("--quiet", action="store_true", help="print only the output path")
    args = parser.parse_args()

    page = args.page
    if page.suffix.lower() in (".md", ".markdown"):
        print(f"{page.resolve()}\nMarkdown pages are published as they are; nothing to wrap.")
        return

    content, old_description = unwrap(page.read_text(encoding="utf-8"))
    description = args.description or old_description
    warnings = []
    if not re.search(r"<title[\s>]", content[:8192], re.IGNORECASE):
        if args.title:
            content = f"<title>{html.escape(args.title)}</title>\n" + content
        else:
            warnings.append("no <title> in the first 8KB, so the page has no name; add one or pass --title")
    if not description:
        warnings.append("no --description; give the page a one-sentence explanation")

    if args.out:
        out = args.out
    elif page.name.endswith(".published.html"):
        out = page
    else:
        out = page.with_name(page.stem + ".published.html")
    if re.search(r"""fetch\(\s*[`'"](?![a-z]+:)""", content):
        warnings.append("the page fetch()es its own files, which a browser refuses over file://; "
                        "claude.ai serves them, and so does preview.mjs, but opening the file locally won't")
    published = wrap(content, description)
    out.write_text(published, encoding="utf-8")
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
        print("No browser to open here; give the user the path above.")


if __name__ == "__main__":
    main()
