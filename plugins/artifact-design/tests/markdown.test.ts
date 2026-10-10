// The Markdown renderer against golden pages. Each fixtures/markdown/<name>.html is what the plugin's
// earlier Python renderer (render_markdown.py) made of <name>.md, so a change here is a change in
// how a published .md file looks; regenerate a golden only for a change you mean.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { page, render } from "../src/render-markdown.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "markdown");

describe("render", () => {
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".md"))) {
    test(name, () => {
      const source = readFileSync(join(FIXTURES, name), "utf8");
      const expected = readFileSync(join(FIXTURES, name.replace(/\.md$/, ".html")), "utf8");
      expect(render(source)).toBe(expected);
    });
  }
});

describe("page", () => {
  test("names the tab after the file and the artifact after an opening heading", () => {
    const [html, title] = page("# Release *notes*\n\nBody text.\n", "notes.md");
    expect(title).toBe("Release notes");
    expect(html).toContain("<title>notes.md</title>");
    expect(html).toContain("Markdown \u00b7 notes.md");
    expect(html).toContain("Release <em>notes</em>");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("turns a mermaid fence into a diagram block", () => {
    const [html] = page("```mermaid\ngraph TD; A-->B\n```\n", "d.md");
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B</pre>');
  });
});
