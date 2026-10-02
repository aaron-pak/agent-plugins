#!/usr/bin/env python3
"""An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.

It exposes one tool, `Artifact`, with the claude.ai tool's actions that make sense on a
local machine:

- quickstart: the page contract and design guidance, the same text the claude.ai tool's
  quickstart returns for a plain page (read from the bundled artifact-design skill).
- publish: wraps the page in the claude.ai publish skeleton and writes it to an artifacts
  folder (ARTIFACTS_DIR, default ~/artifacts), one folder per artifact, keyed by the
  source file so publishing the same file again updates the same artifact.
- preview: renders the page at desktop and phone widths in light and dark and lists what
  breaks (scripts/preview.mjs; needs Node and Playwright).
- list, read, open: the published artifacts.

Standard library only. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
"""

import html
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = Path(os.environ.get("ARTIFACT_PLUGIN_ROOT") or HERE.parent)
SKILL_DIR = PLUGIN_ROOT / "skills" / "artifact-design"
# Bundled with the skill, the server reads the skill's text and scripts; on its own, its copies.
GUIDANCE = SKILL_DIR / "SKILL.md" if (SKILL_DIR / "SKILL.md").is_file() else HERE / "guidance.md"
SCRIPTS = SKILL_DIR / "scripts" if (SKILL_DIR / "scripts" / "publish.py").is_file() else HERE
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
import publish as page_publish  # noqa: E402  (scripts/publish.py: skeleton, CSP, unwrap)

STORE = Path(os.environ.get("ARTIFACTS_DIR") or Path.home() / "artifacts").expanduser()
INDEX = STORE / "index.json"
PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]

INSTRUCTIONS = (
    "This server's Artifact tool publishes HTML pages (reports, explainers, plans, dashboards, "
    "tools, mockups) as local files and previews them, the way claude.ai's Artifact tool does. "
    "Before writing a new artifact, call Artifact with action \"quickstart\" (or load the "
    "artifact-design skill when it is installed); then write the page to a file and publish it "
    "with Artifact, which wraps it in the page skeleton. Give the user the published link. "
    "Where a built-in Artifact tool that publishes to claude.ai is also available, use that one "
    "instead; this server is for harnesses without it."
)

DESCRIPTION = """The Artifact tool renders an HTML file as an Artifact: a web page published as a local file on this machine and opened in the browser. Use it when a page would be clearer than terminal text, or when the person would use the page rather than only read it, such as a report, explainer, plan, dashboard, tool, or mockup, and whenever the person asks for an artifact or for an HTML page. Where a built-in Artifact tool that publishes to claude.ai is also available, use that one instead.

**Before writing the file, load the page-design guidance**: call this tool with `action: "quickstart"`, or load the `artifact-design` skill when it is installed (a quickstart result counts as loading it). Then write the content to a file and call Artifact with its path.

**If you write a page before that guidance has loaded**, its contract still applies. Give the page a `<title>` that is a name of two to four words, never "Name: explainer", and put the explanation in `description`. Write only the page content: no doctype, `<html>`, `<head>` or `<body>` tags, because publishing wraps the page in a skeleton. Define colors as tokens on `:root`, redefine them for dark mode under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`, and give `body` an explicit background. Load external scripts only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, load stylesheets only from Google Fonts, and put everything else inline. Make the layout work at phone width, with a 16px side gutter and no horizontal page scroll.

**Format**: always author the page as `.html`, and publish a `.md` file only when a loaded skill explicitly asks for one. When the person shares a Markdown document or asks to turn one into an artifact, build an HTML page from its content, keeping its substance and designing the page as you would any other artifact rather than transcribing the Markdown one to one.

**Browser storage**: `localStorage`, `sessionStorage` and IndexedDB work, but what a page stores lives only in that viewer's browser. It can come back empty, or the accessor can throw, so wrap every read and write in try/catch and make the page render correctly without it. Use it only for per-viewer conveniences, such as a remembered tab or filter.

**Size**: keep the rendered page at 16MB or smaller; embedded `data:` URIs count toward that limit.

**Supporting files**: a multi-file artifact (stylesheets, scripts, data, images) publishes its other files through `files`, which maps each published path (relative, no leading slash, as the HTML references it) to a source file. Files left out of a later publish are kept.

**Calls**: `action` picks one (publish when omitted):
- **publish**: takes `file_path`, plus `icon` on a first publish and a one-sentence `description`. Publishing the same `file_path` again updates that artifact in place and keeps its link; pass `url` to update a different one.
- **quickstart**: returns the page contract and the design guidance for a plain page. Read-only.
- **preview**: takes `file_path` (the page you wrote, before or after publishing) and renders it at desktop and phone widths in light and dark, returning screenshot paths and a list of overflow, unreadable colors, blocked loads and script errors. It needs Node and Playwright; when they are missing it says so.
- **read**: takes `url` and returns the published page.
- **list**: returns the published artifacts, newest first.
- **open**: takes `url` and opens it in the browser.

**To update** an artifact published earlier, call Artifact again with the same file path, which republishes it to the same link. A different path creates a new link.

**Files you did not write**: read the whole file before publishing it."""

SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["publish", "quickstart", "preview", "read", "list", "open"],
            "description": "Omitting it means 'publish'.",
        },
        "file_path": {"type": "string", "description": "publish and preview: the page file (.html, or .md only when a skill says so)."},
        "description": {"type": "string", "description": "publish: one sentence explaining the page."},
        "title": {"type": "string", "description": "publish: the fallback title for an HTML page whose file has no <title>."},
        "icon": {"type": "string", "description": "publish: one short generic word for the page's tab icon, such as chart, calendar, recipe, code or map. Pass it on a first publish only."},
        "files": {
            "type": "object",
            "additionalProperties": {"type": ["string", "null"]},
            "description": "publish: supporting files as {\"published/path\": \"source/path\"}; null removes one.",
        },
        "url": {"type": "string", "description": "publish: an existing artifact's link to update. read and open: the artifact's link."},
        "intent": {"type": "string", "enum": ["document", "slides", "design", "other"], "description": "quickstart: what is being made. Only plain pages are supported here."},
    },
}


# ---------------------------------------------------------------- artifact store

def load_index():
    try:
        return json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_index(index):
    STORE.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
    tmp.replace(INDEX)


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:48] or "artifact"


def link_of(slug, entry):
    return (STORE / slug / entry["page"]).as_uri()


def find(url, index):
    """Resolve a link, a folder path or a slug to its index entry."""
    if not url:
        return None, None
    text = url.strip()
    for slug, entry in index.items():
        if text in (slug, link_of(slug, entry), str(STORE / slug), str(STORE / slug / entry["page"])):
            return slug, entry
    return None, None


def title_of(content):
    match = re.search(r"<title[^>]*>(.*?)</title>", content[:8192], re.IGNORECASE | re.DOTALL)
    return html.unescape(re.sub(r"\s+", " ", match.group(1)).strip()) if match else None


ICON_SVG = (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' "
    "fill='%23141413'/><text x='16' y='22' font-family='sans-serif' font-size='17' text-anchor='middle' "
    "fill='%23faf9f5'>{letter}</text></svg>"
)


def wrap_page(content, description, icon):
    published = page_publish.wrap(content, description)
    if icon:
        letter = re.sub(r"[^A-Za-z0-9]", "", icon)[:1].upper() or "A"
        link = f'<link rel="icon" href="data:image/svg+xml,{ICON_SVG.format(letter=letter)}">'
        published = published.replace(page_publish.GENERATOR, page_publish.GENERATOR + link, 1)
    return published


# ---------------------------------------------------------------- actions

def act_quickstart(args):
    text = GUIDANCE.read_text(encoding="utf-8")
    start = text.index("## Page contract")
    guidance = text[start:].strip()
    intro = (
        "Quickstart. Only plain pages can be made here: Slides, Design, Docs and Design System "
        "Artifact types exist only on claude.ai.\n\n"
        if args.get("intent") not in (None, "other")
        else "Quickstart. "
    )
    return (
        intro
        + "For a plain page, the page-design guidance follows. It is the `artifact-design` skill's own "
        "text, so do not load that skill as well. Write the page to a file and publish it in the same "
        "message: the two calls run in order.\n\n"
        + guidance
    )


def act_publish(args):
    if not args.get("file_path"):
        raise ValueError("publish needs file_path: write the page to a file first")
    source = Path(args["file_path"]).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"{source} doesn't exist; write the page there first")
    index = load_index()
    slug, entry = find(args.get("url"), index) if args.get("url") else (None, None)
    if args.get("url") and not slug:
        raise ValueError(f"no published artifact has the link {args['url']}; list them with action \"list\"")
    if not slug:
        for candidate, existing in index.items():
            if existing.get("source") == str(source):
                slug, entry = candidate, existing
                break

    is_markdown = source.suffix.lower() in (".md", ".markdown")
    raw = source.read_text(encoding="utf-8")
    notes = []
    if is_markdown:
        content, title = raw, args.get("title") or source.name
        published = raw
        page_name = "index.md"
    else:
        content, old_description = page_publish.unwrap(raw)
        title = title_of(content)
        if not title and args.get("title"):
            title = args["title"]
            content = f"<title>{html.escape(title)}</title>\n" + content
        if not title:
            notes.append("The page has no <title> in its first 8KB, so it has no name: add one, or pass `title`.")
        description = args.get("description") or (entry or {}).get("description") or old_description
        if not description:
            notes.append("No `description`: pass a one-sentence explanation of the page.")
        icon = (entry or {}).get("icon") or args.get("icon")
        published = wrap_page(content, description, icon)
        page_name = "index.html"
        if re.search(r"""fetch\(\s*[`'"](?![a-z]+:)""", content):
            notes.append("The page fetch()es its own files, which a browser refuses over file://; "
                         "action \"preview\" serves them over http, as claude.ai does.")

    if len(published.encode("utf-8")) > page_publish.SIZE_LIMIT:
        raise ValueError("the page is over 16MB; shrink it or move data into supporting files")

    first = slug is None
    if first:
        base = slugify(title or source.stem)
        slug, n = base, 2
        while slug in index:
            slug, n = f"{base}-{n}", n + 1
        entry = {"source": str(source), "version": 0, "created": None}
    folder = STORE / slug
    folder.mkdir(parents=True, exist_ok=True)

    for published_path, from_path in (args.get("files") or {}).items():
        target = (folder / published_path).resolve()
        if folder.resolve() not in target.parents:
            raise ValueError(f"supporting file path {published_path!r} must stay inside the artifact")
        if from_path is None:
            target.unlink(missing_ok=True)
            continue
        origin = Path(from_path).expanduser()
        if not origin.is_absolute():
            origin = source.parent / origin
        if not origin.is_file():
            raise ValueError(f"supporting file {origin} doesn't exist")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, target)

    (folder / page_name).write_text(published, encoding="utf-8")
    entry["version"] += 1
    versions = folder / ".versions"
    versions.mkdir(exist_ok=True)
    (versions / f"{entry['version']}{Path(page_name).suffix}").write_text(published, encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry.update({"page": page_name, "title": title, "updated": now})
    entry["created"] = entry["created"] or now
    if not is_markdown:
        entry["description"] = description
        entry["icon"] = icon
    index[slug] = entry
    save_index(index)

    link = link_of(slug, entry)
    lines = [f"Published {source} at {link} (Version {entry['version']})" + (f' Icon: "{entry["icon"]}".' if first and entry.get("icon") else "")]
    lines += notes
    lines.append(
        "To update: publish the same file path again (keeps this link); pass `url` to update this "
        "artifact from another file. The page is a local file: only people with access to this machine "
        "can open it."
    )
    lines.append(
        "The files you sent are still on disk. To change the artifact, Edit them there and publish again "
        "in the same message; no read is needed."
    )
    if first and os.environ.get("ARTIFACT_OPEN", "1") != "0":
        lines.append("Opened it in the browser." if page_publish.open_in_browser(folder / page_name)
                     else "There is no browser to open here; give the user the link.")
    return "\n\n".join(lines)


def act_preview(args):
    if not args.get("file_path"):
        raise ValueError("preview needs file_path")
    source = Path(args["file_path"]).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"{source} doesn't exist")
    if not shutil.which("node"):
        return "Node isn't installed here, so there is no preview. Skip the look and publish."
    env = dict(os.environ)
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=20).stdout.strip()
        if root:
            env["NODE_PATH"] = os.pathsep.join(filter(None, [env.get("NODE_PATH"), root]))
    except (OSError, subprocess.SubprocessError):
        pass
    result = subprocess.run(
        ["node", str(SCRIPTS / "preview.mjs"), str(source)],
        capture_output=True, text=True, timeout=240, env=env,
    )
    output = (result.stdout + result.stderr).strip()
    return output or "The preview produced no output."


def act_list(_args):
    index = load_index()
    if not index:
        return f"No artifacts published yet (folder: {STORE})."
    rows = sorted(index.items(), key=lambda item: item[1].get("updated") or "", reverse=True)
    return "\n".join(
        f"- {entry.get('title') or slug} — {link_of(slug, entry)} (updated {entry.get('updated')}, source {entry.get('source')})"
        for slug, entry in rows
    )


def act_read(args):
    index = load_index()
    slug, entry = find(args.get("url"), index)
    if not slug:
        raise ValueError("read needs the `url` of a published artifact; list them with action \"list\"")
    page = STORE / slug / entry["page"]
    return f"{link_of(slug, entry)} (Version {entry['version']}, source {entry.get('source')})\n\n" + page.read_text(encoding="utf-8")


def act_open(args):
    index = load_index()
    slug, entry = find(args.get("url"), index)
    if not slug:
        raise ValueError("open needs the `url` of a published artifact")
    page = STORE / slug / entry["page"]
    return f"Opened {link_of(slug, entry)}." if page_publish.open_in_browser(page) else f"There is no browser to open here; the page is {link_of(slug, entry)}."


ACTIONS = {"publish": act_publish, "quickstart": act_quickstart, "preview": act_preview,
           "read": act_read, "list": act_list, "open": act_open}


# ---------------------------------------------------------------- MCP over stdio

def handle(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        return {
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "artifact", "version": "0.1.0"},
            "instructions": INSTRUCTIONS,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{"name": "Artifact", "description": DESCRIPTION, "inputSchema": SCHEMA}]}
    if method == "tools/call":
        if params.get("name") != "Artifact":
            raise LookupError(f"unknown tool {params.get('name')!r}")
        args = params.get("arguments") or {}
        action = args.get("action") or "publish"
        if action not in ACTIONS:
            return {"content": [{"type": "text", "text": f"Unknown action {action!r}."}], "isError": True}
        try:
            text = ACTIONS[action](args)
            return {"content": [{"type": "text", "text": text}]}
        except Exception as error:  # reported to the model as a tool error
            return {"content": [{"type": "text", "text": f"{action} failed: {error}"}], "isError": True}
    raise LookupError(f"method not found: {method}")


def main():
    # Keep stdout for protocol messages only; anything the helpers print goes to stderr.
    out = sys.stdout
    sys.stdout = sys.stderr
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if "id" not in message:
            continue  # a notification
        try:
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
        except LookupError as error:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": str(error)}}
        except Exception as error:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": str(error)}}
        out.write(json.dumps(reply) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
