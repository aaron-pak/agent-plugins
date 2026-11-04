// The store on disk: Claude Code's project keys and folder layout, paths the tools accept, content
// as memory_write saves it, and the index as a session loads it.

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { type Env, MemoryConfig, memoryRoot } from "../src/config.ts";
import { claudeCodeCheck, inClaudeCode, run } from "../src/hook.ts";
import { indexBlock, section, sessionContext, truncateIndex } from "../src/prompt.ts";
import { secretsIn } from "../src/secrets.ts";
import { Store, clean, pathProblem, sanitize, version } from "../src/store.ts";

const TEMP = realpathSync(mkdtempSync(join(tmpdir(), "auto-memory-store-")));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

/** Run an effect with the store, the config for `env` and Node's services. */
const run_ = <A, E>(
  effect: Effect.Effect<A, E, Store | MemoryConfig | NodeServices.NodeServices>,
  env: Env = { AGENT_MEMORY_DIR: "/root" },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Store.layer.pipe(Layer.provideMerge(MemoryConfig.layerWith(env)), Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
const store = <A, E>(use: (store: Store["Service"]) => Effect.Effect<A, E>) => run_(Store.use(use));
/** The message of the error an operation fails with. */
const failure = <A>(use: (store: Store["Service"]) => Effect.Effect<A, { message: string }>) =>
  store((s) =>
    use(s).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};

describe("project keys", () => {
  test("sanitize turns everything but letters and digits into dashes, as Claude Code does", () => {
    expect(sanitize("/Users/aaronpak/projects/pak-tools")).toBe("-Users-aaronpak-projects-pak-tools");
    expect(sanitize("C:\\Users\\a b\\x.y")).toBe("C--Users-a-b-x-y");
  });

  test("a key past 200 characters is cut and given Claude Code's hash", () => {
    const long = `/${"a".repeat(250)}`;
    const key = sanitize(long);
    expect(key.slice(0, 200)).toBe(`-${"a".repeat(199)}`);
    // Claude Code 2.1.318's own result for this path.
    let h = 0;
    for (const c of long) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    expect(key).toBe(`${key.slice(0, 200)}-${Math.abs(h).toString(36)}`);
  });

  test("a repository's subfolders, symlinks and worktrees share the main tree's memory", async () => {
    const main = join(TEMP, "main");
    mkdirSync(join(main, "sub"), { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(TEMP, "wt"));
    symlinkSync(main, join(TEMP, "link"));
    for (const cwd of [main, join(main, "sub"), join(TEMP, "wt"), join(TEMP, "link")])
      expect(await store((s) => s.dirFor(cwd))).toBe(`/root/projects/${sanitize(main)}/memory/`);
  });

  test("a worktree of a bare repository belongs to the bare repository, as in Claude Code", async () => {
    const bare = join(TEMP, "repo.git");
    git(TEMP, "init", "-q", "--bare", bare);
    const seed = join(TEMP, "seed");
    git(TEMP, "clone", "-q", bare, seed);
    git(seed, "commit", "-q", "--allow-empty", "-m", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    git(bare, "worktree", "add", "-q", join(TEMP, "bare-wt"), "main");
    // Claude Code 2.1.318 keys this worktree by the bare repository's folder.
    expect(await store((s) => s.dirFor(join(TEMP, "bare-wt")))).toBe(`/root/projects/${sanitize(bare)}/memory/`);
  });

  test("a folder outside a repository is its own project", async () => {
    const plain = join(TEMP, "plain");
    mkdirSync(plain);
    expect(await store((s) => s.dirFor(plain))).toBe(`/root/projects/${sanitize(plain)}/memory/`);
  });

  test("the store's root is AGENT_MEMORY_DIR, else ~/.agents/memory", () => {
    expect(memoryRoot({}, "/home/a")).toBe("/home/a/.agents/memory");
    expect(memoryRoot({ AGENT_MEMORY_DIR: "~/m" }, "/home/a")).toBe("/home/a/m");
    expect(memoryRoot({ AGENT_MEMORY_DIR: "m" }, "/home/a")).toBe("/home/a/m");
    expect(memoryRoot({ AGENT_MEMORY_DIR: " /x/y " }, "/home/a")).toBe("/x/y");
  });
});

describe("documents", () => {
  const dir = join(TEMP, "docs") + "/";

  test("paths: absolute, a known extension, no dot folders, no reserved first folder for writes", () => {
    expect(pathProblem("/a/b.md")).toBeNull();
    expect(pathProblem("/notes.jsonl")).toBeNull();
    expect(pathProblem("a.md")).toContain('use "/a.md"');
    for (const bad of ["/a.png", "/.hidden/a.md", "/a/../b.md", "/a//b.md", "/a\\b.md", "/a\u2028.md", "/"])
      expect(pathProblem(bad)).not.toBeNull();
    expect(pathProblem("/skills/x.md", { forWrite: true })).toContain("reserved names");
    expect(pathProblem("/notes/Hooks./x.md", { forWrite: true })).toContain("reserved names");
    expect(pathProblem("/config/x.md", { forWrite: true })).toContain("reserved names");
    expect(pathProblem("/skills/x.md")).toBeNull();
    expect(pathProblem("/skills.md", { forWrite: true })).toBeNull();
    expect(pathProblem("/", { forList: true })).toBeNull();
    expect(pathProblem("/feedback/", { forList: true })).toBeNull();
  });

  test("content is saved with LF endings, format characters dropped and controls replaced", () => {
    expect(clean("a\r\nb\rc\u2028d")).toBe("a\nb\nc\nd");
    expect(clean("x\u200by\u00adz")).toBe("xyz");
    expect(clean("t\tn\nbell\u0007")).toBe("t\tn\nbell\ufffd");
  });

  test("write, read and list round trip, sorted, skipping dot files and other extensions", async () => {
    await store((s) => s.write(dir, "/MEMORY.md", "- [A](a.md) — a\n"));
    await store((s) => s.write(dir, "/feedback/b.md", "b"));
    writeFileSync(join(dir, ".hidden.md"), "h");
    writeFileSync(join(dir, "image.png"), "p");
    expect((await store((s) => s.read(dir, "/MEMORY.md")))?.content).toBe("- [A](a.md) — a\n");
    expect((await store((s) => s.read(dir, "/MEMORY.md")))?.bytes).toBe(Buffer.byteLength("- [A](a.md) — a\n"));
    expect(await store((s) => s.read(dir, "/missing.md"))).toBeNull();
    expect((await store((s) => s.list(dir))).map((entry) => entry.path)).toEqual(["/MEMORY.md", "/feedback/b.md"]);
    expect((await store((s) => s.list(dir, "/feedback/"))).map((entry) => entry.path)).toEqual(["/feedback/b.md"]);
    expect(version("b")).toMatch(/^[0-9a-f]{12}$/);
  });

  test("a symlink can't lead a read or write outside the store", async () => {
    const outside = join(TEMP, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "s");
    symlinkSync(outside, join(dir, "escape"));
    expect(await failure((s) => s.read(dir, "/escape/secret.md"))).toContain("leads outside the memory store");
    expect(await failure((s) => s.write(dir, "/escape/new.md", "x"))).toContain("leads outside the memory store");
  });

  test("a symlink to a folder above the store can't lead a write or listing out of it", async () => {
    symlinkSync(TEMP, join(dir, "up"));
    expect(await failure((s) => s.write(dir, "/up/escaped/x.md", "x"))).toContain("leads outside the memory store");
    expect(await failure((s) => s.list(dir, "/up/"))).toContain("leads outside the memory store");
  });

  test("a store that doesn't exist yet is made by its first write", async () => {
    const fresh = join(TEMP, "fresh", "store") + "/";
    expect(await store((s) => s.read(fresh, "/MEMORY.md"))).toBeNull();
    await store((s) => s.write(fresh, "/MEMORY.md", "x"));
    expect((await store((s) => s.read(fresh, "/MEMORY.md")))?.content).toBe("x");
  });

  test("secrets are recognized by their shapes", () => {
    expect(secretsIn(`token ghp_${"a".repeat(36)}`)).toEqual(["github-pat"]);
    expect(secretsIn("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private-key"]);
    expect(secretsIn("Aaron prefers short replies")).toEqual([]);
  });
});

describe("the session's start", () => {
  test("the section names the folder and the memory_write tool, not Claude Code's Write tool", () => {
    const text = section("/m/projects/-p/memory/");
    expect(text.startsWith("# Memory\n\nYou have a persistent file-based memory at `/m/projects/-p/memory/`.")).toBe(
      true,
    );
    expect(text).toContain("with the memory_write tool, as the store `personal`");
    expect(text).not.toContain("Write tool");
    expect(text).not.toContain("system-reminder");
  });

  test("the index follows the section, as Claude Code loads it, and an empty one is left out", () => {
    const dir = "/m/projects/-p/memory/";
    expect(sessionContext(dir, null)).toBe(section(dir));
    expect(indexBlock(dir, "  \n")).toBeNull();
    expect(sessionContext(dir, "- [A](a.md) — a\n")).toBe(
      `${section(dir)}\n\nContents of ${dir}MEMORY.md (user's auto-memory, persists across conversations):\n\n- [A](a.md) — a`,
    );
  });

  test("an index past 200 lines is cut with Claude Code's warning", () => {
    const lines = Array.from({ length: 210 }, (_, i) => `- line ${i + 1}`).join("\n");
    const out = truncateIndex(lines);
    expect(out.split("\n").slice(0, 200).at(-1)).toBe("- line 200");
    expect(
      out.endsWith(
        '> WARNING: MEMORY.md is 210 lines (limit: 200). Only part of it was loaded: 10 of 210 lines were cut off, starting at line 201 ("- line 201"). Keep index entries to one line under ~200 chars; move detail into topic files.',
      ),
    ).toBe(true);
  });

  test("an index past 25,000 bytes is cut at a line break", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `- ${i} ${"x".repeat(300)}`).join("\n");
    const out = truncateIndex(lines);
    expect(out.slice(out.indexOf("> WARNING"), out.indexOf(" Only part"))).toBe(
      "> WARNING: MEMORY.md is 29.9KB (limit: 24.4KB) — index entries are too long.",
    );
    expect(out.split("\n\n> WARNING")[0]!.length).toBeLessThanOrEqual(25000);
  });

  test("the size limit counts characters, as Claude Code's does, so em dashes don't trip it", () => {
    const lines = Array.from({ length: 160 }, (_, i) => `- [Memory ${i}](m${i}.md) — ${"é".repeat(120)}`).join("\n");
    expect(Buffer.byteLength(lines)).toBeGreaterThan(25000);
    expect(lines.length).toBeLessThan(25000);
    expect(truncateIndex(lines)).toBe(lines);
  });
});

describe("the hook", () => {
  test("Codex gets the section and index for the session's folder", async () => {
    const cwd = join(TEMP, "plain");
    const env = { PLUGIN_ROOT: "/p", AGENT_MEMORY_DIR: join(TEMP, "hookstore") };
    const dir = await run_(
      Store.use((s) => s.dirFor(cwd)),
      env,
    );
    const out = await run_(run(JSON.stringify({ cwd })), env);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: section(dir) } });
    writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md) — a\n");
    const again = await run_(run(JSON.stringify({ cwd })), env);
    expect(again).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: sessionContext(dir, "- [A](a.md) — a\n"),
      },
    });
  });

  test("Claude Code is told when its auto memory isn't in the shared store, and nothing when it is", async () => {
    expect(inClaudeCode({ CLAUDE_PLUGIN_ROOT: "/p" })).toBe(true);
    expect(inClaudeCode({ CLAUDECODE: "1", PLUGIN_ROOT: "/p" })).toBe(false);
    // Codex sets both.
    expect(inClaudeCode({ CLAUDE_PLUGIN_ROOT: "/p", PLUGIN_ROOT: "/p" })).toBe(false);
    const env = { CLAUDE_PLUGIN_ROOT: "/p", AGENT_MEMORY_DIR: "/s" };
    expect(await run_(run("{}"), env)).toEqual(claudeCodeCheck(env, "/s"));
    expect(claudeCodeCheck(env, "/s")?.systemMessage).toContain('"CLAUDE_CODE_REMOTE_MEMORY_DIR": "/s"');
    expect(claudeCodeCheck({ ...env, CLAUDE_CODE_REMOTE_MEMORY_DIR: "/s/" }, "/s")).toBeNull();
    // Claude Code expands no ~, so this would put its memory under each session's folder.
    const home = memoryRoot({}, homedir());
    expect(claudeCodeCheck({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "~/.agents/memory" }, home)?.systemMessage).toContain(
      "it expands no ~",
    );
    expect(claudeCodeCheck({ CLAUDE_CODE_REMOTE_MEMORY_DIR: join(homedir(), ".agents", "memory") }, home)).toBeNull();
  });
});
