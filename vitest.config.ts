// Vitest runs the plugins' tests on Node, the runtime the plugins themselves run on.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// A mod (a plugin with its own .claude-plugin/plugin.json) has tests that run in Claude Code
// (bun run mod test), not here.
const plugins = fileURLToPath(new URL("plugins/", import.meta.url));
const mods = readdirSync(plugins).filter((name) => existsSync(`${plugins}${name}/.claude-plugin/plugin.json`));

export default defineConfig({
  plugins: [
    {
      // The sources import their text files `with { type: "text" }`, which the build inlines as strings
      // (scripts/build.ts); Vite doesn't know the attribute, so the tests load those files the same way.
      name: "text-imports",
      enforce: "pre",
      load(id) {
        if (!/\/plugins\/[^/]+\/.*\.(?:html|md)$/.test(id)) return null;
        return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
  test: {
    include: ["plugins/*/tests/**/*.test.ts"],
    exclude: [...mods.map((name) => `plugins/${name}/**`), "**/node_modules/**"],
    testTimeout: 30_000,
  },
});
