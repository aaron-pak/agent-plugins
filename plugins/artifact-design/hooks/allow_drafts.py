"""PreToolUse hook: let Write and Edit into the artifact server's drafts folder through without a
permission prompt, as Claude Code lets them into its own scratchpad.

Claude Code lists a scratchpad only when its own Artifact tool is on, so the `artifact` server sends
page files to a private folder per session under <temp>/artifact-drafts-<uid> instead (see DRAFTS in
mcp/server.py). That folder is outside the project, so Claude Code would ask before each session's
first page. This answers "allow" only for a path inside that folder, when the folder is a real
directory this user owns; for anything else it says nothing and the usual permission check runs.
"""
import json
import os
import sys
import tempfile
from pathlib import Path


def drafts_target(event):
    # Codex runs plugin hooks too and matches apply_patch as Write and Edit, but it rejects "allow"
    # without a rewritten input, and its sandbox already lets writes into the temp folder.
    if event.get("tool_name") not in ("Write", "Edit", "MultiEdit"):
        return False
    path = Path((event.get("tool_input") or {}).get("file_path") or "")
    root = Path(tempfile.gettempdir()) / (f"artifact-drafts-{os.getuid()}" if hasattr(os, "getuid") else "artifact-drafts")
    if not path.is_absolute() or root.is_symlink() or not root.is_dir():
        return False
    if hasattr(os, "getuid") and root.stat().st_uid != os.getuid():
        return False
    target = path.parent.resolve() / path.name
    return root.resolve() in target.parents and not target.is_symlink()


def main():
    try:
        allowed = drafts_target(json.load(sys.stdin))
    except (OSError, ValueError, TypeError, AttributeError):
        allowed = False
    if allowed:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "a page draft in the artifact server's private drafts folder",
        }}))


if __name__ == "__main__":
    main()
