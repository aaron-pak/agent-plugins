// Publish an HTML artifact as a local file, the way Claude Code's Artifact tool publishes one.
//
// Write the page content exactly as the skill describes for the Artifact tool: no doctype,
// <html>, <head> or <body> tags, with the page's <title> and <style> first. Then run
//
//     node publish.mjs page.html [--description "One sentence."] [--title "Name"]
//                                [--out other.html] [--no-open] [--quiet]
//
// Like the Artifact tool, it leaves page.html as written and publishes a copy: page.published.html
// beside it (or --out), so relative paths to the page's own files still resolve. The copy is
// wrapped in the tool's publish skeleton, carries a Content-Security-Policy that mirrors the
// claude.ai artifact allowlist (so a load that claude.ai blocks fails here too), and draws
// <pre class="mermaid"> blocks with the Mermaid runtime Claude Code adds. A Markdown file
// (.md) is rendered into the document template Claude Code uses for one. The script prints the
// published path, the local stand-in for the artifact's link, and opens it in the browser.
// To update, edit page.html and publish it again. A file that already carries the skeleton
// is unwrapped first instead of nested; any other full HTML document is wrapped as it is.
//
// scripts/build.ts bundles it into skills/artifact-design/scripts/publish.mjs, which runs on Node.

import { writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

import { escape } from "./html.ts";
import {
  FULL_DOCUMENT_NOTE,
  OWN_FILES_FETCH_NOTE,
  SIZE_LIMIT,
  fetchesOwnFiles,
  isFullDocument,
  markdownPage,
  openInBrowser,
  pageTitle,
  readSource,
  unwrap,
  wrap,
} from "./publish.ts";
import { fileUri, resolvePath } from "./paths.ts";

const USAGE =
  "usage: node publish.mjs page [--description DESCRIPTION] [--title TITLE] [--out OUT] [--no-open] [--quiet]";

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        description: { type: "string" },
        title: { type: "string" },
        out: { type: "string" },
        "no-open": { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${USAGE}\npublish.mjs: error: ${(error as Error).message}`);
    process.exit(2);
  }
  const { values: args, positionals } = parsed;
  if (args.help) {
    console.log(`${USAGE}\n\nPublish an HTML artifact as a local file.`);
    return;
  }
  if (positionals.length !== 1) {
    console.error(`${USAGE}\npublish.mjs: error: give one page file to publish (.html, or .md)`);
    process.exit(2);
  }
  const page = positionals[0]!;

  let raw: string;
  try {
    raw = readSource(page);
  } catch (error) {
    console.error(`publish.mjs: ${page}: ${(error as Error).message}`);
    process.exit(1);
  }
  const warnings: string[] = [];
  let content: string;
  let oldDescription: string | null = null;
  let lang: string | null = null;
  let cover: boolean | null = null;
  if ([".md", ".markdown"].includes(extname(page).toLowerCase())) {
    [content] = markdownPage(raw, basename(page));
  } else {
    ({ content, description: oldDescription, lang, cover } = unwrap(raw));
    if (cover === null && isFullDocument(content)) warnings.push(FULL_DOCUMENT_NOTE);
    if (!pageTitle(content)) {
      if (args.title) content = `<title>${escape(args.title)}</title>\n` + content;
      else warnings.push("no <title> in the first 8KB, so the page has no name; add one or pass --title");
    }
  }
  const description = args.description || oldDescription;
  if (!description) warnings.push("no --description; give the page a one-sentence explanation");

  const out = args.out
    ? args.out
    : basename(page).endsWith(".published.html")
      ? page
      : join(dirname(page), basename(page, extname(page)) + ".published.html");
  if (fetchesOwnFiles(content)) warnings.push(OWN_FILES_FETCH_NOTE.replace("preview doesn't", "preview.mjs doesn't"));
  const published = wrap(content, description, lang, cover);
  writeFileSync(out, published);
  if (Buffer.byteLength(published, "utf8") > SIZE_LIMIT)
    warnings.push("the page is over 16MB, which claude.ai would refuse");

  const resolved = resolvePath(out);
  if (args.quiet) {
    console.log(resolved);
  } else {
    console.log(`Published ${resolvePath(page)} at ${fileUri(resolved)}`);
    if (resolvePath(out) !== resolvePath(page)) {
      console.log(
        `To update: edit ${page} and publish it again; ${basename(out)} is replaced. ` +
          "Give the user the published path, not the file you wrote.",
      );
    }
    for (const warning of warnings) console.log(`warning: ${warning}`);
  }
  if (!args["no-open"] && !args.quiet && !openInBrowser(resolved)) {
    console.log("No browser to open here, so the page was not opened; give the user the path above.");
  }
}

main();
