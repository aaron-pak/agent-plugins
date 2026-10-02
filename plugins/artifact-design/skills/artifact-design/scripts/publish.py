#!/usr/bin/env python3
"""Publish an HTML artifact as a local file, the way Claude Code's Artifact tool publishes one.

Write the page content exactly as the skill describes for the Artifact tool: no doctype,
<html>, <head> or <body> tags, with the page's <title> and <style> first. Then run

    python3 publish.py page.html [--description "One sentence."] [--title "Name"]
                                 [--out other.html] [--no-open] [--quiet]

It wraps the content in the tool's publish skeleton, adds a Content-Security-Policy that
mirrors the claude.ai artifact allowlist (so a load that claude.ai blocks fails here too),
renders <pre class="mermaid"> blocks the way the claude.ai viewer does, writes the page
(in place unless --out is given), prints its path, and opens it in the browser.
Publishing a file again recognizes the skeleton and replaces it instead of nesting it.
"""

import argparse
import html
import os
import re
import subprocess
import sys
from pathlib import Path

# The skeleton the Artifact tool wraps around every published page (Claude Code 2.1.287).
SKELETON_HEAD = (
    '<!doctype html><html><head><meta charset=utf8>'
    '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
)
SKELETON_RESET = (
    "<style>:root{color-scheme:light;box-sizing:border-box;"
    "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "html{scroll-padding-top:env(safe-area-inset-top,0px)}"
    "body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;"
    "background:#faf9f5;color:#141413}"
    "img{max-width:100%}"
    "[hidden]:not([hidden=until-found i]){display:none!important}</style>"
)
SKELETON_BODY = "</head><body>\n"
SKELETON_END = "\n</body></html>\n"

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
MERMAID = (
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js"></script>\n'
    "<script>mermaid.initialize({startOnLoad:true,theme:"
    "(document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))"
    "==='dark'?'dark':'default'});</script>"
)
SIZE_LIMIT = 16 * 1024 * 1024


def unwrap(text):
    """Return (content, description) with any earlier publish skeleton removed."""
    description = None
    if text.lstrip().startswith(SKELETON_HEAD) and GENERATOR in text:
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
        head_html = re.sub(r"<meta\s+(charset|name=[\"']?viewport)[^>]*>", "", head_html, flags=re.IGNORECASE)
        print("note: the file was a full HTML document; publish.py adds the skeleton, "
              "so write only the page content next time.", file=sys.stderr)
        text = head_html.strip() + "\n" + (body.group(1).strip() if body else "")
    return text.strip("\n"), description


def wrap(content, description):
    head = SKELETON_HEAD + f'<meta http-equiv="Content-Security-Policy" content="{CSP}">' + GENERATOR
    if description:
        head += f'<meta name="description" content="{html.escape(description, quote=True)}">'
    head += SKELETON_RESET + SKELETON_BODY
    tail = ""
    if re.search(r"class\s*=\s*[\"'][^\"']*\bmermaid\b", content) and "mermaid.min.js" not in content:
        tail = "\n" + TAIL_MARK + "\n" + MERMAID
    return head + content + tail + SKELETON_END


def open_in_browser(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
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
    parser.add_argument("--out", type=Path, help="write here instead of publishing in place")
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

    out = args.out or page
    published = wrap(content, description)
    out.write_text(published, encoding="utf-8")
    if len(published.encode("utf-8")) > SIZE_LIMIT:
        warnings.append("the page is over 16MB, which claude.ai would refuse")

    resolved = out.resolve()
    if args.quiet:
        print(resolved)
    else:
        print(f"Published {resolved}\n{resolved.as_uri()}")
        for warning in warnings:
            print(f"warning: {warning}")
    if not args.no_open and not args.quiet and not open_in_browser(resolved):
        print("No browser to open here; give the user the path above.")


if __name__ == "__main__":
    main()
