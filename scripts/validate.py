#!/usr/bin/env python3
"""Check that the marketplace catalog, plugin manifests, skills, and README agree.

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


def check_skills(plugin_dir, where):
    skills_dir = plugin_dir / "skills"
    skill_dirs = sorted(p for p in skills_dir.iterdir() if p.is_dir()) if skills_dir.is_dir() else []
    if skills_dir.is_dir() and not skill_dirs:
        error(where, "skills/ has no skill directories")
    for skill_dir in skill_dirs:
        skill_where = f"{where}/skills/{skill_dir.name}"
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


def check_mcp(plugin_dir, where):
    agent_plugins = plugin_dir / "mcp.json"
    claude_code = plugin_dir / ".mcp.json"
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
        error(where, "has .claude-plugin/plugin.json; plugins carry only the root plugin.json")

    manifest = load_json(plugin_dir / "plugin.json")
    if manifest is not None:
        if manifest.get("$schema") != SCHEMA:
            error(f"{where}/plugin.json", f"$schema should be {SCHEMA}")
        if manifest.get("name") != name:
            error(f"{where}/plugin.json", f"name {manifest.get('name')!r} does not match the marketplace entry {name!r}")
        if manifest.get("description") != entry.get("description"):
            error(f"{where}/plugin.json", "description does not match the marketplace entry")
        if "version" in manifest:
            error(f"{where}/plugin.json", "version is set; leave it unset so the Git commit decides")
        if not manifest.get("author", {}).get("name"):
            error(f"{where}/plugin.json", "author.name is missing")

    has_skills = check_skills(plugin_dir, where)
    has_mcp = check_mcp(plugin_dir, where)
    if not has_skills and not has_mcp:
        error(where, "has neither skills/ nor mcp.json")


def check_readme(names):
    readme = (ROOT / "README.md").read_text()
    match = re.search(r"^Current plugins: (.+)$", readme, re.MULTILINE)
    if not match:
        error("README.md", "no 'Current plugins:' line")
        return
    # Parenthetical notes on the line name skills inside a plugin, not plugins.
    listed = re.findall(r"`([^`]+)`", re.sub(r"\([^)]*\)", "", match.group(1)))
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


main()
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("All plugins check out.")
