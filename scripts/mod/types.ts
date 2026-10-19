// `bun run mod types <dir>`: type-checks a mod against the API of the Claude Code build at hand.
//
// The engine lays a mod's types in `.claude-plugin/types/` when an interactive session loads it from
// its folder; a mod with those checks with its own tsconfig.json. Elsewhere (a cloud container, CI,
// a mod never loaded) the API's declarations are where the plugin-authoring skill writes them each
// time it loads, in the temp folder; this finds the newest, preferring the installed build's, and
// checks the mod with the tsconfig.json the declarations' header gives, kept outside the mod.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root, stream } from "./common.ts";

function installedVersion(): string | undefined {
  const result = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  return /^(\d+\.\d+\.\d+)/.exec(result.stdout.toString().trim())?.[1];
}

/** The newest API declarations the plugin-authoring skill wrote, the installed build's first. */
export function findApiTypes(): { path: string; version: string } | undefined {
  const temps = new Set([tmpdir(), "/tmp", process.env.TMPDIR].filter((dir): dir is string => dir !== undefined));
  const found: { path: string; version: string; mtime: number }[] = [];
  for (const temp of temps) {
    const glob = new Bun.Glob("claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts");
    try {
      for (const rel of glob.scanSync({ cwd: temp, onlyFiles: true })) {
        const path = join(temp, rel);
        const head = readFileSync(path, "utf8").slice(0, 200);
        const version = /Written by Claude Code (\S+?)\.?$/m.exec(head)?.[1] ?? "unknown";
        found.push({ path, version, mtime: statSync(path).mtimeMs });
      }
    } catch {
      // A temp folder we may not read.
    }
  }
  const installed = installedVersion();
  found.sort((a, b) => Number(b.version === installed) - Number(a.version === installed) || b.mtime - a.mtime);
  return found[0];
}

const HOW =
  "No API types for this build. Load the plugin-authoring skill once in a Claude Code session (it writes them), " +
  "or open the mod in an interactive session with --plugin-dir, which lays them in .claude-plugin/types/.";

/** Runs tsc on the mod and resolves to its exit code. */
export async function typecheckMod(dir: string, explicit?: string): Promise<number> {
  const tsc = join(root, "node_modules", ".bin", "tsc");
  const print = (line: string) => console.log(line);
  if (explicit === undefined && existsSync(join(dir, ".claude-plugin", "types", "tsconfig.json"))) {
    console.log("tsc: with the types the engine laid in .claude-plugin/types/");
    return await stream([tsc, "-p", dir], dir, print);
  }
  const api = explicit === undefined ? findApiTypes() : { path: explicit, version: "given" };
  if (api === undefined) {
    console.log(HOW);
    return 1;
  }
  const installed = installedVersion();
  if (api.version !== "given" && installed !== undefined && api.version !== installed) {
    console.log(`(the newest API types are ${api.version}'s; the installed build is ${installed})`);
  }
  console.log(`tsc: with ${api.path}`);
  const work = mkdtempSync(join(tmpdir(), "mod-tsc-"));
  try {
    const include = [api.path, ...["hooks", "types", "tests"].map((sub) => join(dir, sub)).filter(existsSync)];
    writeFileSync(
      join(work, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2023",
          lib: ["es2023"],
          types: [],
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
          jsx: "react",
          jsxFactory: "h",
          jsxFragmentFactory: "Fragment",
        },
        include,
      }),
    );
    return await stream([tsc, "-p", work], dir, print);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
