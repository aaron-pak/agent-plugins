// Markdown pages, laid out by Claude Code's rules: marked renders the body, and the heading that
// opens the document becomes the template's <h1>.

import { describe, expect, test } from "bun:test";

import { page, render } from "../src/render-markdown.ts";

const h1 = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
const section = (html: string) => /<section>([\s\S]*)<\/section>/.exec(html)?.[1];

describe("render", () => {
  test("renders GitHub-flavored Markdown with marked", () => {
    expect(render("| a | b |\n|---|---|\n| 1 | 2 |\n")).toContain("<td>1</td>");
    expect(render("- [x] done\n")).toBe('<ul>\n<li><input checked="" disabled="" type="checkbox"> done</li>\n</ul>\n');
    expect(render("```js\nlet a = 1 < 2;\n```\n")).toBe(
      '<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>\n',
    );
  });

  test("turns a mermaid fence into a diagram block", () => {
    expect(render("```mermaid\ngraph TD; A-->B\n```\n")).toBe('<pre class="mermaid">graph TD; A--&gt;B</pre>\n');
  });
});

describe("page", () => {
  test("names the tab after the file and the artifact after an opening heading", () => {
    const [html, title] = page("# Release *notes*\n\nBody text.\n", "notes.md");
    expect(title).toBe("Release notes");
    expect(html).toContain("<title>notes.md</title>");
    expect(html).toContain("Markdown · notes.md");
    expect(h1(html)).toBe("Release <em>notes</em>");
    expect(section(html)).toBe("<p>Body text.</p>\n");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("finds the opening heading after YAML front matter and comments", () => {
    const [html, title] = page("---\ntitle: x\n---\n<!-- draft -->\n\n## Plan\n\nText.\n", "plan.md");
    expect(title).toBe("Plan");
    expect(h1(html)).toBe("Plan");
    expect(section(html)).not.toContain(">Plan</h2>");
  });

  test("keeps the <h1> empty when the first heading comes later", () => {
    const [html, title] = page("Intro text.\n\n# Later\n", "doc.md");
    expect(title).toBe("Later");
    expect(h1(html)).toBe("");
    expect(section(html)).toContain("<h1>Later</h1>");
  });

  test("falls back to the file name with no heading at all", () => {
    const [html, title] = page("Just text & more.\n", "a&b.md");
    expect(title).toBe("a&b.md");
    expect(h1(html)).toBe("a&amp;b.md");
  });

  test("resolves link references in the heading", () => {
    const [html, title] = page("# See [the docs][d]\n\n[d]: https://example.com 'Docs'\n", "d.md");
    expect(h1(html)).toBe('See <a href="https://example.com" title="Docs">the docs</a>');
    expect(title).toBe("See the docs");
  });

  test("escapes a heading whose HTML holds a section tag", () => {
    const [html] = page("# A <section> B\n", "s.md");
    expect(h1(html)).toBe("A &lt;section&gt; B");
  });

  test("keeps 120 characters of the name", () => {
    const [, title] = page(`# ${"\u{1f600}".repeat(130)}\n`, "e.md");
    expect([...title].length).toBe(120);
  });
});
