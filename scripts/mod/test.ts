// `bun run mod test <dir>`: a mod's tests, split so they finish sooner, or only the ones you name.
//
// `claude plugin test` runs each test file in a child of its own, one after another within a file,
// so a mod whose tests sit in one big file waits on that file. This runs the same command on a
// copy of the mod whose test files are cut into shards (runs of neighbouring tests, each a file of
// its own), balanced by how long each test took last time, and with --grep keeps only the tests
// whose names match.
//
// The cut is made where a test file imports the kit: the copy's files import a small module in
// place of 'claude-code/testing' that re-exports the kit with `test` and `describe` wrapped, and a
// shard's wrapper registers only the tests given to it. A first, quick run lists each file's tests
// (kept with the file's hash, so it is skipped while the file is unchanged). A test file that
// imports `test` some other way runs whole.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { copyMod, cpus, modName, root, seconds, stream, testFiles } from "./common.ts";

export type TestOptions = {
  /** Only the tests whose names (with their describes', joined by " > ") match. */
  grep?: RegExp;
  /** How many shards to aim for across all files; the cores by default. 1 runs the files as they are. */
  shards?: number;
};

type Cache = Record<string, { hash: string; names: string[]; ms: Record<string, number> }>;

const KIT = /(\bimport\s+(?!type\b)[^;]*?\bfrom\s*)(["'])claude-code\/testing\2/g;

function cachePath(name: string): string {
  return join(root, "node_modules", ".cache", "mod-test", `${name}.json`);
}

function readCache(name: string): Cache {
  try {
    return JSON.parse(readFileSync(cachePath(name), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function writeCache(name: string, cache: Cache): void {
  mkdirSync(dirname(cachePath(name)), { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify(cache, null, 1));
}

const WRAP = `
import { describe as kitDescribe, test as kitTest } from "claude-code/testing";
export * from "claude-code/testing";
const within: string[] = [];
let index = 0;
`;

/** The kit module a file imports while its tests are listed: it registers one test, which prints them. */
function listingKit(id: number): string {
  return `${WRAP}
const names: string[] = [];
kitTest("(listing the tests)", () => {
  console.log("@@MODLIST " + JSON.stringify([${id}, names]));
});
export const test = (name: string, ..._rest: unknown[]): void => {
  names.push([...within, name].join(" > "));
  index++;
};
export const describe = (name: string, body: () => void): void => {
  within.push(name);
  try {
    body();
  } finally {
    within.pop();
  }
};
`;
}

/** The kit module one shard imports: it registers the tests at `keep` and times each. */
function shardKit(rel: string, keep: number[]): string {
  return `${WRAP}
const keep = new Set(${JSON.stringify(keep)});
export const test = (name: string, ...rest: any[]): void => {
  const full = [...within, name].join(" > ");
  if (!keep.has(index++)) return;
  const body = rest[rest.length - 1];
  const timed = async (...args: any[]) => {
    const start = Date.now();
    try {
      return await body(...args);
    } finally {
      console.log("@@MODTIME " + JSON.stringify([${JSON.stringify(rel)}, full, Date.now() - start]));
    }
  };
  if (rest.length > 1) kitTest(name, rest[0], timed);
  else kitTest(name, timed);
};
export const describe = (name: string, body: () => void): void => {
  within.push(name);
  try {
    kitDescribe(name, body);
  } finally {
    within.pop();
  }
};
`;
}

/**
 * Cuts a file's tests into runs of neighbours of about equal time. Runs keep the file's order, so a
 * test that leans on the one before it (a module-level value it left behind) stays beside it unless
 * a cut falls between them, and a cut never falls before a test named as a later part ("(2 of 2)").
 */
function partition(items: { test: string; index: number; ms: number }[], bins: number): number[][] {
  const total = items.reduce((sum, item) => sum + item.ms, 0);
  const runs: number[][] = [[]];
  let done = 0;
  for (const item of items) {
    const run = runs.at(-1)!;
    const due = (total * runs.length) / bins;
    const continues = /\((?:[2-9]|\d\d+) of \d+\)/.test(item.test);
    if (run.length > 0 && runs.length < bins && done >= due - item.ms / 2 && !continues) runs.push([item.index]);
    else run.push(item.index);
    done += item.ms;
  }
  return runs;
}

/** A line of JSON a test printed, or undefined where another child's output cut into it. */
function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Runs the mod's tests and resolves to the exit code `claude plugin test` gave. */
export async function testMod(dir: string, options: TestOptions = {}): Promise<number> {
  const name = modName(dir);
  const target = Math.max(1, options.shards ?? cpus());
  const started = performance.now();
  if (target === 1 && options.grep === undefined) {
    return await stream(["claude", "plugin", "test", "."], dir, (line) => console.log(line));
  }

  const copy = copyMod(dir);
  try {
    const files = testFiles(copy.path).map((path) => {
      const source = readFileSync(path, "utf8");
      const rel = relative(copy.path, path);
      return {
        path,
        rel,
        source,
        hash: createHash("sha256").update(source).digest("hex"),
        splittable: source.search(KIT) !== -1,
      };
    });
    const cache = readCache(name);

    // List the tests of each file that changed since its tests were last listed.
    const unlisted = files.filter((file) => file.splittable && cache[file.rel]?.hash !== file.hash);
    if (unlisted.length > 0) {
      for (const file of files) rmSync(file.path);
      unlisted.forEach((file, id) => {
        const kit = `__mod_kit_${id}.ts`;
        writeFileSync(join(dirname(file.path), kit), listingKit(id));
        writeFileSync(file.path, file.source.replace(KIT, `$1"./${kit}"`));
      });
      const output: string[] = [];
      await stream(["claude", "plugin", "test", "."], copy.path, (line) => {
        const listed = /^@@MODLIST (.*)$/.exec(line);
        if (listed === null) {
          output.push(line);
          return;
        }
        const parsed = parse<[number, string[]]>(listed[1]!);
        const file = parsed === undefined ? undefined : unlisted[parsed[0]];
        if (parsed !== undefined && file !== undefined) {
          cache[file.rel] = { hash: file.hash, names: parsed[1], ms: cache[file.rel]?.ms ?? {} };
        }
      });
      for (const file of unlisted) {
        if (cache[file.rel]?.hash !== file.hash) {
          console.log(output.join("\n"));
          console.log(`(${file.rel} did not list its tests: it runs whole)`);
          file.splittable = false;
        }
      }
      for (const file of files) rmSync(file.path, { force: true });
      for (const id of unlisted.keys())
        rmSync(join(dirname(unlisted[id]!.path), `__mod_kit_${id}.ts`), { force: true });
    }

    // Weigh each kept test by its last time (an unknown one by the median of the known), then split.
    const known = Object.values(cache)
      .flatMap((entry) => Object.values(entry.ms))
      .sort((a, b) => a - b);
    const typical = known[Math.floor(known.length / 2)] ?? 1000;
    const plan = files.map((file) => {
      if (!file.splittable) return { file, items: null };
      const entry = cache[file.rel]!;
      const items = entry.names
        .map((test, index) => ({ test, index, ms: entry.ms[test] ?? typical }))
        .filter((item) => options.grep === undefined || options.grep.test(item.test));
      return { file, items };
    });
    const total = plan.reduce((sum, { items }) => sum + (items?.reduce((s, item) => s + item.ms, 0) ?? 0), 0);
    let shards = 0;
    let tests = 0;
    for (const { file, items } of plan) {
      rmSync(file.path, { force: true });
      if (items === null) {
        if (options.grep !== undefined) console.log(`(${file.rel} runs whole: --grep cannot reach into it)`);
        writeFileSync(file.path, file.source);
        shards++;
        continue;
      }
      if (items.length === 0) continue;
      const weight = items.reduce((sum, item) => sum + item.ms, 0);
      const bins = Math.min(items.length, Math.max(1, Math.ceil((target * weight) / Math.max(total, 1))));
      partition(items, bins).forEach((keep, n) => {
        const base = basename(file.path).replace(/\.test\.(tsx?)$/, "");
        const kit = `__mod_kit_${base}_${n}.ts`;
        writeFileSync(join(dirname(file.path), kit), shardKit(file.rel, keep));
        const ext = file.path.endsWith(".tsx") ? "tsx" : "ts";
        writeFileSync(join(dirname(file.path), `${base}.${n}.test.${ext}`), file.source.replace(KIT, `$1"./${kit}"`));
        shards++;
        tests += keep.length;
      });
    }
    if (shards === 0) {
      console.log(`No test of ${name} matches ${options.grep}.`);
      return 1;
    }
    const matched = options.grep === undefined ? "" : `, matching ${options.grep}`;
    console.log(`${name}: ${tests} tests${matched}, in ${shards} files run side by side on ${cpus()} cores`);

    const code = await stream(["claude", "plugin", "test", "."], copy.path, (line) => {
      const timed = /^@@MODTIME (.*)$/.exec(line);
      if (timed !== null) {
        const [rel, test, ms] = parse<[string, string, number]>(timed[1]!) ?? [];
        const entry = rel === undefined ? undefined : cache[rel];
        if (entry !== undefined && test !== undefined && ms !== undefined) entry.ms[test] = ms;
        return;
      }
      // A shard's heading names the file it came from.
      console.log(line.replace(/^(\S.*?)\.(\d+)\.test\.(tsx?):$/, "$1.test.$3 (shard $2):"));
    });
    writeCache(name, cache);
    console.log(`Took ${seconds(started)}.`);
    return code;
  } finally {
    copy.dispose();
  }
}
