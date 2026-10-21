#!/usr/bin/env python3
"""Check that the marketplace catalogs, plugin manifests, skills, and README agree.

Run from anywhere: python3 scripts/validate.py
Exits 1 and lists every problem it finds.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

errors = []


def error(where, message):
    errors.append(f"{where}: {message}")


def load_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        error(path.relative_to(ROOT), "missing")
    except json.JSONDecodeError as e:
        error(path.relative_to(ROOT), f"invalid JSON ({e})")
    return None


def frontmatter(path):
    """Return the SKILL.md frontmatter as a dict of top-level keys, or None."""
    lines = path.read_text().splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    fields = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip().strip("\"'")
    return None


def check_skills(plugin_dir, where, folder="skills"):
    skills_dir = plugin_dir / folder
    skill_dirs = sorted(p for p in skills_dir.iterdir() if p.is_dir()) if skills_dir.is_dir() else []
    if skills_dir.is_dir() and not skill_dirs:
        error(where, f"{folder}/ has no skill directories")
    for skill_dir in skill_dirs:
        skill_where = f"{where}/{folder}/{skill_dir.name}"
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            error(skill_where, "missing SKILL.md")
            continue
        fields = frontmatter(skill_md)
        if fields is None:
            error(skill_where, "SKILL.md has no frontmatter block between --- lines")
            continue
        if fields.get("name") != skill_dir.name:
            error(skill_where, f"frontmatter name {fields.get('name')!r} does not match the directory name")
        if not fields.get("description"):
            error(skill_where, "frontmatter has no description")
    return bool(skill_dirs)


def check_mcp(plugin_dir, where, codex_servers=None, codex_manifest=False):
    """Compare the Claude Code servers with Codex's: mcp.json, or the mcpServers in .codex-plugin/plugin.json."""
    agent_plugins = plugin_dir / "mcp.json"
    claude_code = plugin_dir / ".mcp.json"
    if codex_manifest and codex_servers is None:
        # Without mcpServers in its manifest, Codex reads .mcp.json, as Claude Code does.
        if agent_plugins.exists():
            error(where, "has mcp.json beside .codex-plugin/plugin.json; Codex reads .mcp.json or the manifest's mcpServers")
        return claude_code.exists()
    if codex_servers is not None:
        if agent_plugins.exists():
            error(where, "has mcp.json beside .codex-plugin/plugin.json; Codex reads only the manifest's mcpServers")
        if not claude_code.exists():
            error(where, ".codex-plugin/plugin.json has mcpServers but there is no .mcp.json (Claude Code)")
            return True
        c = load_json(claude_code)
        if c is None:
            return True
        codex_label, claude_servers = ".codex-plugin/plugin.json mcpServers", set(c.get("mcpServers", {}))
        if set(codex_servers) != claude_servers:
            error(where, f"{codex_label} {sorted(codex_servers)} differ from .mcp.json servers {sorted(claude_servers)}")
        return True
    if not agent_plugins.exists() and not claude_code.exists():
        return False
    if agent_plugins.exists() != claude_code.exists():
        error(where, "an MCP plugin needs both mcp.json (Codex) and .mcp.json (Claude Code)")
        return True
    a, c = load_json(agent_plugins), load_json(claude_code)
    if a is None or c is None:
        return True
    a_servers, c_servers = set(a.get("mcpServers", {})), set(c.get("mcpServers", {}))
    if not a_servers:
        error(where, "mcp.json defines no mcpServers")
    if a_servers != c_servers:
        error(where, f"mcp.json servers {sorted(a_servers)} differ from .mcp.json servers {sorted(c_servers)}")
    for name, server in a.get("mcpServers", {}).items():
        if "type" not in server:
            error(where, f"mcp.json server {name!r} has no type (Agent Plugins requires one)")
    return True


def check_plugin(entry):
    name = entry.get("name")
    where = f"plugins/{name}"
    for key in ("name", "source", "description"):
        if not entry.get(key):
            error(".claude-plugin/marketplace.json", f"entry {name!r} has no {key}")
    if entry.get("source") != f"./plugins/{name}":
        error(".claude-plugin/marketplace.json", f"entry {name!r} source should be ./plugins/{name}")
        return
    plugin_dir = ROOT / "plugins" / name
    if not plugin_dir.is_dir():
        error(where, "directory missing")
        return
    if (plugin_dir / ".claude-plugin" / "plugin.json").exists():
        if (plugin_dir / "plugin.json").exists():
            error(where, "has .claude-plugin/plugin.json; plugins carry only the root plugin.json")
        else:
            check_mod(entry, plugin_dir, where)
            return
    hooks = plugin_dir / "hooks" / "hooks.json"
    if hooks.is_file():
        config = load_json(hooks)
        if config is not None and not isinstance(config.get("hooks"), dict):
            error(f"{where}/hooks/hooks.json", "has no hooks object")

    codex_servers = None
    if (plugin_dir / ".codex-plugin" / "plugin.json").exists():
        # Codex's own manifest, for settings the Agent Plugins format can't carry. Codex reads a root
        # plugin.json first, so the two can't sit side by side.
        if (plugin_dir / "plugin.json").exists():
            error(where, "has both plugin.json and .codex-plugin/plugin.json; Codex would read only plugin.json")
        manifest_path = Path(".codex-plugin") / "plugin.json"
        manifest = load_json(plugin_dir / manifest_path)
        if manifest is not None:
            # Codex reads skills/ and, for skills Claude Code already has built in, codex-skills/.
            skills = manifest.get("skills")
            skills = [skills] if isinstance(skills, str) else skills
            if skills is not None and not (
                isinstance(skills, list) and skills and skills[0] in ("./skills/", "./skills") and set(skills[1:]) <= {"./codex-skills/"}
            ):
                error(f"{where}/{manifest_path}", "skills should be ./skills/, then optionally ./codex-skills/")
            elif skills and "./codex-skills/" in skills:
                check_skills(plugin_dir, where, "codex-skills")
            elif (plugin_dir / "codex-skills").exists():
                error(f"{where}/{manifest_path}", "codex-skills/ exists but skills doesn't list ./codex-skills/")
            servers = manifest.get("mcpServers")
            if servers is not None and not isinstance(servers, dict):
                error(f"{where}/{manifest_path}", "mcpServers should be an object of servers")
            elif servers is not None:
                codex_servers = servers
    else:
        manifest_path = Path("plugin.json")
        manifest = load_json(plugin_dir / manifest_path)
        if manifest is not None and manifest.get("$schema") != SCHEMA:
            error(f"{where}/plugin.json", f"$schema should be {SCHEMA}")
    if manifest is not None:
        where_manifest = f"{where}/{manifest_path}"
        if manifest.get("name") != name:
            error(where_manifest, f"name {manifest.get('name')!r} does not match the marketplace entry {name!r}")
        if manifest.get("description") != entry.get("description"):
            error(where_manifest, "description does not match the marketplace entry")
        if "version" in manifest:
            error(where_manifest, "version is set; leave it unset so the Git commit decides")
        if not manifest.get("author", {}).get("name"):
            error(where_manifest, "author.name is missing")

    has_skills = check_skills(plugin_dir, where)
    has_mcp = check_mcp(plugin_dir, where, codex_servers, (plugin_dir / ".codex-plugin" / "plugin.json").exists())
    if not has_skills and not has_mcp:
        error(where, "has neither skills/ nor mcp.json")


def check_mod(entry, plugin_dir, where):
    """A plugin for Claude Code only, such as a mod, keeps its manifest in .claude-plugin/plugin.json."""
    manifest = load_json(plugin_dir / ".claude-plugin" / "plugin.json")
    if manifest is None:
        return
    where = f"{where}/.claude-plugin/plugin.json"
    if manifest.get("name") != entry.get("name"):
        error(where, f"name {manifest.get('name')!r} does not match the marketplace entry {entry.get('name')!r}")
    if manifest.get("description") != entry.get("description"):
        error(where, "description does not match the marketplace entry")
    if "version" in manifest:
        error(where, "version is set; leave it unset so the Git commit decides")
    if not manifest.get("author", {}).get("name"):
        error(where, "author.name is missing")


CURSOR_ENTRY_KEYS = {"name", "source", "description", "minClientVersions"}
CURSOR_TOP_KEYS = {"name", "owner", "metadata", "plugins"}
CLAUDE_CODE_ONLY = "Claude Code only"


def check_cursor_marketplace(claude_entries):
    """The Cursor catalog is the Claude catalog, minus plugins described as Claude Code only.

    Marketplace entries follow cursor/plugins schemas/marketplace.schema.json:
    name, source, description, and minClientVersions only. source has no leading ./.
    """
    where = ".cursor-plugin/marketplace.json"
    marketplace = load_json(ROOT / ".cursor-plugin" / "marketplace.json")
    if marketplace is None:
        return
    extra = set(marketplace) - CURSOR_TOP_KEYS
    if extra:
        error(where, f"has unsupported fields {sorted(extra)}")
    if not marketplace.get("name"):
        error(where, "has no name")
    elif marketplace.get("name") != "agent-plugins":
        error(where, f"name {marketplace.get('name')!r} should be 'agent-plugins'")
    entries = marketplace.get("plugins")
    if not isinstance(entries, list):
        error(where, "plugins should be an array")
        return
    claude_by_name = {}
    for entry in claude_entries:
        name = entry.get("name")
        if name and name not in claude_by_name:
            claude_by_name[name] = entry
    listed = []
    for entry in entries:
        if not isinstance(entry, dict):
            error(where, "plugin entry should be an object")
            continue
        name = entry.get("name")
        listed.append(name)
        extra = set(entry) - CURSOR_ENTRY_KEYS
        if extra:
            error(where, f"entry {name!r} has unsupported fields {sorted(extra)}")
        for key in ("name", "source", "description"):
            if not entry.get(key):
                error(where, f"entry {name!r} has no {key}")
        if name and entry.get("source") != f"plugins/{name}":
            error(where, f"entry {name!r} source should be plugins/{name}")
        claude = claude_by_name.get(name)
        if claude is None:
            error(where, f"entry {name!r} is not in .claude-plugin/marketplace.json")
        elif entry.get("description") != claude.get("description"):
            error(where, f"entry {name!r} description does not match the Claude catalog")
        if claude is not None and CLAUDE_CODE_ONLY in (claude.get("description") or ""):
            error(where, f"entry {name!r} says Claude Code only; leave it out of the Cursor catalog")
        versions = entry.get("minClientVersions", None)
        if name == "mac-computer-use":
            if versions != {"cursor": "never"}:
                error(where, "mac-computer-use should set minClientVersions to {\"cursor\": \"never\"}")
        elif versions is not None:
            error(where, f"entry {name!r} sets minClientVersions; only mac-computer-use does")
    for name in {n for n in listed if n and listed.count(n) > 1}:
        error(where, f"plugin {name!r} is listed more than once")
    expected = [
        entry.get("name")
        for entry in claude_entries
        if entry.get("name")
        and CLAUDE_CODE_ONLY not in (entry.get("description") or "")
    ]
    for name in expected:
        if name not in listed:
            error(where, f"plugin {name!r} is missing")


def check_readme(names):
    readme = (ROOT / "README.md").read_text()
    # One bullet per plugin, so pull requests that add plugins touch different lines.
    match = re.search(r"^Current plugins:\n\n((?:- .+\n)+)", readme, re.MULTILINE)
    if not match:
        error("README.md", "no 'Current plugins:' list")
        return
    # Each bullet starts with the plugin's name; what follows it names skills inside the plugin.
    listed = re.findall(r"^- `([^`]+)`", match.group(1), re.MULTILINE)
    if sorted(listed) != sorted(names):
        error("README.md", f"'Current plugins' lists {sorted(listed)}, but the marketplace has {sorted(names)}")


def main():
    marketplace = load_json(ROOT / ".claude-plugin" / "marketplace.json")
    if marketplace is None:
        return
    entries = marketplace.get("plugins", [])
    names = [e.get("name") for e in entries]
    for name in {n for n in names if names.count(n) > 1}:
        error(".claude-plugin/marketplace.json", f"plugin {name!r} is listed more than once")
    for entry in entries:
        check_plugin(entry)
    on_disk = {p.name for p in (ROOT / "plugins").iterdir() if p.is_dir()}
    for name in sorted(on_disk - set(names)):
        error(f"plugins/{name}", "not listed in .claude-plugin/marketplace.json")
    check_readme(names)
    check_cursor_marketplace(entries)


main()
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("All plugins check out.")
