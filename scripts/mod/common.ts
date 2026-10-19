// What the mod commands share: reading a mod's folder, copying it somewhere to rearrange, and
// running Claude Code's own plugin commands on the copy.

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export const root = resolve(import.meta.dir, "..", "..");

/** A mod's folder, checked: it has the manifest a mod carries. */
export function modDir(dir: string | undefined): string {
  if (dir === undefined) throw new Error("name the mod's folder, such as plugins/session-band");
  const path = resolve(dir);
  if (!existsSync(join(path, ".claude-plugin", "plugin.json"))) {
    throw new Error(`${dir} has no .claude-plugin/plugin.json: not a mod's folder`);
  }
  return path;
}

export function modName(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
  return manifest.name;
}

/**
 * A throwaway copy of the mod, in a folder named after it (the engine names a plugin loaded from a
 * folder by its manifest, but the tests and the preview read the folder's name in their output).
 */
export function copyMod(dir: string): { path: string; dispose: () => void } {
  const work = mkdtempSync(join(tmpdir(), "mod-"));
  const path = join(work, modName(dir));
  cpSync(dir, path, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|\.git)$/.test(relative(dir, source)),
  });
  return { path, dispose: () => rmSync(work, { recursive: true, force: true }) };
}

/** Every *.test.ts and *.test.tsx under a folder, as `claude plugin test` finds them. */
export function testFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".claude-plugin" || entry.name === ".git") continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

export function cpus(): number {
  return availableParallelism();
}

/** Runs a command to its end, its output streamed through `onLine`, and resolves to its exit code. */
export async function stream(command: string[], cwd: string, onLine: (line: string) => void): Promise<number> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const pump = async (readable: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of readable) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (rest !== "") onLine(rest);
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  return await child.exited;
}

export function seconds(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)}s`;
}

/** `--name value` options, the `switches` (which take no value), and the words around them. */
export function parseArgs(
  argv: string[],
  switches: ReadonlySet<string>,
): { words: string[]; flags: Map<string, string[]> } {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const next = argv[i + 1];
    const value = inline ?? (switches.has(name) || next === undefined ? "" : (i++, next));
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { words, flags };
}
