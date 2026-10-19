// The loop for building a Claude Code mod (a plugin of function hooks), as one command:
//
//   bun run mod check <dir>              validate, type-check and test, the way CI and a reviewer would
//   bun run mod test <dir> [--grep re]   the tests, split across the cores, or only the matching ones
//   bun run mod types <dir>              type-check against this build's API
//   bun run mod preview <dir> [...]      draw a band through a session and check its layout
//
// Each command works on a copy of the mod and leaves its folder as it was. `bun run mod help <command>`
// says more.

import { parseArgs, seconds, modDir, stream } from "./common.ts";
import { previewMod, PREVIEW_HELP, PREVIEW_SWITCHES } from "./preview.ts";
import { testMod } from "./test.ts";
import { typecheckMod } from "./types.ts";

const HELP: Record<string, string> = {
  check: `bun run mod check <dir> [--grep re] [--shards n]

Runs \`claude plugin validate\`, tsc against this build's API, and the tests (as \`mod test\`), and
says which passed. A missing manifest version is the one warning it allows, as CI does.`,
  test: `bun run mod test <dir> [--grep re] [--shards n]

Runs the mod's tests with \`claude plugin test\` on a copy whose test files are split into shards that
run side by side, balanced by each test's last time. --grep keeps the tests whose names match (a
regular expression, case-insensitive), with the earlier parts of a test named "(2 of 2)". --shards 1
runs the files as they are.`,
  types: `bun run mod types <dir> [--api path/to/claude-code.d.ts]

Type-checks the mod: with its own tsconfig.json when the engine has laid .claude-plugin/types/, else
against the API declarations the plugin-authoring skill last wrote (or the ones --api names).`,
  preview: PREVIEW_HELP,
};

const USAGE = `bun run mod <check|test|types|preview|help> ...\n\n${Object.values(HELP)
  .map((text) => text.split("\n")[0])
  .join("\n")}`;

/** `claude plugin validate`, passing when its only warning is the manifest version mods leave unset. */
async function validate(dir: string): Promise<number> {
  const lines: string[] = [];
  const code = await stream(["claude", "plugin", "validate", "--strict", dir], dir, (line) => lines.push(line));
  console.log(lines.join("\n"));
  if (code === 0) return 0;
  const text = lines.join("\n");
  const warnings = Number(/Found (\d+) warning/.exec(text)?.[1] ?? 0);
  const versions = (text.match(/No version specified/g) ?? []).length;
  return /Found \d+ error/.test(text) || warnings !== versions ? 1 : 0;
}

function grepOf(flags: Map<string, string[]>): RegExp | undefined {
  const value = flags.get("grep")?.at(-1);
  return value === undefined || value === "" ? undefined : new RegExp(value, "i");
}

function shardsOf(flags: Map<string, string[]>): number | undefined {
  const value = flags.get("shards")?.at(-1);
  return value === undefined ? undefined : Number(value);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { words, flags } = parseArgs(rest, PREVIEW_SWITCHES);
  switch (command) {
    case "check": {
      const dir = modDir(words[0]);
      const steps: [string, () => Promise<number>][] = [
        ["validate", () => validate(dir)],
        ["types", () => typecheckMod(dir, flags.get("api")?.at(-1))],
        ["tests", () => testMod(dir, { grep: grepOf(flags), shards: shardsOf(flags) })],
      ];
      const results: string[] = [];
      let failed = 0;
      for (const [name, step] of steps) {
        console.log(`\n── ${name}`);
        const started = performance.now();
        const code = await step();
        failed += code === 0 ? 0 : 1;
        results.push(`${code === 0 ? "pass" : "FAIL"}  ${name} (${seconds(started)})`);
      }
      console.log(`\n${results.join("\n")}`);
      return failed === 0 ? 0 : 1;
    }
    case "test":
      return await testMod(modDir(words[0]), { grep: grepOf(flags), shards: shardsOf(flags) });
    case "types":
      return await typecheckMod(modDir(words[0]), flags.get("api")?.at(-1));
    case "preview":
      return await previewMod(modDir(words[0]), flags);
    case "help":
    case undefined:
      console.log(words[0] !== undefined && HELP[words[0]] !== undefined ? HELP[words[0]] : USAGE);
      return 0;
    default:
      console.log(USAGE);
      return 1;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
