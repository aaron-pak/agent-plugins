#!/usr/bin/env python3
"""An MCP server that stands in for claude.ai's Artifact tool outside claude.ai.

It exposes one tool, `Artifact`, with the claude.ai tool's actions that make sense on a
local machine:

- quickstart: the page contract and design guidance, the same text the claude.ai tool's
  quickstart returns for a plain page (read from the bundled artifact-design skill).
- publish: wraps the page in the claude.ai publish skeleton and writes it to an artifacts
  folder (ARTIFACTS_DIR, default ~/artifacts), one folder per artifact. Publishing the same
  file again in the same session (this server process) updates the same artifact, as the
  Artifact tool keeps its file-to-artifact map per session; `url` updates any artifact.
  A Markdown file is rendered into the document template Claude Code uses for one.
- preview: renders the page at 1280 and 390px wide in light and dark, as Claude Code's
  ArtifactCheck does, and returns the captures and what breaks (scripts/preview.mjs). It is
  listed only when Node, Playwright and a Chromium are found at startup, and ARTIFACT_PREVIEW=0
  leaves it out.
- list, read, open, delete: the published artifacts.

Codex reads at most 1,000 bytes of an MCP tool's description and strips every description
from an input schema over 5,000 bytes, so a Codex client gets a compact tool whose text fits
those limits and points to quickstart for the rest.

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
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# The server reads the bundled artifact-design skill's text and scripts, so there is one copy of each.
SKILL_DIR = Path(__file__).resolve().parent.parent / "skills" / "artifact-design"
GUIDANCE = SKILL_DIR / "SKILL.md"
SCRIPTS = SKILL_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
import publish as page_publish  # noqa: E402  (scripts/publish.py: skeleton, CSP, unwrap, Markdown)

# Resolved once at startup, so a relative ARTIFACTS_DIR means the folder the server started in.
STORE = Path(os.environ.get("ARTIFACTS_DIR") or Path.home() / "artifacts").expanduser().resolve()
INDEX = STORE / "index.json"
# Claude Code shows the model a scratchpad only when its own Artifact tool is on, so page files
# written for this tool would land in the person's project. They go here instead, one folder per
# server process (one session), as a scratchpad is, so two sessions' plan.html don't collide.
DRAFTS_ROOT = Path(tempfile.gettempdir()) / (f"artifact-drafts-{os.getuid()}" if hasattr(os, "getuid") else "artifact-drafts")


def make_drafts():
    """A private (0700) folder for this session under DRAFTS_ROOT, which must be a real folder this
    user owns, so nobody else can read the drafts or plant the folder; empty folders a day old go."""
    try:
        DRAFTS_ROOT.mkdir(mode=0o700, exist_ok=True)
        info = DRAFTS_ROOT.lstat()
        if DRAFTS_ROOT.is_symlink() or not DRAFTS_ROOT.is_dir() or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
            raise OSError(f"{DRAFTS_ROOT} isn't a folder of this user's own")
        for old in DRAFTS_ROOT.iterdir():
            with contextlib.suppress(OSError):
                if old.is_dir() and time.time() - old.stat().st_mtime > 86400:
                    old.rmdir()  # only empty ones
        return Path(tempfile.mkdtemp(prefix=f"{datetime.now():%Y%m%d-%H%M%S}-", dir=DRAFTS_ROOT))
    except OSError:
        return Path(tempfile.mkdtemp(prefix="artifact-drafts-"))


DRAFTS = make_drafts()
OPEN_PAGES = os.environ.get("ARTIFACT_OPEN", "1") != "0"
# What publish.open_in_browser can open: macOS, Windows, or a Linux desktop session.
CAN_OPEN = sys.platform == "darwin" or os.name == "nt" or bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
PREVIEW_SWITCH = os.environ.get("ARTIFACT_PREVIEW", "1") != "0"
PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
STARTED = time.monotonic()
PREVIEW_WAIT = 10  # seconds tools/list waits for the startup preview check

INSTRUCTIONS = (
    "This server's Artifact tool publishes HTML pages (reports, explainers, plans, dashboards, "
    "tools, mockups) as local files, the way claude.ai's Artifact tool publishes them. "
    "It stands in for Claude Code's own Artifact tool where that tool is off or absent: its full name "
    "carries a server prefix (mcp__plugin_artifact-design_artifact__Artifact in Claude Code, "
    "mcp__artifact__Artifact in Codex), and "
    "\"Artifact\" in its description, in quickstart's result and in the skills means this tool. "
    "Before writing a new artifact, call Artifact with action \"quickstart\"; then write the page "
    "to a file and publish it with Artifact in the same message, which wraps it in the page "
    "skeleton. Give the user the published link. "
    "Where a built-in Artifact tool that publishes to claude.ai is also available, use that one "
    "instead; this server is for harnesses without it."
)

# Claude Code's Artifact tool description (2.1.293), less what only claude.ai can do: runtime
# capabilities, the shared database, watching, pinning, the asset store, and Artifact types beyond
# the rule that a new artifact starts with quickstart. {opened}, {open_note}, {preview} and the
# folders are filled in by describe().
DESCRIPTION = """The Artifact tool renders an HTML file as an Artifact: a web page published as a local file on this machine, in {store}{opened}. It stands in for Claude Code's own Artifact tool where that tool is off or absent: its full name carries a server prefix (in Claude Code, `mcp__plugin_artifact-design_artifact__Artifact`), and "Artifact" in this text, in quickstart's result and in the skills means this tool, so a call to the bare name `Artifact` that fails as unavailable or disabled goes to this tool's full name instead. Claude uses it when a page would be clearer than terminal text, or when the person or their team would use the page rather than only read it. Claude may publish its own work without being asked, because a published page stays on this machine. Where a built-in Artifact tool that publishes to claude.ai is also available, Claude uses that one instead; this tool is for harnesses without it. Here, as in the `artifact-design` skill, Claude means you, the agent using this tool.

When a finished piece of work is meant for other people or agents, such as a report for a team or the case for a decision the team has yet to make, Claude does not treat it as finished while it exists only in terminal scrollback. Claude publishes it as an Artifact and gives the person the link, so they have a page ready to share when they choose. Claude publishes it even when the request is phrased as a question, such as "can you write up the plan?". When the request says who else will read or use the work, such as a team, a manager or a reviewer, or where it will be posted or presented, such as a channel or a meeting, Claude publishes it. A write-up that will be posted in a channel or a thread is still published; when it is short, Claude also gives the text in its reply, ready to paste. When it might be passed along but nothing says so, Claude offers the page in one line instead of saying nothing. When the person asks only for Claude's own verdict, such as "should we ship this?", and names no one else who will read it, Claude gives the answer in the terminal and offers the page in one line instead of publishing it. A recommendation or analysis written up for someone else to act on is finished work for that reader, so Claude publishes it. Claude publishes an artifact for apps, sites, dashboards and games, and whenever the person asks for an artifact or for an HTML or Markdown page to view or share. When the person asks for the file itself, such as "just give me the .html file" or "save these notes as a .md file", Claude gives them that file and does not publish it. Advice that the person will act on by themselves, right away, in the code they are working on is not meant for other people, so Claude does not need to publish it.

**Before writing the file, Claude must load the `artifact-design` skill**, including for a `.md` file that a skill told Claude to write. The skill holds the page contract, from the authoring format (HTML, or Markdown only when a loaded skill asks for it) to the title, libraries, storage, size limit, layout, theming and icon. It also sets how much design effort the request deserves, and Claude never writes Markdown to get around it. Claude then writes the content to a file (via Write/Edit) and calls Artifact with its absolute path, putting the file, when the person names no other location, in its scratchpad directory if the system prompt lists one and otherwise in {drafts}. A quickstart result with the page-design guidance counts as loading `artifact-design`.

**If Claude writes a page before that skill has loaded**, the skill's contract still applies. Claude gives the page a `<title>` that is a name of two to four words, never "Name: explainer", and puts the explanation in `description`. Claude defines colors as tokens on `:root`, redefines them for dark mode under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`, and gives `body` an explicit background. Claude loads external scripts only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, loads stylesheets only from Google Fonts, and puts everything else inline. Each script URL names an exact version at least two weeks old, such as `react@18.3.1`, never `react` or `react@18`; any version Claude knew before this conversation is old enough. Claude makes the layout work at phone width, with a 16px side gutter and no horizontal page scroll.

**Format**: Claude always authors the page as `.html`, and publishes a `.md` file only when a loaded skill explicitly asks for one. When the person shares a Markdown document or asks to turn one into an artifact, Claude builds an HTML page from its content, keeping its substance and designing the page as it would any other artifact rather than transcribing the Markdown one to one.

**Browser storage**: `localStorage`, `sessionStorage` and IndexedDB work, but what a page stores lives only in that viewer's browser. It survives republishes to the same link and never reaches other viewers, other devices or Claude. It can come back empty, or the accessor can throw, in a private window, with cleared or blocked site data, or in previews, so Claude wraps every read and write in try/catch and makes the page render correctly without it. Claude uses it only for per-viewer conveniences, such as a remembered tab or filter, a collapsed section or an unsent draft, and never for state that must persist reliably, be shared between viewers or be read back by Claude.

**Size**: Claude keeps the rendered page at 16MB or smaller, and embedded `data:` URIs count toward that limit.

**Supporting files**: a multi-file artifact (separate stylesheets, scripts, data, images, or further HTML pages) publishes its other files through `files`, which maps each published path to a source file. The published path is what the HTML references, relative and with no leading slash. The page opens from a `file://` link, so it can link to these files and load them as images, stylesheets and classic scripts, but it cannot `fetch()`, import or start Workers from them: data a script reads goes inline. Only the page itself is wrapped in a document skeleton at publish time: an HTML file in `files` is another page served without one, so Claude starts each with its own `<!doctype html>`, charset and viewport metas and base styles, or, without the doctype, it renders in quirks mode with browser defaults. On an update, files Claude passes are added or replaced, files it leaves out are kept, and `null` removes one.

**Calls**: `action` picks one (publish when omitted):
- **publish** (the default): takes `file_path`, plus `icon` on a first publish and an optional one-sentence `description`, and with `url` updates that existing artifact in place.{open_note}
- **quickstart**: takes `intent` and returns the page contract and the design guidance for a plain page. It is read-only. Only plain pages can be made here; Slides, Design and Docs are claude.ai Artifact types.{preview}
- **read**: takes `url` and returns the published page's content, without the skeleton that publishing adds.
- **list**: returns the artifacts published on this machine, newest first, with title, link, last-updated time and source file.
- **delete**: with `url`, permanently deletes a published artifact and its versions, which cannot be undone. Claude does this only when the person asks for that artifact to be deleted or unpublished, or says they did not want it published, never on its own initiative. The source file stays.
- **open**: takes `url` and opens that existing artifact in the browser without changing it. Claude uses it when the person asks to see one. An artifact Claude just published needs no open.

**To update** an artifact published earlier in this session, Claude calls Artifact again with the same file path, which republishes it to the same link. A different path creates a new link, so Claude changes the path only when it wants a separate artifact.

**To update an artifact from another file or an earlier session**, Claude passes that artifact's link as `url`. Claude does this whenever the person wants an existing artifact changed or its link kept, and finds the link with `action: "list"` or by asking the person. Claude first reads the artifact with `action: "read"` and builds on the version that comes back. Publishing without `url` creates a separate artifact, even from a path published in an earlier session. If the person asks where to find their artifacts again, `action: "list"` lists them, and each one is a folder in {store}.

**Files Claude did not write**: Claude reads the whole file before publishing it, even when the person asks it not to. Publishing distributes the content, and Claude never distributes what it has not seen. A request for privacy is a reason to read before publishing, not an exemption. If Claude cannot read the file, it does not publish it.

**Artifact types**: published Artifact types (ready-made pages, such as slide decks, documents or designs, that take Claude's content as data) exist only on claude.ai, so every artifact here is a plain page. When the person wants something new made, in whatever words — a document for others to read (not one that belongs in the codebase), a visual design or any other page — Claude's first call is `action: "quickstart"` with the fitting `intent`, before loading a skill or writing a file, once per new artifact. The quickstart result replaces, for a plain page, loading the artifact-design skill.

**Claude never publishes** a page that impersonates a real person or organization, for example by using their name, branding, byline or domain. Claude also never publishes fabricated records, receipts or reviews presented as genuine, forms or flows that collect credentials or payment details under false pretenses, or content that targets a private individual. Claude refuses whether it wrote the page or the person supplied it, and whatever purpose is claimed, such as a prop or a test, when the page would work as the real thing. If publishing is refused, Claude does not suggest other ways to host or share the page."""

# Claude Code's ArtifactCheck wording (2.1.294) for its preview, where it applies here.
PREVIEW_BULLET = """
- **preview**: takes `file_path` (one .html page, before or after publishing) and renders that one page file locally the way publish wraps it, in light and dark themes at desktop and phone widths (1280 and 390px), and returns the screenshots (each shows at most the top 1568px of the page) with a mechanical checklist of layout and load problems (horizontal overflow, clipped content, theme-only color variables, blocked or local-only loads, diagram and console errors), so Claude can see the page and fix what they show before publishing. Files published beside it are not loaded. Nothing is published."""

# Codex shows at most 1,000 bytes of an MCP tool's description (codex-rs/tools/src/mcp_tool.rs)
# and drops every description from an input schema over 5,000 bytes (tools/src/json_schema/
# compaction.rs), so a Codex client gets this shorter text: the lead, the first-call rule, the
# Calls list and the contract essentials. quickstart returns the full guidance.
CODEX_LEAD = """Publishes an HTML file as an Artifact: a web page written as a local file in {store}{opened}. It stands in for Claude Code's Artifact tool: "Artifact" here, in quickstart's result and in the skills means this tool (full name mcp__artifact__Artifact). Use it when a page would be clearer than terminal text, and for finished work meant for other people (a report, a plan, the case for a decision): publish it and give the person the link. When the person wants something new made, your first call is action "quickstart", before loading a skill or writing a file: it returns the page contract and design guidance, the full guidance this short description leaves out. Then write the page to a file and publish it in the same turn. The input schema's description lists the calls."""
CODEX_REST = """Write the page content to a file (in {drafts} unless the person names another location) and pass its absolute path. Page contract essentials: write only the page content (no doctype, html, head or body tags: publishing adds the skeleton), <title> and <style> first; the <title> is a name of two to four words and the explanation goes in `description`. Colors are tokens on :root, redefined for dark mode under @media (prefers-color-scheme: dark) guarded by :root:not([data-theme="light"]) and again under :root[data-theme="dark"]; body gets an explicit background. Scripts load only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, each pinned to an exact version at least two weeks old; stylesheets only from Google Fonts; everything else inline. The layout works at phone width (16px gutter, no horizontal scroll); the page stays at 16MB or less. Author .html; publish .md only when a loaded skill asks for it. localStorage works only per viewer: wrap it in try/catch and render correctly without it.
Publish finished work meant for others even when the request is phrased as a question; when the person asks only for your own verdict, answer in the terminal and offer the page in one line. Read the whole of any file you did not write before publishing it.
Calls (action; publish when omitted):
- publish: file_path, plus icon on a first publish and a one-sentence description; with url, updates that artifact. files maps published paths to source files for a multi-file page.{open_note}
- quickstart: intent; returns the page contract and design guidance.{preview}
- read: url; returns the page content without its skeleton.
- list: the artifacts on this machine, with links and source files.
- open: url; opens it in the browser.
- delete: url; only when the person asks.
To update, publish the same file path again in this session; pass url (from list) to update an artifact from another file or session, after reading it.
Never publish a page that impersonates a real person or organization, fabricated records presented as genuine, or flows that collect credentials or payment details under false pretenses."""
CODEX_PREVIEW = """
- preview: file_path (one .html page); renders it at 1280 and 390px in light and dark and returns the screenshots with a checklist of layout and load problems, to fix before publishing."""

# Claude Code cuts an MCP tool's description at 2048 characters (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH)
# but passes its input schema whole, so the description keeps its first paragraph and the rest follows,
# in order, as the input schema's description. Claude Code also defers MCP tools behind tool search
# unless they ask to load up front; its own Artifact tool is always loaded.
FIRST_CALL = (' When the person wants something new made, Claude\'s first call is `action: "quickstart"`, before'
              ' loading a skill or writing a file (see **Artifact types**).')

# Parameters of claude.ai's Artifact tool that this one doesn't have, and why.
CLAUDE_AI_ONLY = {
    "capabilities": "runtime capabilities exist only on claude.ai",
    "type_url": "Artifact types exist only on claude.ai",
    "asset": "the asset store exists only on claude.ai",
    "asset_ids": "the asset store exists only on claude.ai",
    "from_url": "the asset store exists only on claude.ai",
    "file_paths": "the asset store exists only on claude.ai",
}
CLAUDE_AI_PARAMS = {"after", "auto_open", "contract", "design_systems", "favicon", "force", "label", "limit",
                    "out_dir", "overwrite_unread", "page", "path", "paths", "pin", "prompt", "root", "scope",
                    "type", "type_query"}


def describe(preview):
    """The tool's description, with the preview bullet only when preview is offered."""
    return (DESCRIPTION
            .replace("{opened}", ", and opened in the browser" if OPEN_PAGES and CAN_OPEN else "")
            .replace("{open_note}", " A first publish opens the page in the browser." if OPEN_PAGES and CAN_OPEN else "")
            .replace("{preview}", PREVIEW_BULLET if preview else "")
            .replace("{drafts}", str(DRAFTS))
            .replace("{store}", str(STORE)))


def schema(preview, compact=False):
    actions = ["publish", "quickstart"] + (["preview"] if preview else []) + ["read", "list", "open", "delete"]
    listed = ", ".join(f"'{action}'" for action in actions)
    source = {"type": "string", "description": "An absolute path to the source file."}
    files_map = {"type": "object", "additionalProperties": {"anyOf": [
        source,
        {"type": "object", "properties": {"from": source, "contentType": {"type": "string"}}, "required": ["from"]},
        {"type": "null"},
    ]}}
    files_list = {"type": "array", "items": {"anyOf": [
        {"type": "string"},
        {"type": "object", "properties": {"path": {"type": "string"}, "contentType": {"type": "string"}}, "required": ["path"]},
    ]}}
    properties = {
        "action": {
            "type": "string",
            "enum": actions,
            "description": f"One of {listed}. Omitting it means 'publish'. **Calls** in the description says what each one does and takes, except as noted here.",
        },
        "file_path": {"type": "string", "description": "publish" + (" and preview" if preview else "") + ": the absolute path of the page file (.html, or .md only when a skill says so). A short, distinctive basename also serves as the title when nothing else gives one."},
        "description": {"type": "string", "description": "publish: one sentence explaining the page."},
        "title": {"type": "string", "description": "publish: the fallback title for an HTML page whose file has no <title>. It is a name, not a summary, and Claude keeps it the same across redeploys."},
        "icon": {"type": "string", "description": "publish: one short generic word for the page's tab icon, such as chart, calendar, recipe, code or map: a plain signifier, never a product or brand name. Include it on every page's first publish and omit it on a redeploy so the artifact keeps its icon, passing a new one only when the person asks."},
        "files": {
            "anyOf": [files_map, files_list],
            "description": "publish: supporting files, as {\"published/path\": \"/absolute/source/path\"} (or {\"from\": \"/absolute/source/path\", \"contentType\": \"...\"}); null removes one. A list of paths relative to the page's folder publishes each file at that same path.",
        },
        "url": {"type": "string", "description": "publish: an existing artifact's link to update. read, open and delete: the artifact's link."},
        "intent": {"type": "string", "enum": ["document", "slides", "design", "other"], "description": "quickstart: what is being made: 'document' (text to read or edit together), 'slides' (a deck or one slide), 'design' (a visual design or prototype on a canvas), 'other' (anything else, or unsure). Only plain pages are made here."},
    }
    if compact:
        short = {"action": "Publish when omitted.", "file_path": "Absolute path of the page file.",
                 "description": "One sentence explaining the page.", "title": "Fallback name when the page has no <title>.",
                 "icon": "One generic word for the tab icon, on a first publish.",
                 "files": "{\"published/path\": \"/absolute/source\"}; null removes one.",
                 "url": "An artifact's link (from list).", "intent": "What is being made."}
        for name, text in short.items():
            properties[name]["description"] = text
        files_map["additionalProperties"]["anyOf"][0] = {"type": "string"}
        files_map["additionalProperties"]["anyOf"][1]["properties"]["from"] = {"type": "string"}
    return {"type": "object", "properties": properties, "additionalProperties": False}


def tool(preview, client):
    if "codex" in (client or "").lower():
        fill = lambda text: (text.replace("{opened}", " and opened in the browser" if OPEN_PAGES and CAN_OPEN else "")
                             .replace("{open_note}", " A first publish opens the page." if OPEN_PAGES and CAN_OPEN else "")
                             .replace("{preview}", CODEX_PREVIEW if preview else "")
                             .replace("{drafts}", str(DRAFTS)).replace("{store}", str(STORE)))
        return {"name": "Artifact", "description": fill(CODEX_LEAD),
                "inputSchema": {"description": fill(CODEX_REST), **schema(preview, compact=True)}}
    lead, _, rest = describe(preview).partition("\n\n")
    return {
        "name": "Artifact",
        "description": lead + FIRST_CALL + " The rest of this description is the `description` of the tool's input schema.",
        "inputSchema": {"description": rest, **schema(preview)},
        "_meta": {"anthropic/alwaysLoad": True},
    }


# ---------------------------------------------------------------- preview availability

PREVIEW = {"ok": False, "reason": "the preview check has not finished"}
PREVIEW_CHECKED = threading.Event()


def check_preview():
    """Whether preview can run here: Node, Playwright and a Chromium (preview.mjs --check)."""
    try:
        if not PREVIEW_SWITCH:
            PREVIEW.update(ok=False, reason="ARTIFACT_PREVIEW=0 turns preview off")
            return
        node = shutil.which("node")
        if not node:
            PREVIEW.update(ok=False, reason="Node isn't installed")
            return
        result = subprocess.run([node, str(SCRIPTS / "preview.mjs"), "--check"], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=30, stdin=subprocess.DEVNULL)
        found = json.loads(result.stdout.strip().splitlines()[-1])
        PREVIEW.update(ok=bool(found.get("ok")), reason=found.get("reason"))
    except (OSError, subprocess.SubprocessError, IndexError, ValueError) as error:
        PREVIEW.update(ok=False, reason=f"the preview check failed ({error})")
    finally:
        PREVIEW_CHECKED.set()


def preview_offered():
    PREVIEW_CHECKED.wait(max(0.0, STARTED + PREVIEW_WAIT - time.monotonic()))
    return PREVIEW_CHECKED.is_set() and PREVIEW["ok"]


# ---------------------------------------------------------------- artifact store

# The source files this server process published, and their artifacts: like the Artifact tool's
# per-session map, a path republished in this session updates its artifact, and nothing else does.
SESSION_SOURCES = {}


def rebuild_index():
    """An index rebuilt from the artifact folders, for when index.json can't be read."""
    index = {}
    if not STORE.is_dir():
        return index
    for folder in sorted(STORE.iterdir()):
        page = next((name for name in ("index.html", "index.md") if (folder / name).is_file()), None)
        if folder.name.startswith(".") or not page:
            continue
        text = (folder / page).read_text(encoding="utf-8", errors="replace")
        if page == "index.html" and page_publish.GENERATOR not in text[:8192]:
            continue  # not a page this server published
        content, description = (page_publish.unwrap(text)[:2] if page == "index.html" else (text, None))
        versions = folder / ".versions"
        stamp = datetime.fromtimestamp((folder / page).stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
        index[folder.name] = {
            "source": None, "version": max(1, len(list(versions.iterdir())) if versions.is_dir() else 1),
            "created": stamp, "page": page, "title": page_publish.page_title(content) or folder.name,
            "updated": stamp, "description": description, "icon": None,
        }
    return index


def load_index(repair=False):
    """Return (index, note). An unreadable index.json is rebuilt from the folders; with repair
    (under the store lock, before a write) it is first moved aside, and the note says so."""
    try:
        text = INDEX.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, None
    except (OSError, UnicodeDecodeError):
        text = None
    try:
        index = json.loads(text) if text is not None else None
        if isinstance(index, dict) and all(isinstance(entry, dict) and "page" in entry for entry in index.values()):
            return index, None
    except ValueError:
        pass
    note = None
    index = rebuild_index()
    if repair:
        backup = INDEX.with_name(f"index.json.corrupt-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
        with contextlib.suppress(OSError):
            INDEX.replace(backup)
            save_index(index)
            note = (f"The artifacts index ({INDEX}) could not be read; it was moved to {backup.name} and "
                    "rebuilt from the artifact folders, which keep their pages but not their source files.")
    return index, note


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
    """Resolve a link (percent-encoded or not), a folder or page path, or a slug to its index entry."""
    text = (url or "").strip()
    if not text:
        return None, None
    if text in index:
        return text, index[text]
    if text.lower().startswith("file:"):
        text = urllib.request.url2pathname(urllib.parse.urlparse(text).path)
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = STORE / path
    with contextlib.suppress(OSError):
        path = path.resolve()
    if path.name in ("index.html", "index.md"):
        path = path.parent
    if path.parent == STORE and path.name in index:
        return path.name, index[path.name]
    return None, None


def absolute(value, name):
    """A path the caller gave, which must be absolute: the server's working directory is not the caller's."""
    path = Path(os.path.expanduser(str(value)))
    if not path.is_absolute():
        raise ValueError(f"{name} {str(value)!r} is relative: pass an absolute path; this server runs in "
                         f"{Path.cwd()}, not your workspace")
    return path.resolve()


def store_page_of(source, index):
    """For a file inside an artifact's folder: (slug, whether it is that artifact's page or a saved version)."""
    try:
        parts = source.relative_to(STORE).parts
    except ValueError:
        return None, False
    if len(parts) < 2 or parts[0] not in index:
        return None, False
    own = parts[1:] == (index[parts[0]]["page"],) or parts[1] == ".versions"
    return parts[0], own


def plan_files(files, folder, page_dir, page_name):
    """Check every supporting file before anything is written: [(target, source or None to remove)]."""
    if not files:
        return []
    if isinstance(files, list):
        pairs = []
        for item in files:
            spelled = item.get("path") if isinstance(item, dict) else item
            if not isinstance(spelled, str) or not spelled:
                raise ValueError(f"files: each list entry is a path relative to the page's folder, not {item!r}")
            pairs.append((spelled, str(page_dir / spelled)))
    elif isinstance(files, dict):
        pairs = []
        for published_path, origin in files.items():
            if isinstance(origin, dict):
                origin = origin.get("from")
                if not isinstance(origin, str):
                    raise ValueError(f"files[{published_path!r}]: give the source as \"/absolute/path\" or {{\"from\": \"/absolute/path\"}}")
            elif origin is not None and not isinstance(origin, str):
                raise ValueError(f"files[{published_path!r}]: the source must be a path, an object with `from`, or null")
            pairs.append((published_path, origin))
    else:
        raise ValueError("files maps published paths to source files ({\"img/a.png\": \"/abs/a.png\"}), or lists paths relative to the page")
    plan = []
    for published_path, origin in pairs:
        if published_path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", published_path):
            raise ValueError(f"supporting file path {published_path!r} must be relative, with no leading slash"
                             + ("; a list names files by their path relative to the page's folder, and a file "
                                "elsewhere goes in the map form, {\"published/path\": \"/absolute/source\"}"
                                if isinstance(files, list) else ""))
        target = (folder / published_path).resolve()
        relative = target.relative_to(folder.resolve()).as_posix() if folder.resolve() in target.parents else None
        if relative is None:
            raise ValueError(f"supporting file path {published_path!r} must stay inside the artifact")
        if relative in (page_name, "index.html", "index.md", ".versions") or relative.startswith(".versions/"):
            raise ValueError(f"supporting file path {published_path!r} is the artifact's own page; pick another name")
        if target.is_dir() or any(parent.is_file() for parent in target.parents if folder.resolve() in parent.parents):
            raise ValueError(f"supporting file path {published_path!r} collides with a folder or file already in the "
                             "artifact; pick another path, or remove the old one with null first")
        if origin is None:
            plan.append((target, None))
            continue
        source = absolute(origin, f"files[{published_path!r}]")
        if not source.is_file():
            raise ValueError(f"supporting file {source} doesn't exist; nothing was published")
        plan.append((target, source))
    return plan


# The tab icon: a letter on a dark tile, with its angle brackets percent-encoded so that nothing
# reading the page's head (the title rule stops at the first "<svg") takes it for markup.
ICON_SVG = (
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' "
    "fill='%23141413'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='17' text-anchor='middle' "
    "fill='%23faf9f5'%3E{letter}%3C/text%3E%3C/svg%3E"
)


def wrap_page(content, description, icon, lang=None, cover=None):
    published = page_publish.wrap(content, description, lang, cover)
    if icon:
        letter = re.sub(r"[^A-Za-z0-9]", "", icon)[:1].upper() or "A"
        link = f'<link rel="icon" href="data:image/svg+xml,{ICON_SVG.format(letter=letter)}">'
        published = published.replace(page_publish.GENERATOR, page_publish.GENERATOR + link, 1)
    return published


# ---------------------------------------------------------------- actions

def act_quickstart(args):
    text = GUIDANCE.read_text(encoding="utf-8")
    start = text.index("## Page contract")
    # Claude Code's quickstart leaves the empty dataviz callout's blank lines before "## Process".
    guidance = text[start:].strip().replace("\n\n## Process", "\n\n\n\n## Process", 1)
    only_plain = (
        "Only plain pages can be made here: Slides, Design, Docs and Design System Artifact types exist "
        "only on claude.ai.\n\n" if args.get("intent") not in (None, "other") else ""
    )
    return (
        "Quickstart. This one result stands in for listing the Artifact types — do not make that call as well.\n\n"
        "No published Artifact types are listed for this account (the type catalog isn't available to this account).\n\n"
        + only_plain
        + "For a plain page, the page-design guidance follows. It is the `artifact-design` skill's own "
        "text, so do not load that skill as well. Write the page to a file and publish it in the same "
        "message: the two calls run in order. Unless the person named a location, the file goes in "
        f"{DRAFTS} (or in the scratchpad directory, when the system prompt lists one), not in the project.\n\n"
        + guidance
        + "\n\n\n[Design systems not listed: this account lists no Design System type, so there are none to choose from.]"
    )


def act_publish(args):
    with store_lock():
        return publish(args)


def publish(args):
    if not args.get("file_path"):
        raise ValueError("publish needs file_path: write the page to a file first")
    source = absolute(args["file_path"], "file_path")
    if not source.is_file():
        raise ValueError(f"{source} doesn't exist; write the page there first")
    try:
        raw = page_publish.read_source(source)
    except ValueError as error:
        raise ValueError(f"file_path: {error}") from None
    index, repaired = load_index(repair=True)
    notes = [repaired] if repaired else []
    slug = entry = None
    if args.get("url"):
        slug, entry = find(args["url"], index)
        if not slug:
            raise ValueError(f"no published artifact has the link {args['url']}; list them with action \"list\"")
    else:
        # A file inside an artifact's folder is that artifact's own page, edited in place: an update.
        slug, own = store_page_of(source, index)
        if slug and not own:
            raise ValueError(f"{source} is a file inside the published artifact {slug}; publish its source "
                             f"({index[slug].get('source') or 'unknown'}) or copy the file out of {STORE} first")
        if slug:
            entry = index[slug]
            if entry.get("source") and Path(entry["source"]) != source:
                notes.append(f"That file is the artifact's published page, so the artifact was updated in place; "
                             f"its source file {entry['source']} doesn't have this change.")
        elif SESSION_SOURCES.get(str(source)) in index:
            slug = SESSION_SOURCES[str(source)]
            entry = index[slug]
        else:
            earlier = max(((s, e) for s, e in index.items() if e.get("source") == str(source)),
                          key=lambda item: item[1].get("updated") or "", default=None)
            if earlier:
                notes.append(f"This path was published before as {link_of(*earlier)}, in an earlier session; "
                             "that artifact is unchanged. Pass `url` to update that one instead.")

    is_markdown = source.suffix.lower() in (".md", ".markdown")
    lang = cover = None
    if is_markdown:
        # Rendered into the document template the Artifact tool uses for Markdown; its tab shows the
        # file name and the artifact takes the document's heading as its name.
        content, heading = page_publish.markdown_page(raw, source.name)
        title = args.get("title") or heading
        old_description = None
    else:
        content, old_description, lang, cover = page_publish.unwrap(raw)
        if cover is None and page_publish.is_full_document(content):
            notes.append(page_publish.FULL_DOCUMENT_NOTE)
        title = page_publish.page_title(content)
        if not title and args.get("title"):
            title = args["title"]
            content = f"<title>{html.escape(title)}</title>\n" + content
        if not title:
            notes.append("The page has no <title> in its first 8KB (one after an <svg> doesn't count), so the "
                         "artifact is named after the file: put a <title> at the top, or pass `title`.")
    description = args.get("description") or (entry or {}).get("description") or old_description
    if not description:
        notes.append("No `description`: pass a one-sentence explanation of the page.")
    icon = args.get("icon") or (entry or {}).get("icon")
    if page_publish.fetches_own_files(content):
        notes.append(page_publish.OWN_FILES_FETCH_NOTE)
    published = wrap_page(content, description, icon, lang, cover)
    if len(published.encode("utf-8")) > page_publish.SIZE_LIMIT:
        raise ValueError("the page is over 16MB; shrink it or move data into supporting files")

    first = slug is None
    if first:
        # A new folder never reuses one already on disk, whether or not the index knows it.
        base = slugify(title or source.stem)
        slug, n = base, 2
        while slug in index or (STORE / slug).exists():
            slug, n = f"{base}-{n}", n + 1
        entry = {"source": str(source), "version": 0, "created": None}
    folder = STORE / slug
    plan = plan_files(args.get("files"), folder, source.parent, "index.html")

    folder.mkdir(parents=True, exist_ok=True)
    for target, origin in plan:
        if origin is None:
            target.unlink(missing_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, target)
    if entry.get("page") == "index.md":  # an artifact published before Markdown was rendered
        (folder / "index.md").unlink(missing_ok=True)
    (folder / "index.html").write_text(published, encoding="utf-8")
    entry["version"] = entry.get("version", 0) + 1
    versions = folder / ".versions"
    versions.mkdir(exist_ok=True)
    (versions / f"{entry['version']}.html").write_text(published, encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if first or not store_page_of(source, index)[1]:
        entry["source"] = str(source)
    entry.update({"page": "index.html", "title": title or (source.name if is_markdown else source.stem),
                  "updated": now, "description": description, "icon": icon})
    entry["created"] = entry.get("created") or now
    index[slug] = entry
    save_index(index)
    SESSION_SOURCES[str(source)] = slug

    link = link_of(slug, entry)
    page_file = folder / "index.html"
    has_files = any(path.name != ".versions" and path != page_file for path in folder.iterdir())
    lines = [f"Published {source} at {link} (Version {entry['version']})" + (f' Icon: "{icon}".' if first and icon else "")]
    lines += notes
    lines.append("To update: publish the same file path again in this session (keeps this link); pass `url` to "
                 "update this artifact from another file or a later session.")
    lines.append("The link is a file on this machine. If the page is meant for someone else, tell the user when you "
                 "present the page that to share it they send the published page, "
                 + (f"the whole {folder} folder" if has_files else str(page_file))
                 + ", not the source file, which lacks the page skeleton.")
    lines.append("The files you sent are still on disk. To change the artifact, Edit them there and publish again "
                 "in the same message; no read is needed.")
    if first:
        if not OPEN_PAGES:
            lines.append("The page was not opened in a browser (ARTIFACT_OPEN=0); give the user the link.")
        elif page_publish.open_in_browser(page_file):
            lines.append("Opened it in the browser.")
        else:
            lines.append("There is no browser to open here, so the page was not opened; give the user the link.")
    return "\n\n".join(lines)


def act_preview(args):
    extra = sorted(key for key in args if key not in ("action", "file_path"))
    if extra:
        raise ValueError(f"preview takes only file_path — remove {', '.join(extra)}."
                         + (" Preview renders the single page file; files published beside it are not loaded locally."
                            if "files" in extra else ""))
    if not preview_offered():
        raise ValueError(f"preview isn't available here ({PREVIEW['reason']}). Skip the look and publish.")
    if not args.get("file_path"):
        raise ValueError("preview needs `file_path`: the local .html page to render.")
    source = absolute(args["file_path"], "file_path")
    if not source.is_file():
        raise ValueError(f"{source} doesn't exist")
    env = dict(os.environ, ARTIFACT_PYTHON=sys.executable, PYTHONIOENCODING="utf-8")
    # Captures stay on disk, as Claude Code's do, in this session's private drafts folder.
    previews = DRAFTS / ".previews"
    previews.mkdir(mode=0o700, parents=True, exist_ok=True)
    return run_preview(source, tempfile.mkdtemp(prefix=f"{source.stem[:40]}-", dir=previews), env)


def run_preview(source, out, env):
    try:
        result = subprocess.run(
            [shutil.which("node") or "node", str(SCRIPTS / "preview.mjs"), str(source), "--json", "--out", out],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240, env=env,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise ValueError("the preview ran for 4 minutes without finishing and was stopped; skip the look and publish") from None
    try:
        report = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        report = None
    if result.returncode != 0 or not isinstance(report, dict):
        output = (result.stdout + result.stderr).strip()[-2000:]
        return {"content": [{"type": "text", "text": f"preview failed: {output or 'no output'}"}], "isError": True}
    # Like Claude Code's preview, the result carries each capture as an image after the report,
    # and a preview that captured nothing is an error.
    content = [{"type": "text", "text": report["text"]}]
    for number, shot in enumerate(report.get("shots", []), 1):
        try:
            data = base64.b64encode(Path(shot["path"]).read_bytes()).decode("ascii")
        except OSError:
            continue
        if not data.startswith("/9j/") or len(data) > 1_400_000:
            continue
        content.append({"type": "text", "text": f"Capture {number} ({shot['label']}):"})
        content.append({"type": "image", "data": data, "mimeType": "image/jpeg"})
    return {"content": content, "isError": bool(report.get("failed"))}


def act_list(_args):
    index = load_index()[0]
    if not index:
        return f"No artifacts published yet (folder: {STORE})."
    rows = sorted(index.items(), key=lambda item: item[1].get("updated") or "", reverse=True)
    return "\n".join(
        f"- {entry.get('title') or slug} — {link_of(slug, entry)} (updated {entry.get('updated')}, "
        f"source {entry.get('source') or 'unknown'})"
        for slug, entry in rows
    )


def act_read(args):
    index = load_index()[0]
    slug, entry = find(args.get("url"), index)
    if not slug:
        raise ValueError("read needs the `url` of a published artifact; list them with action \"list\"")
    text = (STORE / slug / entry["page"]).read_text(encoding="utf-8")
    content = page_publish.unwrap(text)[0] if entry["page"].endswith(".html") else text
    return (f"{link_of(slug, entry)} (Version {entry['version']}, source {entry.get('source') or 'unknown'})\n"
            "This is the page content without the skeleton (doctype, head, base styles, Mermaid runtime); "
            "publishing adds the skeleton again.\n\n" + content)


def act_delete(args):
    with store_lock():
        index, repaired = load_index(repair=True)
        slug, entry = find(args.get("url"), index)
        if not slug:
            raise ValueError("delete needs the `url` of a published artifact; list them with action \"list\"")
        shutil.rmtree(STORE / slug, ignore_errors=True)
        del index[slug]
        save_index(index)
    for source in [source for source, owner in SESSION_SOURCES.items() if owner == slug]:
        del SESSION_SOURCES[source]
    return ((repaired + "\n\n" if repaired else "")
            + f"Deleted {entry.get('title') or slug} and its versions; its link no longer opens. "
            f"The source file {entry.get('source') or '(unknown)'} is untouched.")


def act_open(args):
    index = load_index()[0]
    slug, entry = find(args.get("url"), index)
    if not slug:
        raise ValueError("open needs the `url` of a published artifact")
    page = STORE / slug / entry["page"]
    return f"Opened {link_of(slug, entry)}." if page_publish.open_in_browser(page) else f"There is no browser to open here; the page is {link_of(slug, entry)}."


ACTIONS = {"publish": act_publish, "quickstart": act_quickstart, "preview": act_preview,
           "read": act_read, "list": act_list, "open": act_open, "delete": act_delete}


def unknown_parameter(args):
    """A short error for a parameter this tool doesn't take, or None."""
    known = set(schema(True)["properties"])
    for key in args:
        if key in known:
            continue
        why = CLAUDE_AI_ONLY.get(key) or ("it belongs to claude.ai's Artifact tool" if key in CLAUDE_AI_PARAMS else None)
        return (f"Unknown parameter `{key}`" + (f": {why}" if why else "") + ". This tool takes "
                + ", ".join(f"`{name}`" for name in schema(preview_offered())["properties"]) + ". Nothing was done.")
    return None


# ---------------------------------------------------------------- MCP over stdio

CLIENT = {"name": None}


def handle(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        CLIENT["name"] = (params.get("clientInfo") or {}).get("name")
        return {
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "artifact", "version": "0.1.0"},
            "instructions": INSTRUCTIONS,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [tool(preview_offered(), CLIENT["name"])]}
    if method == "tools/call":
        if params.get("name") != "Artifact":
            raise LookupError(f"unknown tool {params.get('name')!r}")
        args = params.get("arguments") or {}
        problem = unknown_parameter(args)
        if problem:
            return {"content": [{"type": "text", "text": problem}], "isError": True}
        action = args.get("action") or "publish"
        if action not in ACTIONS or action == "preview" and not PREVIEW_SWITCH:
            return {"content": [{"type": "text", "text": f"Unknown action {action!r}."}], "isError": True}
        try:
            result = ACTIONS[action](args)
            return result if isinstance(result, dict) else {"content": [{"type": "text", "text": result}]}
        except Exception as error:  # reported to the model as a tool error
            return {"content": [{"type": "text", "text": f"{action} failed: {error}"}], "isError": True}
    raise LookupError(f"method not found: {method}")


def main():
    # Protocol messages are UTF-8 whatever the platform's default encoding (a Windows pipe's is
    # not), and stdout carries only them: anything the helpers print goes to stderr.
    out = sys.stdout.buffer
    sys.stdout = sys.stderr
    threading.Thread(target=check_preview, daemon=True).start()
    for line in io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict) or "id" not in message:
            continue  # a notification
        try:
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
        except LookupError as error:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": str(error)}}
        except Exception as error:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": str(error)}}
        out.write((json.dumps(reply) + "\n").encode("utf-8"))
        out.flush()


if __name__ == "__main__":
    main()
