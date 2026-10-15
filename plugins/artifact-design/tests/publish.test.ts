// Publishing a page: escaping, the page's name, the skeleton round trip, and the tool's size limits.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escape, unescape } from "../src/html.ts";
import {
  GENERATOR,
  fetchesOwnFiles,
  isFullDocument,
  pageTitle,
  publishedHere,
  readSource,
  unwrap,
  usesHighlight,
  usesMermaid,
  wrap,
} from "../src/publish.ts";
import { INSTRUCTIONS, checkTool, tool, unknownParameter } from "../src/tool.ts";
import { NATIVE_ONLY } from "./native-only.ts";

describe("html", () => {
  test("escape matches the Artifact tool's", () => {
    expect(escape(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;",
    );
  });

  // The Artifact tool decodes numeric references and a short list of named ones; the rest stay.
  const cases: [string, string][] = [
    ["&amp;lt;", "&lt;"],
    ["&#65;&#x42;C", "ABC"],
    ["&#x1F600;", "\u{1f600}"],
    ["&#xD800;", "&#xD800;"],
    ["&#x110000;", "&#x110000;"],
    ["&mdash;&hellip;", "\u2014\u2026"],
    ["&AMP;", "&"],
    ["&notin;", "&notin;"],
    ["&amp", "&amp"],
  ];
  for (const [input, expected] of cases) {
    test(`unescape ${input}`, () => expect(unescape(input)).toBe(expected));
  }
});

describe("pageTitle", () => {
  test("decodes entities and collapses whitespace", () => {
    expect(pageTitle("<title> A &amp;\n B </title>")).toBe("A & B");
  });
  test("skips comments", () => {
    expect(pageTitle("<!-- <title>No</title> --><title>Yes</title>")).toBe("Yes");
  });
  test("stops at the first svg, whose title names an icon", () => {
    expect(pageTitle("<svg><title>Icon</title></svg><title>Late</title>")).toBeNull();
  });
  test("reads only the first 8192 characters", () => {
    expect(pageTitle("x".repeat(8200) + "<title>Far</title>")).toBeNull();
  });
  test("keeps 280 characters", () => {
    expect(pageTitle(`<title>${"x".repeat(300)}</title>`)).toBe("x".repeat(280));
    expect(pageTitle(`<title>${"\u{1f600}".repeat(300)}</title>`)).toBe("\u{1f600}".repeat(280));
  });
});

describe("wrap and unwrap", () => {
  const page = '<title>Plan</title>\n<style>body{color:red}</style>\n<pre class="mermaid">graph TD; A-->B</pre>';

  test("wraps the page in the skeleton with the Mermaid runtime", () => {
    const published = wrap(page, 'A "plan".');
    expect(published.startsWith("<!doctype html><html><head><meta charset=utf8>")).toBe(true);
    expect(published).toContain(GENERATOR);
    expect(published).toContain('<meta name="description" content="A &quot;plan&quot;.">');
    expect(published).toContain("\n<!-- artifact-design -->\n<style>.mermaid-diagram");
    expect(published.endsWith("\n</body></html>")).toBe(true);
    expect(publishedHere(published)).toBe(true);
  });

  test("round-trips content, description, lang and viewport", () => {
    const covered = unwrap(wrap(page, "A plan.", "fr"));
    expect(covered).toEqual({ content: page, description: "A plan.", lang: "fr", cover: true });
    const plain = '<meta name=viewport content="width=device-width">\n<p>x</p>';
    expect(unwrap(wrap(plain, null))).toEqual({ content: plain, description: null, lang: null, cover: false });
  });

  test("unwraps pages the earlier Python script published", () => {
    const old = wrap(page, "Old.")
      .replace(GENERATOR, '<meta name="generator" content="artifact-design publish.py">')
      .replace("<!-- artifact-design -->", "<!-- artifact-design publish.py -->");
    expect(publishedHere(old)).toBe(true);
    expect(unwrap(old).content).toBe(page);
  });

  test("leaves other documents as they are", () => {
    const full = "<!doctype html><html><body><p>x</p></body></html>";
    expect(unwrap(full)).toEqual({ content: full, description: null, lang: null, cover: null });
    expect(isFullDocument(full)).toBe(true);
    expect(isFullDocument("<!-- note -->\n<title>x</title>")).toBe(false);
  });
});

describe("page checks", () => {
  test("usesMermaid finds a mermaid <pre> anywhere, as Claude Code does, unless the page loads Mermaid", () => {
    expect(usesMermaid("<pre class='x mermaid'>a</pre>")).toBe(true);
    expect(usesMermaid("<PRE data-x=1 class = mermaid>a</PRE>")).toBe(true);
    expect(usesMermaid('<template><pre class="mermaid">a</pre></template>')).toBe(true);
    expect(usesMermaid("<script>el.innerHTML = '<pre class=\"mermaid\">' + src;</script>")).toBe(true);
    expect(usesMermaid('<pre data-class="mermaid">a</pre><preview class="mermaid">')).toBe(false);
    expect(
      usesMermaid('<script src="https://cdn.jsdelivr.net/npm/mermaid"></script><pre class="mermaid">a</pre>'),
    ).toBe(false);
  });

  test("usesHighlight wants a code element naming a language highlight.js knows", () => {
    expect(usesHighlight('<pre><code class="language-ts">let x</code></pre>')).toBe(true);
    expect(usesHighlight('<CODE data-x="1" class="hljs Language-Python">')).toBe(true);
    expect(usesHighlight('<code class="language-mermaid">')).toBe(false);
    expect(usesHighlight('<codex class="language-ts">')).toBe(false);
    expect(usesHighlight("<p>language-ts</p><code>x</code>")).toBe(false);
  });

  test("wrap adds highlight.js for a language-tagged code block, and unwrap removes it", () => {
    const code = '<pre><code class="language-js">const a = 1;</code></pre>';
    const published = wrap(code, null);
    expect(published).toContain(
      "\n<!-- artifact-design -->\n<script>// Generated by scripts/generate-hljs-browser-bundle.ts",
    );
    expect(published).toContain("el.classList.add('hljs');\n}catch(e){}\n}\n})();</script>\n</body></html>");
    expect(unwrap(published).content).toBe(code);
    expect(wrap("<pre><code>plain</code></pre>", null)).not.toContain("<!-- artifact-design -->");
  });

  test("fetchesOwnFiles flags relative fetches only", () => {
    expect(fetchesOwnFiles("fetch('data.json')")).toBe(true);
    expect(fetchesOwnFiles('fetch("https://example.com/x")')).toBe(false);
  });

  test("readSource drops a BOM and refuses other encodings", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    writeFileSync(join(dir, "bom.html"), Buffer.from("\ufeff<title>B</title>", "utf8"));
    expect(readSource(join(dir, "bom.html"))).toBe("<title>B</title>");
    writeFileSync(join(dir, "latin1.html"), Buffer.from("<title>Caf\xe9</title>", "latin1"));
    expect(() => readSource(join(dir, "latin1.html"))).toThrow("first invalid byte at 10");
  });
});

describe("tool", () => {
  const setting = {
    store: "/Users/someone-with-a-long-user-name/Documents/artifacts",
    drafts: "/var/folders/xy/abcdefghijklmnopqrstuvwx0000gn/T/artifact-drafts-501/20261009-142530-AbCdEf",
    opens: true,
  };

  test("stays within Codex's limits", () => {
    for (const listed of [tool("codex-mcp-client", setting), checkTool()]) {
      expect(Buffer.byteLength(listed.description!, "utf8")).toBeLessThanOrEqual(1000);
      expect(Buffer.byteLength(JSON.stringify(listed.inputSchema), "utf8")).toBeLessThanOrEqual(5000);
    }
  });

  test("keeps Claude Code's description whole", () => {
    const claude = tool("claude-code", setting);
    expect(claude.description!.length).toBeLessThanOrEqual(4096);
    expect(claude.description).toContain("**Before writing the file, Claude must load the `artifact-design` skill**");
    expect(claude.inputSchema.description).toContain("**Calls**");
    expect(claude._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  test("names no tool, type or service the plugin lacks", () => {
    const texts = [tool("claude-code", setting), tool("codex-mcp-client", setting), checkTool()].map((listed) =>
      JSON.stringify(listed),
    );
    const skills = ["skills/artifact-design", "skills/artifact-diagramming", "codex-skills/dataviz"].map((skill) =>
      readFileSync(join(import.meta.dir, "..", skill, "SKILL.md"), "utf8"),
    );
    for (const text of [...texts, INSTRUCTIONS, ...skills]) expect(text).not.toMatch(NATIVE_ONLY);
  });

  test("refuses parameters it doesn't take, saying what to do instead", () => {
    expect(unknownParameter({ action: "publish", capabilities: {} })).toStartWith(
      "Unknown parameter `capabilities`: a page here is static HTML.",
    );
    expect(unknownParameter({ action: "list" })).toBeNull();
    expect(unknownParameter({ file_path: "/a.html", files: {} }, true)).toStartWith("Unknown parameter `files`.");
  });
});
