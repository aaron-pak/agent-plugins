// Compare the artifact-design plugin with a Claude Code release: the re-sync check AGENTS.md
// describes, made mechanical for the weekly routine and for re-syncing by hand.
//
//   bun run drift                 compare with the latest release
//   bun run drift --to 2.1.297    compare with that release
//   bun run drift --write         also refresh the plugin's verbatim copies from it
//   bun run drift --from 2.1.293  compare from that release instead of the synced one
//
// It fetches Claude Code's Linux x64 build (npm pack @anthropic-ai/claude-code-linux-x64) of the
// release the plugin was synced with, which plugins/artifact-design/UPSTREAM.md names, and of the
// target, reads the files each build bundles (a Bun executable carries its module graph at its
// end), and reports:
// - the plugin's verbatim copies that differ from the target's: the dataviz and artifact-diagramming
//   skills, the Markdown template, the highlight.js runtime and its languages, the Mermaid runtime;
// - for what the plugin ports with edits, what changed between the two releases: the artifact-design
//   skill file as a diff, and the string literals the target's code added or removed where it builds
//   the page contract, the Artifact tool's description, the publish skeleton and runtimes, the
//   Markdown publish, preview, and dataviz's description, and in the marked it bundles.
// Exit status: 0 when nothing changed, 1 when something did, 2 when the check itself failed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "acorn";

const root = resolve(import.meta.dir, "..");
const plugin = join(root, "plugins", "artifact-design");

// ---------------------------------------------------------------- a release's bundled files

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** The Claude Code binary of a release, fetched from npm once and kept in the temp directory. */
function fetchBinary(version: string): string {
  const dir = join(tmpdir(), "claude-code-drift", version);
  const path = join(dir, "package", "claude");
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tarball = run(["npm", "pack", `@anthropic-ai/claude-code-linux-x64@${version}`, "--silent"], dir);
    run(["tar", "xzf", tarball.split("\n").at(-1)!], dir);
  }
  return path;
}

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const RECORD = 52; // bytes per module record in Bun's module graph
const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** The files a Bun executable bundles, by name (without the /$bunfs/root/ prefix), as text. */
function readBundle(path: string): Map<string, string> {
  const data = readFileSync(path);
  const at = data.lastIndexOf(TRAILER);
  if (at < 32) throw new Error(`${path}: no Bun module graph`);
  // The 32 bytes before the trailer: the graph's length, then the offset and length of its module table.
  const offsets = at - 32;
  const base = offsets - Number(data.readBigUInt64LE(offsets));
  const table = base + data.readUInt32LE(offsets + 8);
  const tableLength = data.readUInt32LE(offsets + 12);
  if (tableLength % RECORD) throw new Error(`${path}: the module table isn't ${RECORD}-byte records`);
  const field = (record: number, at: number) => {
    const start = base + data.readUInt32LE(record + at);
    return data.subarray(start, start + data.readUInt32LE(record + at + 4));
  };
  const files = new Map<string, string>();
  for (let record = table; record < table + tableLength; record += RECORD) {
    const name = field(record, 0).toString("utf8").replace("/$bunfs/root/", "");
    let contents = field(record, 8);
    if (contents.subarray(0, 4).equals(ZSTD)) contents = Buffer.from(Bun.zstdDecompressSync(contents));
    // The record's encoding byte: Bun keeps text with characters past Latin-1 as UTF-16.
    const encoding = data[record + 48];
    files.set(name, contents.toString(encoding === 2 ? "utf16le" : encoding === 1 ? "latin1" : "utf8"));
  }
  return files;
}

type Bundle = Map<string, string>;

function only(bundle: Bundle, what: string, test: (name: string, text: string) => boolean): [string, string] {
  const found = [...bundle].filter(([name, text]) => test(name, text));
  if (found.length !== 1) throw new Error(`${what}: ${found.length} bundled files match`);
  return found[0]!;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A bundled copy of a skill file: Bun names it after the file, with a hash, and .txt or .zst added. */
function skillFile(bundle: Bundle, file: string): string {
  const base = file.split("/").at(-1)!;
  const dot = base.lastIndexOf(".");
  const [stem, ext] = [base.slice(0, dot), base.slice(dot + 1)];
  const name = new RegExp(
    `^(?:${escapeRegExp(base)}-[0-9a-z]{8}\\.txt|${escapeRegExp(stem)}-[0-9a-z]{8}\\.${escapeRegExp(ext)})(?:\\.zst)?$`,
  );
  return only(bundle, file, (bundled) => name.test(bundled))[1];
}

// ---------------------------------------------------------------- string literals in the CLI's code

/** A string or template literal: its parts as written and with escapes applied, and its ${…} expressions. */
type Literal = { start: number; raw: string[]; cooked: string[]; exprs: string[] };

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Quasi = { value: { raw: string; cooked: string | null } };

const parsed = new Map<string, Literal[]>();

/** The string and template literals of a bundled file's code, in source order. */
function literals(code: string): Literal[] {
  const known = parsed.get(code);
  if (known) return known;
  const out: Literal[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "Literal" && typeof n.value === "string") {
      out.push({ start: n.start, raw: [code.slice(n.start + 1, n.end - 1)], cooked: [n.value], exprs: [] });
    } else if (n.type === "TemplateLiteral") {
      const quasis = n.quasis as Quasi[];
      out.push({
        start: n.start,
        raw: quasis.map((quasi) => quasi.value.raw),
        cooked: quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw),
        exprs: (n.expressions as Node[]).map((expr) => code.slice(expr.start, expr.end)),
      });
    }
    for (const key in n) if (key !== "type" && key !== "start" && key !== "end") visit(n[key]);
  };
  visit(parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }));
  out.sort((a, b) => a.start - b.start);
  parsed.set(code, out);
  return out;
}

/** A literal's text, each ${…} filled from `values` by its expression. */
function cook(literal: Literal, values: Record<string, string> = {}): string {
  return literal.cooked
    .map((part, k) => {
      if (k === 0) return part;
      const expr = literal.exprs[k - 1]!;
      if (!(expr in values)) throw new Error(`no value for \${${expr}}`);
      return values[expr] + part;
    })
    .join("");
}

/** The literal holding this text, from the one bundled file whose code holds it. */
function literalWith(bundle: Bundle, text: string): { literal: Literal; all: Literal[]; code: string } {
  const [, code] = only(
    bundle,
    `code with ${JSON.stringify(text)}`,
    (name, src) => name.endsWith(".js") && src.includes(text),
  );
  const all = literals(code);
  const literal = all.find((lit) => lit.cooked.some((part) => part.includes(text)));
  if (!literal) throw new Error(`no literal holds ${JSON.stringify(text)}`);
  return { literal, all, code };
}

/** The numbers a literal's ${name} expressions name, from the name=<number> assignments in its code. */
function numbers(literal: Literal, code: string): Record<string, string> {
  return Object.fromEntries(
    literal.exprs.map((expr) => {
      const found = new RegExp(`[,;\\s{]${escapeRegExp(expr)}=(\\d+)[,;]`).exec(code);
      if (!found) throw new Error(`no number for \${${expr}}`);
      return [expr, found[1]!];
    }),
  );
}

// ---------------------------------------------------------------- the plugin's verbatim copies

/** highlight.js as the Artifact tool inlines it: its bundle, then the script that highlights the page. */
function hljsRuntime(bundle: Bundle): string {
  const [, hljs] = only(bundle, "highlight.js bundle", (name) => name === "hljsBundle.generated.min.js");
  const { literal, code } = literalWith(bundle, "if(typeof hljs==='undefined')return;");
  return `<script>${hljs}</script>\n<script>${cook(literal, numbers(literal, code))}</script>\n`;
}

/** The highlight.js language names and aliases whose code blocks make the Artifact tool add highlight.js. */
function hljsLanguages(bundle: Bundle): string {
  const [, hljs] = only(bundle, "highlight.js bundle", (name) => name === "hljsBundle.generated.min.js");
  const keysOf = (map: string) => {
    const start = new RegExp(`[,;\\s]${escapeRegExp(map)}=\\{`).exec(hljs);
    if (!start) throw new Error(`highlight.js bundle: no ${map}={…}`);
    const body = hljs.slice(start.index + start[0].length, hljs.indexOf("}", start.index));
    return [...body.matchAll(/(?:^|,)\s*("(?:[^"\\]|\\.)*"|[\w$]+)\s*:/g)].map(
      (key) => JSON.parse(`"${key[1]!.replace(/^"|"$/g, "")}"`) as string,
    );
  };
  const languages = /Object\.entries\(([\w$]+)\)\)\{let [\w$]+=[\w$]+\(\);[\w$]+\.registerLanguage/.exec(hljs)?.[1];
  const aliases = /Object\.entries\(([\w$]+)\)\)if\(![\w$]+\.getLanguage\([\w$]+\)\)[\w$]+\.registerAliases/.exec(
    hljs,
  )?.[1];
  if (!languages || !aliases) throw new Error("highlight.js bundle: no language or alias registration found");
  const names = [...new Set([...keysOf(languages), ...keysOf(aliases)])].sort();
  return JSON.stringify(names, null, 0).replaceAll('","', '",\n  "').replace("[", "[\n  ").replace(/\]$/, "\n]\n");
}

/** The Mermaid runtime the Artifact tool adds to a page with a diagram, loading Mermaid from jsDelivr
 * (the same file) instead of claude.ai's /_runtime/ path. */
function mermaidRuntime(bundle: Bundle): string {
  const { literal: init, all, code } = literalWith(bundle, "if(typeof mermaid==='undefined')return;");
  const lead = all[all.indexOf(init) - 1]!;
  const style = all.find((lit) => lit.cooked[0]!.startsWith("<style>.mermaid-diagram{"));
  const script = literalWith(bundle, '<script src="/_runtime/mermaid-').literal;
  const palettes = /=(\{light:\{[^{}]*\},dark:\{[^{}]*\}\})/.exec(code)?.[1];
  if (!style || !script || !palettes) throw new Error("Mermaid runtime: style, script or palettes not found");
  const version = /mermaid-(\d+\.\d+\.\d+)\.min\.js/.exec(cook(script))![1];
  const config = JSON.stringify({ palettes: JSON.parse(palettes.replace(/([{,])(\w+):/g, '$1"$2":')) });
  return (
    `${cook(style)}\n<script src="https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js"></script>\n` +
    `<script>${cook(lead)}${config}${cook(init)}</script>\n`
  );
}

/** A skill file with its frontmatter's description replaced, written as the plugin writes it. */
function withDescription(skill: string, description: string): string {
  return skill.replace(
    /^(---\nname: [^\n]*\ndescription: )[^\n]*/,
    (_whole, lead: string) => lead + `'${description.replaceAll("'", "''")}'`,
  );
}

const body = (skill: string) => skill.replace(/^---\n[\s\S]*?\n---\n/, "").trimStart();

/** Each verbatim copy's path in the plugin, and how to make it from a release's bundle. */
const VERBATIM: { path: string; from: (bundle: Bundle, current: string) => string }[] = [
  {
    path: "skills/artifact-diagramming/SKILL.md",
    from: (bundle) =>
      only(
        bundle,
        "artifact-diagramming SKILL.md",
        (name, text) => name.startsWith("SKILL-") && text.startsWith("---\nname: artifact-diagramming\n"),
      )[1],
  },
  {
    // Claude Code lists dataviz by its own description and loads the body of its SKILL.md.
    path: "skills/dataviz/SKILL.md",
    from: (bundle, current) => {
      const description = cook(literalWith(bundle, "brand-neutral placeholder palette").literal);
      const skill = only(
        bundle,
        "dataviz SKILL.md",
        (name, text) => name.startsWith("SKILL-") && text.startsWith("---\nname: Data Visualization\n"),
      )[1];
      const head = withDescription(current, description).match(/^---\n[\s\S]*?\n---\n/)![0];
      return `${head}\n${body(skill)}`;
    },
  },
  ...[
    "references/anti-patterns.md",
    "references/choosing-a-form.md",
    "references/color-formula.md",
    "references/components.md",
    "references/interaction.md",
    "references/marks-and-anatomy.md",
    "references/palette.md",
    "scripts/validate_palette.js",
    "scripts/validate_palette.py",
  ].map((file) => ({ path: `skills/dataviz/${file}`, from: (bundle: Bundle) => skillFile(bundle, file) })),
  {
    path: "skills/artifact-design/scripts/markdown-template.html",
    from: (bundle) => only(bundle, "Markdown template", (_name, text) => text.startsWith("<!--\nname: plan\n"))[1],
  },
  { path: "skills/artifact-design/scripts/hljs-runtime.html", from: hljsRuntime },
  { path: "skills/artifact-design/scripts/hljs-languages.json", from: hljsLanguages },
  { path: "skills/artifact-design/scripts/mermaid-runtime.html", from: mermaidRuntime },
];

// ---------------------------------------------------------------- what the plugin ports with edits

/** Text the plugin ports with edits, found by a string its code or file holds. */
const PORTED: { what: string; anchor: string }[] = [
  { what: "the page contract and skill composition", anchor: "## Page contract" },
  { what: "the Artifact tool's description", anchor: "renders an HTML file as an Artifact" },
  { what: "the publish skeleton and runtimes", anchor: "body{margin:0;padding:0;font:14px" },
  { what: "the Markdown publish", anchor: "Markdown \\xB7 " },
  { what: "preview (ArtifactCheck)", anchor: "default-src 'self'" },
];

const MIN_LENGTH = 12;

function literalTexts(code: string): string[] {
  return literals(code)
    .map((lit) => lit.raw.join("${…}"))
    .filter((text) => text.length >= MIN_LENGTH && !/^(?:file:\/\/)?\/\$bunfs\//.test(text));
}

/** What `after` added and removed among the strings in `before`, as multisets. */
function changed(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const text of before) count.set(text, (count.get(text) ?? 0) + 1);
  const added: string[] = [];
  for (const text of after) {
    const left = count.get(text) ?? 0;
    if (left > 0) count.set(text, left - 1);
    else added.push(text);
  }
  const removed = [...count].flatMap(([text, left]) => Array<string>(left).fill(text));
  return { added, removed };
}

const allCode = new Map<Bundle, string>();

/** Whether the bundle's code anywhere holds this literal text, so that a string a build moved to
 * another file doesn't count as changed. */
function occurs(bundle: Bundle, text: string): boolean {
  let code = allCode.get(bundle);
  if (code === undefined) {
    code = [...bundle]
      .filter(([name]) => name.endsWith(".js"))
      .map(([, src]) => src)
      .join("\n");
    allCode.set(bundle, code);
  }
  return text.split("${…}").every((part) => code.includes(part));
}

function codeWith(bundle: Bundle, anchor: string): string {
  return [...bundle]
    .filter(([name, text]) => name.endsWith(".js") && text.includes(anchor))
    .map(([, text]) => text)
    .join("\n");
}

/** A line diff, unified-style without context, for files a few hundred lines long. */
function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let x = a.length - 1; x >= 0; x--)
    for (let y = b.length - 1; y >= 0; y--)
      lcs[x]![y] = a[x] === b[y] ? lcs[x + 1]![y + 1]! + 1 : Math.max(lcs[x + 1]![y]!, lcs[x]![y + 1]!);
  const out: string[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length || y < b.length) {
    if (x < a.length && y < b.length && a[x] === b[y]) {
      x++;
      y++;
    } else if (y < b.length && (x === a.length || lcs[x]![y + 1]! >= lcs[x + 1]![y]!)) out.push(`+ ${b[y++]}`);
    else out.push(`- ${a[x++]}`);
  }
  return out.join("\n");
}

/** Which of the plugin's own marked's regular expressions a bundle's code holds. Releases of marked
 * change some of them, so a different set means Claude Code bundles a different marked. */
function markedRegexes(bundle: Bundle): string[] {
  const marked = readFileSync(join(root, "node_modules", "marked", "lib", "marked.esm.js"), "utf8");
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "Literal" && n.regex) found.push(marked.slice(n.start, n.end));
    for (const key in n) if (key !== "type" && key !== "start" && key !== "end") visit(n[key]);
  };
  visit(parse(marked, { ecmaVersion: "latest", sourceType: "module" }));
  return [...new Set(found)].filter((regex) => occurs(bundle, regex));
}

// ---------------------------------------------------------------- the check

function main(): number {
  const args = process.argv.slice(2);
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const upstream = readFileSync(join(plugin, "UPSTREAM.md"), "utf8");
  const synced = option("--from") ?? /Claude Code (\d+\.\d+\.\d+)/.exec(upstream)?.[1];
  if (!synced) throw new Error("UPSTREAM.md names no Claude Code version");
  const target = option("--to") ?? run(["npm", "view", "@anthropic-ai/claude-code", "version"]);
  console.log(`Synced with Claude Code ${synced}; comparing with ${target}.`);

  const after = readBundle(fetchBinary(target));
  const before = target === synced ? after : readBundle(fetchBinary(synced));
  let drift = false;

  console.log("\nVerbatim copies:");
  for (const { path, from } of VERBATIM) {
    const file = join(plugin, path);
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const expected = from(after, current);
    if (current === expected) {
      console.log(`  same      ${path}`);
      continue;
    }
    drift = true;
    if (args.includes("--write")) writeFileSync(file, expected);
    console.log(`  ${args.includes("--write") ? "updated" : "differs"}   ${path}`);
  }

  console.log(`\nPorted text, ${synced} -> ${target}:`);
  const skill = (bundle: Bundle) =>
    only(
      bundle,
      "artifact-design SKILL.md",
      (name, text) => name.startsWith("SKILL-") && text.includes("## Read the request first"),
    )[1];
  const skillDiff = lineDiff(skill(before), skill(after));
  console.log(
    skillDiff
      ? `  artifact-design SKILL.md changed:\n${skillDiff.replace(/^/gm, "    ")}`
      : "  same      artifact-design SKILL.md",
  );
  drift ||= skillDiff !== "";
  // Anchors whose code is the same file are reported once, under all their names.
  const groups = new Map<string, { what: string[]; old: string; now: string; anchor: string }>();
  for (const { what, anchor } of PORTED) {
    const old = codeWith(before, anchor);
    const now = codeWith(after, anchor);
    const key = `${old.length}:${now.length}:${old.slice(0, 200)}`;
    const group = groups.get(key);
    if (group) group.what.push(what);
    else groups.set(key, { what: [what], old, now, anchor });
  }
  for (const { what: names, old, now, anchor } of groups.values()) {
    const what = names.join(", ");
    if (!old || !now) {
      console.log(`  missing   ${what}: no code holds ${JSON.stringify(anchor)} in ${old ? target : synced}`);
      drift = true;
      continue;
    }
    const diff = changed(literalTexts(old), literalTexts(now));
    const added = diff.added.filter((text) => !occurs(before, text));
    const removed = diff.removed.filter((text) => !occurs(after, text));
    if (!added.length && !removed.length) {
      console.log(`  same      ${what}`);
      continue;
    }
    drift = true;
    console.log(`  changed   ${what}:`);
    for (const text of removed) console.log(`    - ${JSON.stringify(text)}`);
    for (const text of added) console.log(`    + ${JSON.stringify(text)}`);
  }

  const markedBefore = markedRegexes(before);
  const markedAfter = markedRegexes(after);
  const markedSame = markedBefore.join("\n") === markedAfter.join("\n");
  const markedVersion = JSON.parse(readFileSync(join(root, "node_modules", "marked", "package.json"), "utf8")).version;
  console.log(
    markedSame
      ? "  same      the bundled marked"
      : `  changed   the bundled marked: compare it with marked ${markedVersion}`,
  );
  drift ||= !markedSame;

  if (!drift) console.log(`\nNothing to sync: the plugin matches Claude Code ${target}.`);
  else
    console.log(
      `\nTo sync: commit the verbatim copies (--write), port the ported-text changes as AGENTS.md describes, ` +
        `then set the version in UPSTREAM.md and README.md to ${target}.`,
    );
  return drift ? 1 : 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`drift check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
