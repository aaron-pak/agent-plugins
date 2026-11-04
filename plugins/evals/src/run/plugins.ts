// Which plugin a suite tests: the target folder itself when it is a plugin (a manifest or a skills/
// folder) or a skill (a SKILL.md, wrapped as a one-skill plugin), or the folders a case names in
// `plugins:`. And the eval folder: --eval-dir, else the manifest's `experimental.evals`, else evals/.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { type Case, CaseError, inCase } from "./case.ts";
import { type ServerPlan, declaredServers } from "./mocks.ts";

const MANIFESTS = [".claude-plugin/plugin.json", "plugin.json", ".codex-plugin/plugin.json"];

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function manifestOf(dir: string): { path: string; data: Record<string, unknown> } | undefined {
  for (const m of MANIFESTS) {
    const data = readJson(join(dir, m));
    if (data) return { path: join(dir, m), data };
  }
  return undefined;
}

export function isPlugin(dir: string): boolean {
  return (
    manifestOf(dir) !== undefined || existsSync(join(dir, "skills")) || existsSync(join(dir, "hooks", "hooks.json"))
  );
}

export function isSkill(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md"));
}

export function pluginName(dir: string): string {
  const m = manifestOf(dir);
  return typeof m?.data.name === "string" ? m.data.name : basename(dir);
}

export function pluginVersion(dir: string): string | null {
  const m = manifestOf(dir);
  return typeof m?.data.version === "string" ? m.data.version : null;
}

/** The eval folder of a target. */
export function evalDirOf(target: string, flag?: string): string {
  if (flag) return resolve(target, flag);
  const evals = (manifestOf(target)?.data.experimental as { evals?: unknown } | undefined)?.evals;
  if (typeof evals === "string" && evals && !evals.startsWith("/") && !evals.split("/").includes(".."))
    return resolve(target, evals);
  return join(target, "evals");
}

const wrapped = new Map<string, string>();

/** A skill folder as a plugin Claude Code can load: a temp plugin holding a copy of the skill. */
export function wrapSkill(skillDir: string): string {
  const known = wrapped.get(skillDir);
  if (known) return known;
  const root = mkdtempSync(join(tmpdir(), "evals-skill-"));
  const name = basename(skillDir);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  cpSync(skillDir, join(root, "skills", name), { recursive: true, filter: (src) => !src.includes(`${name}/evals`) });
  wrapped.set(skillDir, root);
  return root;
}

export function cleanupWrapped(): void {
  for (const dir of wrapped.values()) rmSync(dir, { recursive: true, force: true });
  wrapped.clear();
}

/** The plugin folders a case loads in its "with" arm. */
export function casePluginDirs(c: Case, targetPlugin: string | null): string[] {
  if (c.plugins) {
    return c.plugins.map((p) => {
      const dir = inCase(c, p);
      if (!existsSync(dir)) throw new CaseError(`case "${c.name}": plugins: ${p} does not exist`);
      if (isPlugin(dir)) return dir;
      if (isSkill(dir)) return wrapSkill(dir);
      throw new CaseError(
        `case "${c.name}": plugins: ${p} is neither a plugin (a manifest or skills/) nor a skill (SKILL.md)`,
      );
    });
  }
  return targetPlugin ? [targetPlugin] : [];
}

/**
 * Copies a plugin into the run's sandbox with its MCP servers rebound: each mocked server runs the
 * stand-in, each withheld one is dropped, so tool names stay what the plugin's own servers give.
 */
export function rebindPlugin(
  pluginDir: string,
  into: string,
  servers: ServerPlan[],
  command: (s: ServerPlan) => { command: string; args: string[] },
): string {
  const mine = servers.filter((s) => s.kind === "shadow" && s.pluginDir === pluginDir);
  if (mine.length === 0) return pluginDir;
  const dest = join(into, basename(pluginDir));
  cpSync(pluginDir, dest, { recursive: true, filter: (src) => !/\/(\.git|node_modules\/\.cache)(\/|$)/.test(src) });
  const declared = declaredServers(pluginDir);
  const kept: Record<string, unknown> = {};
  for (const [name, config] of declared) {
    const plan = mine.find((s) => s.dirName === name);
    if (!plan) kept[name] = config;
    else if (!plan.withheld) kept[name] = { type: "stdio", ...command(plan) };
  }
  writeFileSync(join(dest, ".mcp.json"), JSON.stringify({ mcpServers: kept }, null, 2));
  for (const m of MANIFESTS) {
    const data = readJson(join(dest, m));
    if (data && "mcpServers" in data) {
      delete data.mcpServers;
      writeFileSync(join(dest, m), JSON.stringify(data, null, 2));
    }
  }
  if (existsSync(join(dest, "mcp.json"))) rmSync(join(dest, "mcp.json"));
  return dest;
}
