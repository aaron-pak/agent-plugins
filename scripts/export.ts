// Publish the public part of pak-tools to pak-plugins, one commit at a time.
//
//   bun scripts/export.ts build <dir> [rev]   write the public tree of rev (default HEAD) into <dir>
//   bun scripts/export.ts publish <checkout>  add a pak-plugins commit for each pak-tools commit on
//                                             the first-parent line since the last one exported
//
// Only the paths in PUBLIC_PATHS leave this repository, and public/<file> lands at the root of
// pak-plugins. Each exported commit keeps its author, date and message, and ends with an
// Exported-from trailer, which is how the next run knows where to start. Before a tree or message is
// written, the leak check refuses one whose paths or text name a private plugin or tool, or a line
// of private/DENYLIST, as of that commit or of HEAD. An older commit that would leak is skipped (a
// later commit carries its public changes); HEAD that would leak stops the export. Author emails
// other than PUBLIC_EMAILS are published as Aaron's GitHub noreply address.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SOURCE = "aaron-pak/pak-tools";
const TRAILER = "Exported-from";

// Top-level files and folders that are public as they are. Everything else stays private.
const PUBLIC_PATHS = [
  "plugins",
  "instructions",
  "scripts",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".oxlintrc.json",
  ".gitattributes",
  ".gitignore",
];
// public/<path> is published at <path>: the public catalogs, README and pak-plugins' own CI.
const PUBLIC_DIR = "public";

// Emails that may appear in pak-plugins' history. Any other, as an author or in a message, is
// replaced with NOREPLY, which still counts toward Aaron's GitHub contributions.
const PUBLIC_EMAILS = ["aaron@aaronpak.dev", "noreply@anthropic.com"];
const NOREPLY = "188939524+aaron-pak@users.noreply.github.com";

class LeakError extends Error {}

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout;
}

/** Every file under dir, as paths relative to it. Symlinks are listed in links. */
function walk(dir: string, base = dir, links: string[] = []): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) links.push(relative(base, path));
    else if (entry.isDirectory()) files.push(...walk(path, base, links));
    else files.push(relative(base, path));
  }
  return files;
}

/** The private folder names and DENYLIST lines at rev: text that must never be published. */
function privateNamesAt(rev: string): string[] {
  const names = new Set<string>();
  for (const folder of ["private/plugins", "private/tools"]) {
    const list = spawnSync("git", ["ls-tree", "-d", "--name-only", `${rev}:${folder}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (list.status === 0) for (const name of list.stdout.split("\n")) if (name) names.add(name);
  }
  const denylist = spawnSync("git", ["show", `${rev}:private/DENYLIST`], { cwd: root, encoding: "utf8" });
  if (denylist.status === 0) {
    for (const line of denylist.stdout.split("\n")) {
      const value = line.trim();
      if (value && !value.startsWith("#")) names.add(value);
    }
  }
  return [...names];
}

function namesFor(rev: string): string[] {
  return [...new Set([...privateNamesAt(rev), ...privateNamesAt("HEAD")])];
}

function findLeaks(text: string, names: string[]): string[] {
  const lower = text.toLowerCase();
  return names.filter((name) => lower.includes(name.toLowerCase()));
}

const isPublicEmail = (email: string) =>
  PUBLIC_EMAILS.includes(email.toLowerCase()) || email.toLowerCase().endsWith("@users.noreply.github.com");

/** Extract rev into a temp folder, then copy its public paths into out. Throws LeakError on a leak. */
export function build(out: string, rev = "HEAD"): void {
  const full = mkdtempSync(join(tmpdir(), "pak-export-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", rev], { cwd: root, maxBuffer: 1 << 30 });
    if (archive.status !== 0) throw new Error(`git archive ${rev} failed:\n${archive.stderr.toString()}`);
    const untar = spawnSync("tar", ["-x", "-C", full], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar failed:\n${untar.stderr.toString()}`);

    mkdirSync(out, { recursive: true });
    const copy = { recursive: true, preserveTimestamps: true, verbatimSymlinks: true };
    for (const path of PUBLIC_PATHS) {
      const from = join(full, path);
      if (existsSync(from)) cpSync(from, join(out, path), copy);
    }
    const publicDir = join(full, PUBLIC_DIR);
    if (existsSync(publicDir)) cpSync(publicDir, out, copy);

    const names = namesFor(rev);
    const leaks: string[] = [];
    const links: string[] = [];
    for (const file of walk(out, out, links)) {
      if (file.startsWith("private/")) leaks.push(`${file}: a private path`);
      for (const name of findLeaks(file, names)) leaks.push(`${file}: its path names ${JSON.stringify(name)}`);
      const bytes = readFileSync(join(out, file));
      if (bytes.includes(0)) continue; // binary
      for (const name of findLeaks(bytes.toString("utf8"), names)) leaks.push(`${file}: names ${JSON.stringify(name)}`);
    }
    for (const link of links) leaks.push(`${link}: a symlink, which the export doesn't publish`);
    if (leaks.length) throw new LeakError(`The public tree of ${rev} would leak:\n  ${leaks.join("\n  ")}`);
  } finally {
    rmSync(full, { recursive: true, force: true });
  }
}

/** The pak-tools commit pak-plugins was last exported from. */
function lastExported(target: string): string {
  const [hash, trailers] = git(target, [
    "log",
    "-1",
    `--grep=^${TRAILER}:`,
    `--format=%H%x00%(trailers:key=${TRAILER},valueonly)`,
  ]).split("\0");
  const value = trailers?.trim().split("\n").pop();
  const head = git(target, ["rev-parse", "HEAD"]).trim();
  if (hash && value) {
    if (hash.trim() !== head) {
      const foreign = git(target, ["log", "--oneline", `${hash.trim()}..HEAD`]).trim();
      throw new Error(
        `pak-plugins has commits that didn't come from pak-tools since its last export:\n${foreign}\n` +
          `Make the same changes in pak-tools, then reset pak-plugins main to ${hash.trim()} and run the export again.`,
      );
    }
    return value.split("@").pop()!;
  }
  // Before the first export, pak-plugins' head is a commit pak-tools started from.
  const known = spawnSync("git", ["merge-base", "--is-ancestor", head, "HEAD"], { cwd: root });
  if (known.status === 0) return head;
  throw new Error(`pak-plugins has no ${TRAILER} trailer and its head ${head} is not in pak-tools' history`);
}

function replaceTree(target: string, tree: string) {
  for (const file of git(target, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    rmSync(join(target, file), { force: true });
  }
  const files = walk(tree);
  for (const file of files) {
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(tree, file), to);
    chmodSync(to, statSync(join(tree, file)).mode);
  }
  // -f: every file here is tracked in pak-tools, even one the exported .gitignore matches.
  git(target, ["add", "-A", "-f"]);
  const staged = git(target, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  if (staged.join("\n") !== files.sort().join("\n"))
    throw new Error("pak-plugins' index doesn't match the public tree");
}

function publicMessage(message: string, names: string[]): string {
  if (findLeaks(message, names).length) return "Update from pak-tools";
  return (
    message
      // "#12" would link to pak-plugins' own pull request 12.
      .replace(/(^|[\s(])#(\d+)\b/g, `$1${SOURCE}#$2`)
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (email) => (isPublicEmail(email) ? email : NOREPLY))
  );
}

export function publish(target: string) {
  const since = lastExported(target);
  const commits = git(root, ["rev-list", "--reverse", "--first-parent", `${since}..HEAD`])
    .split("\n")
    .filter(Boolean);
  console.log(`${commits.length} commit(s) since ${since.slice(0, 7)}`);
  let exported = 0;
  for (const sha of commits) {
    const tree = mkdtempSync(join(tmpdir(), "pak-tree-"));
    try {
      try {
        build(tree, sha);
      } catch (error) {
        if (!(error instanceof LeakError) || sha === commits.at(-1)) throw error;
        console.log(`  ${sha.slice(0, 7)} skipped, its tree would leak; a later commit carries its public changes`);
        continue;
      }
      replaceTree(target, tree);
      if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: target }).status === 0) {
        console.log(`  ${sha.slice(0, 7)} changes nothing public`);
        continue;
      }
      const [name, email, date] = git(root, ["log", "-1", "--format=%an%x00%ae%x00%aI", sha]).trim().split("\0");
      const body = git(root, ["log", "-1", "--format=%B", sha]).trimEnd();
      const message = `${publicMessage(body, namesFor(sha))}\n\n${TRAILER}: ${SOURCE}@${sha}\n`;
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email && isPublicEmail(email) ? email : NOREPLY,
        GIT_AUTHOR_DATE: date,
      };
      const commit = spawnSync("git", ["commit", "-q", "-F", "-"], {
        cwd: target,
        input: message,
        env,
        encoding: "utf8",
      });
      if (commit.status !== 0) throw new Error(`git commit failed:\n${commit.stderr}`);
      exported++;
      console.log(`  ${sha.slice(0, 7)} exported`);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
  console.log(`${exported} commit(s) exported`);
}

if (import.meta.main) {
  const [command, path, rev] = process.argv.slice(2);
  if (command === "build" && path) {
    build(resolve(path), rev);
    console.log(`Wrote the public tree of ${rev ?? "HEAD"} to ${path}`);
  } else if (command === "publish" && path) {
    publish(resolve(path));
  } else {
    console.error("usage: bun scripts/export.ts build <dir> [rev] | publish <pak-plugins checkout>");
    process.exit(2);
  }
}
