// The bundled publish.mjs script, run with node as the skill runs it.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");
const PUBLISH = join(PLUGIN, "skills", "artifact-design", "scripts", "publish.mjs");
const TEMP = mkdtempSync(join(tmpdir(), "artifact-scripts-test-"));

afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const node = (args: string[], options: { input?: string; env?: Record<string, string> } = {}) =>
  spawnSync("node", args, { encoding: "utf8", input: options.input, env: { ...process.env, ...options.env } });

describe("publish.mjs", () => {
  test("publishes a copy beside the page", () => {
    const page = join(TEMP, "plan.html");
    writeFileSync(page, "<title>Plan</title>\n<p>Hi</p>\n");
    const run = node([PUBLISH, page, "--description", "A plan.", "--no-open"]);
    expect(run.status).toBe(0);
    const published = join(TEMP, "plan.published.html");
    expect(run.stdout).toStartWith(`Published ${page} at file://`);
    const text = readFileSync(published, "utf8");
    expect(text).toContain('<meta name="description" content="A plan.">');
    expect(text).toContain("<title>Plan</title>\n<p>Hi</p>");
  });

  test("prints only the path with --quiet, and warns about what is missing otherwise", () => {
    const page = join(TEMP, "bare.html");
    writeFileSync(page, "<p>No name</p>");
    expect(node([PUBLISH, page, "--quiet"]).stdout).toBe(join(TEMP, "bare.published.html") + "\n");
    const loud = node([PUBLISH, page, "--no-open"]).stdout;
    expect(loud).toContain("warning: no <title> in the first 8KB");
    expect(loud).toContain("warning: no --description");
  });

  test("renders Markdown", () => {
    const page = join(TEMP, "notes.md");
    writeFileSync(page, "# Notes\n");
    expect(node([PUBLISH, page, "--quiet"]).status).toBe(0);
    expect(readFileSync(join(TEMP, "notes.published.html"), "utf8")).toContain("<title>notes.md</title>");
  });

  test("fails on a missing file", () => {
    const run = node([PUBLISH, join(TEMP, "missing.html")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toStartWith("publish.mjs: ");
  });
});
