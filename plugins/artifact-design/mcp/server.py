#!/usr/bin/env python3
"""An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.

It exposes one tool, `Artifact`, with the claude.ai tool's actions that make sense on a
local machine:

- quickstart: the page contract and design guidance, the same text the claude.ai tool's
  quickstart returns for a plain page (read from the bundled artifact-design skill).
- publish: wraps the page in the claude.ai publish skeleton and writes it to an artifacts
  folder (ARTIFACTS_DIR, default ~/artifacts), one folder per artifact, keyed by the
  source file so publishing the same file again updates the same artifact.
- preview: renders the page at 1280 and 390px wide in light and dark, as Claude Code's
  ArtifactCheck does, and returns the captures and what breaks (scripts/preview.mjs; needs
  Node and Playwright).
- list, read, open, delete: the published artifacts.

Standard library only. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
"""

import base64
import contextlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

# The server reads the bundled artifact-design skill's text and scripts, so there is one copy of each.
SKILL_DIR = Path(__file__).resolve().parent.parent / "skills" / "artifact-design"
GUIDANCE = SKILL_DIR / "SKILL.md"
SCRIPTS = SKILL_DIR / "scripts"
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

# Claude Code's Artifact tool description (2.1.293), less what only claude.ai can do: runtime
# capabilities, the shared database, Artifact types, watching, pinning and the asset store.
DESCRIPTION = """The Artifact tool renders an HTML file as an Artifact: a web page published as a local file on this machine, in {store}, and opened in the browser. Claude uses it when a page would be clearer than terminal text, or when the person or their team would use the page rather than only read it. Claude may publish its own work without being asked, because a published page stays on this machine. Where a built-in Artifact tool that publishes to claude.ai is also available, Claude uses that one instead; this tool is for harnesses without it. Here, as in the `artifact-design` skill, Claude means you, the agent using this tool.

When a finished piece of work is meant for other people or agents, such as a report for a team or the case for a decision the team has yet to make, Claude does not treat it as finished while it exists only in terminal scrollback. Claude publishes it as an Artifact and gives the person the link, so they have a page ready to share when they choose. Claude publishes it even when the request is phrased as a question, such as "can you write up the plan?". When the request says who else will read or use the work, such as a team, a manager or a reviewer, or where it will be posted or presented, such as a channel or a meeting, Claude publishes it. A write-up that will be posted in a channel or a thread is still published; when it is short, Claude also gives the text in its reply, ready to paste. When it might be passed along but nothing says so, Claude offers the page in one line instead of saying nothing. When the person asks only for Claude's own verdict, such as "should we ship this?", and names no one else who will read it, Claude gives the answer in the terminal and offers the page in one line instead of publishing it. A recommendation or analysis written up for someone else to act on is finished work for that reader, so Claude publishes it. Claude publishes an artifact for apps, sites, dashboards and games, and whenever the person asks for an artifact or for an HTML or Markdown page to view or share. When the person asks for the file itself, such as "just give me the .html file" or "save these notes as a .md file", Claude gives them that file and does not publish it. Advice that the person will act on by themselves, right away, in the code they are working on is not meant for other people, so Claude does not need to publish it.

**Before writing the file, Claude must load the `artifact-design` skill**, or call this tool with `action: "quickstart"`, whose result carries the same guidance and counts as loading it, including for a `.md` file that a skill told Claude to write. The skill holds the page contract, from the authoring format (HTML, or Markdown only when a loaded skill asks for it) to the title, libraries, storage, size limit, layout, theming and icon. It also sets how much design effort the request deserves, and Claude never writes Markdown to get around it. Claude then writes the content to a file and calls Artifact with its path, putting the file in its scratchpad directory when the system prompt lists one and the person names no other location.

**If Claude writes a page before that guidance has loaded**, its contract still applies. Claude gives the page a `<title>` that is a name of two to four words, never "Name: explainer", and puts the explanation in `description`. Claude writes only the page content, with no doctype, `<html>`, `<head>` or `<body>` tags, because publishing wraps the page in a skeleton. Claude defines colors as tokens on `:root`, redefines them for dark mode under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`, and gives `body` an explicit background. Claude loads external scripts only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, loads stylesheets only from Google Fonts, and puts everything else inline. Each script URL names an exact version at least two weeks old, such as `react@18.3.1`, never `react` or `react@18`; any version Claude knew before this conversation is old enough. Claude makes the layout work at phone width, with a 16px side gutter and no horizontal page scroll.

**Format**: Claude always authors the page as `.html`, and publishes a `.md` file only when a loaded skill explicitly asks for one. When the person shares a Markdown document or asks to turn one into an artifact, Claude builds an HTML page from its content, keeping its substance and designing the page as it would any other artifact rather than transcribing the Markdown one to one.

**Browser storage**: `localStorage`, `sessionStorage` and IndexedDB work, but what a page stores lives only in that viewer's browser. It survives republishes to the same link and never reaches other viewers, other devices or Claude. It can come back empty, or the accessor can throw, in a private window, with cleared or blocked site data, or in previews, so Claude wraps every read and write in try/catch and makes the page render correctly without it. Claude uses it only for per-viewer conveniences, such as a remembered tab or filter, a collapsed section or an unsent draft, and never for state that must persist reliably, be shared between viewers or be read back by Claude.

**Size**: Claude keeps the rendered page at 16MB or smaller, and embedded `data:` URIs count toward that limit.

**Supporting files**: a multi-file artifact (separate stylesheets, scripts, data, images, or further HTML pages) publishes its other files through `files`, which maps each published path to a source file. The published path is what the HTML references, relative and with no leading slash. Only the page itself is wrapped in a document skeleton at publish time: an HTML file in `files` is another page served without one, so Claude starts each with its own `<!doctype html>`, charset and viewport metas and base styles, or, without the doctype, it renders in quirks mode with browser defaults. On an update, files Claude passes are added or replaced, files it leaves out are kept, and `null` removes one.

**Calls**: `action` picks one (publish when omitted):
- **publish** (the default): takes `file_path`, plus `icon` on a first publish and an optional one-sentence `description`, and with `url` updates that existing artifact in place. A first publish opens the page in the browser.
- **quickstart**: takes `intent` and returns the page contract and the design guidance for a plain page. It is read-only. Only plain pages can be made here; Slides, Design and Docs are claude.ai Artifact types.
- **preview**: takes `file_path` (the page Claude wrote, before or after publishing) and renders it at 1280 and 390px wide in light and dark, returning a capture of each render and a list of overflow, clipped SVG labels, colors set for one theme only, failed diagrams, blocked loads and script errors. It needs Node and Playwright; when they are missing it says so. This is the preview the `artifact-design` skill describes.
- **read**: takes `url` and returns the published page's content.
- **list**: returns the artifacts published on this machine, newest first, with title, link, last-updated time and source file.
- **delete**: with `url`, permanently deletes a published artifact and its versions, which cannot be undone. Claude does this only when the person asks for that artifact to be deleted or unpublished, or says they did not want it published, never on its own initiative. The source file stays.
- **open**: takes `url` and opens that existing artifact in the browser without changing it. Claude uses it when the person asks to see one. An artifact Claude just published needs no open.

**To update** an artifact published earlier, Claude calls Artifact again with the same file path, which republishes it to the same link. A different path creates a new link, so Claude changes the path only when it wants a separate artifact.

**To update an artifact from another file**, Claude passes that artifact's link as `url`. Claude does this whenever the person wants an existing artifact changed or its link kept, and finds the link with `action: "list"` or by asking the person. Claude first reads the artifact with `action: "read"` and builds on the version that comes back. Publishing a new file without `url` creates a separate artifact. If the person asks where to find their artifacts again, `action: "list"` lists them, and each one is a folder in {store}.

**Files Claude did not write**: Claude reads the whole file before publishing it, even when the person asks it not to. Publishing distributes the content, and Claude never distributes what it has not seen. A request for privacy is a reason to read before publishing, not an exemption. If Claude cannot read the file, it does not publish it.

**Claude never publishes** a page that impersonates a real person or organization, for example by using their name, branding, byline or domain. Claude also never publishes fabricated records, receipts or reviews presented as genuine, forms or flows that collect credentials or payment details under false pretenses, or content that targets a private individual. Claude refuses whether it wrote the page or the person supplied it, and whatever purpose is claimed, such as a prop or a test, when the page would work as the real thing. If publishing is refused, Claude does not suggest other ways to host or share the page.""".replace("{store}", str(STORE))

SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["publish", "quickstart", "preview", "read", "list", "open", "delete"],
            "description": "Omitting it means 'publish'.",
        },
        "file_path": {"type": "string", "description": "publish and preview: the page file (.html, or .md only when a skill says so)."},
        "description": {"type": "string", "description": "publish: one sentence explaining the page."},
        "title": {"type": "string", "description": "publish: the fallback title for an HTML page whose file has no <title>."},
        "icon": {"type": "string", "description": "publish: one short generic word for the page's tab icon, such as chart, calendar, recipe, code or map: a plain signifier, never a product or brand name. Include it on every page's first publish and omit it on a redeploy so the artifact keeps its icon, passing a new one only when the person asks."},
        "files": {
            "type": "object",
            "additionalProperties": {"type": ["string", "null"]},
            "description": "publish: supporting files as {\"published/path\": \"source/path\"}; null removes one. A relative source path is read from the working directory, or else from the page's folder.",
        },
        "url": {"type": "string", "description": "publish: an existing artifact's link to update. read, open and delete: the artifact's link."},
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
    tmp = INDEX.with_name(f"index.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
    tmp.replace(INDEX)


@contextlib.contextmanager
def store_lock():
    """Hold the artifacts folder's lock, so publishes from several sessions don't drop index entries."""
    STORE.mkdir(parents=True, exist_ok=True)
    with open(STORE / ".lock", "a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)  # msvcrt locks bytes from the current position; append mode starts at the end
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:  # LK_LOCK gives up after ten seconds; keep waiting
                    pass
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def slugify(text):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
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
    with store_lock():
        return publish(args)


def publish(args):
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
        with contextlib.redirect_stderr(io.StringIO()) as unwrap_notes:
            content, old_description = page_publish.unwrap(raw)
        if unwrap_notes.getvalue():
            notes.append("The file was a full HTML document; publishing adds the skeleton, "
                         "so write only the page content next time.")
        title = title_of(content)
        if not title and args.get("title"):
            title = args["title"]
            content = f"<title>{html.escape(title)}</title>\n" + content
        if not title:
            notes.append("The page has no <title> in its first 8KB, so it has no name: add one, or pass `title`.")
        description = args.get("description") or (entry or {}).get("description") or old_description
        if not description:
            notes.append("No `description`: pass a one-sentence explanation of the page.")
        icon = args.get("icon") or (entry or {}).get("icon")
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
            origin = next((base / origin for base in (Path.cwd(), source.parent) if (base / origin).is_file()),
                          Path.cwd() / origin)
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
    entry.update({"source": str(source), "page": page_name, "title": title, "updated": now})
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
        ["node", str(SCRIPTS / "preview.mjs"), str(source), "--json"],
        capture_output=True, text=True, timeout=240, env=env,
    )
    try:
        report = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        output = (result.stdout + result.stderr).strip()
        return output or "The preview produced no output."
    # Like Claude Code's preview, the result carries each capture as an image after the report,
    # and a preview that captured nothing is an error.
    content = [{"type": "text", "text": report["text"]}]
    for number, shot in enumerate(report.get("shots", []), 1):
        try:
            data = base64.b64encode(Path(shot["path"]).read_bytes()).decode("ascii")
        except OSError:
            continue
        content.append({"type": "text", "text": f"Capture {number} ({shot['label']}):"})
        content.append({"type": "image", "data": data, "mimeType": "image/jpeg"})
    return {"content": content, "isError": bool(report.get("failed"))}


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


def act_delete(args):
    with store_lock():
        index = load_index()
        slug, entry = find(args.get("url"), index)
        if not slug:
            raise ValueError("delete needs the `url` of a published artifact; list them with action \"list\"")
        shutil.rmtree(STORE / slug, ignore_errors=True)
        del index[slug]
        save_index(index)
    return f"Deleted {entry.get('title') or slug} and its versions; its link no longer opens. The source file {entry.get('source')} is untouched."


def act_open(args):
    index = load_index()
    slug, entry = find(args.get("url"), index)
    if not slug:
        raise ValueError("open needs the `url` of a published artifact")
    page = STORE / slug / entry["page"]
    return f"Opened {link_of(slug, entry)}." if page_publish.open_in_browser(page) else f"There is no browser to open here; the page is {link_of(slug, entry)}."


ACTIONS = {"publish": act_publish, "quickstart": act_quickstart, "preview": act_preview,
           "read": act_read, "list": act_list, "open": act_open, "delete": act_delete}


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
            result = ACTIONS[action](args)
            return result if isinstance(result, dict) else {"content": [{"type": "text", "text": result}]}
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
