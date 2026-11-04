// The bundled memory server as Codex starts it, `node mcp/server.mjs` over stdio, and the tools'
// results in Claude Code's words: versions, conflicts, caps, paging and refused secrets.

import { NodeServices } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { MemoryConfig } from "../src/config.ts";
import { Memory } from "../src/memory.ts";
import { withSandboxState } from "../src/server.ts";
import { Store, sanitize, version } from "../src/store.ts";
import { TOOLS, sessionFolder } from "../src/tools.ts";

const SERVER = join(import.meta.dirname, "..", "mcp", "server.mjs");
const TEMP = realpathSync(mkdtempSync(join(tmpdir(), "auto-memory-server-")));
const ROOT = join(TEMP, "store");
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const project = join(TEMP, "project");
mkdirSync(project);
const projectDir = `${ROOT}/projects/${sanitize(project)}/memory/`;
const Services = Memory.layer.pipe(
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(MemoryConfig.layerWith({ AGENT_MEMORY_DIR: ROOT, PWD: project })),
  Layer.provideMerge(NodeServices.layer),
);
// One server's services, shared by every call, as one server process holds them.
const runtime = ManagedRuntime.make(Services);
afterAll(() => runtime.dispose());
/** A tool call in `project`, which the server's PWD names, as its text and whether it is an error. */
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await runtime.runPromise(Memory.use((memory) => memory.call(name, args, undefined)));
  return { text: (result.content[0] as { text: string }).text, error: result.isError === true };
};

describe("the tools", () => {
  test("memory_list with no store lists the one store, with its folder", async () => {
    const { text } = await call("memory_list", {});
    expect(text).toContain("personal  (this project's auto memory, shared with Claude Code, in ");
    expect(text).toContain(`${projectDir}, writable, index /MEMORY.md)`);
  });

  test("a document is created with new, then updated with the version its write returned", async () => {
    const created = await call("memory_write", { store: "personal", path: "/a.md", content: "one", if_version: "new" });
    expect(created).toEqual({
      text: `Wrote 3 bytes. [version: ${version("one")}] (pass as if_version on your next memory_write to this path)`,
      error: false,
    });
    const read = await call("memory_read", { store: "personal", path: "/a.md" });
    expect(read.text).toMatch(
      /^The following is personal-store content .*\n\[updated: \d{4}-\d{2}-\d{2}\] \[version: [0-9a-f]{12}\]/,
    );
    expect(read.text.endsWith("\none")).toBe(true);
    expect(
      (await call("memory_write", { store: "personal", path: "/a.md", content: "two", if_version: version("one") }))
        .error,
    ).toBe(false);
  });

  test("a stale or missing version is refused with the current content to merge into", async () => {
    const stale = await call("memory_write", {
      store: "personal",
      path: "/a.md",
      content: "three",
      if_version: version("one"),
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toContain(`if_version ${version("one")} is stale; current version ${version("two")}`);
    expect(stale.text.endsWith("---\ntwo")).toBe(true);
    expect(
      (await call("memory_write", { store: "personal", path: "/a.md", content: "x", if_version: "new" })).text,
    ).toContain("already exists");
    expect(
      (await call("memory_write", { store: "personal", path: "/b.md", content: "x", if_version: version("x") })).text,
    ).toContain("Pass if_version=new");
    expect(
      (await call("memory_write", { store: "personal", path: "/b.md", content: "x", if_version: "latest" })).text,
    ).toContain("is not a version token");
  });

  test("other stores, bad paths, empty content, oversize content and secrets are refused", async () => {
    expect((await call("memory_read", { store: "team", path: "/a.md" })).text).toContain('no memory store "team"');
    expect((await call("memory_read", { store: "personal", path: "/missing.md" })).text).toBe(
      "memory_read failed: not found",
    );
    expect(
      (await call("memory_write", { store: "personal", path: "/hooks/x.md", content: "x", if_version: "new" })).error,
    ).toBe(true);
    expect(
      (await call("memory_write", { store: "personal", path: "/c.md", content: " \n", if_version: "new" })).text,
    ).toContain("Empty");
    expect(
      (await call("memory_write", { store: "personal", path: "/c.md", content: "x".repeat(102401), if_version: "new" }))
        .text,
    ).toContain("capped at 102400 bytes");
    const secret = await call("memory_write", {
      store: "personal",
      path: "/c.md",
      content: `key AKIA${"A".repeat(16)}`,
      if_version: "new",
    });
    expect(secret.text).toContain("potential secrets (aws-access-token)");
  });

  test("calls that arrive together take turns, in the order they came", async () => {
    const write = () =>
      call("memory_write", { store: "personal", path: "/race.md", content: "race", if_version: "new" });
    const results = await Promise.all([write(), write(), write()]);
    expect(results.filter((result) => !result.error)).toHaveLength(1);
    for (const result of results.filter((result) => result.error)) expect(result.text).toContain("already exists");
    const [written, read] = await Promise.all([
      call("memory_write", { store: "personal", path: "/order.md", content: "first", if_version: "new" }),
      call("memory_read", { store: "personal", path: "/order.md" }),
    ]);
    expect(written.error).toBe(false);
    expect(read.text.endsWith("\nfirst")).toBe(true);
  });

  test("a file saved with a byte order mark keeps it, as Claude Code reads it", async () => {
    writeFileSync(join(projectDir, "bom.md"), "\ufeffhello");
    const read = await call("memory_read", { store: "personal", path: "/bom.md" });
    expect(read.text).toContain(`[version: ${version("\ufeffhello")}]`);
  });

  test("memory_list pages 50 at a time with a cursor", async () => {
    for (let i = 0; i < 55; i++)
      await call("memory_write", {
        store: "personal",
        path: `/many/${String(i).padStart(2, "0")}.md`,
        content: "m",
        if_version: "new",
      });
    const first = await call("memory_list", { store: "personal", path_prefix: "/many" });
    expect(first.text).toContain('… 5 more — call again with cursor="/many/49.md" to continue.');
    const second = await call("memory_list", { store: "personal", path_prefix: "/many/", cursor: "/many/49.md" });
    expect(second.text.split("\n").filter((line) => line.startsWith('"'))).toHaveLength(5);
  });

  test("the session's folder is the workspace Codex names for the turn", () => {
    expect(sessionFolder({ "x-codex-turn-metadata": { workspaces: { "/w/repo": {} } } }, null)).toBe("/w/repo");
    expect(sessionFolder(undefined, "/started")).toBe("/started");
    expect(sessionFolder({ "codex/sandbox-state": { sandboxCwd: "file:///w/plain%20dir" } }, null)).toBe(
      "/w/plain dir",
    );
    // Each field is read on its own: a sandbox state of another shape leaves the workspace.
    expect(
      sessionFolder({ "codex/sandbox-state": "x", "x-codex-turn-metadata": { workspaces: { "/w/repo": {} } } }, null),
    ).toBe("/w/repo");
    expect(sessionFolder({}, null)).toBeNull();
  });

  test("the initialize result asks Codex for each turn's folder, and nothing else is changed", () => {
    const init = `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"memory"}}}\n`;
    expect((JSON.parse(withSandboxState(init)) as Reply).result.capabilities).toEqual({
      tools: {},
      experimental: { "codex/sandbox-state-meta": {} },
    });
    const result = `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"capabilities protocolVersion"}]}}\n`;
    expect(withSandboxState(result)).toBe(result);
  });

  test("the input schemas stay within the 5,000 bytes Codex keeps descriptions for", () => {
    // Codex drops every description from an input schema past 5,000 bytes of compact JSON. Tool
    // descriptions from a .codex-plugin manifest reach the model whole, as the end-to-end run showed.
    for (const tool of TOOLS) expect(Buffer.byteLength(JSON.stringify(tool.inputSchema))).toBeLessThan(5000);
  });
});

// The parts of the server's replies the stdio test reads.
type Reply = {
  id: number;
  result: {
    instructions: string;
    capabilities: Record<string, unknown>;
    tools: Array<{ name: string }>;
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  error: { message: string };
};

describe("the bundle over stdio", () => {
  test("initialize, tools/list and a write and read in the workspace Codex names", async () => {
    const { PWD: _, ...env } = process.env;
    const child = spawn("node", [SERVER], { cwd: TEMP, env: { ...env, AGENT_MEMORY_DIR: ROOT } });
    const lines = createInterface({ input: child.stdout });
    const replies = new Map<number, Reply>();
    const waiting = new Map<number, (reply: Reply) => void>();
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Reply;
      waiting.get(message.id)?.(message);
      replies.set(message.id, message);
    });
    let id = 0;
    const request = (method: string, params: object) =>
      new Promise<Reply>((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      });
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex", version: "0" },
    });
    expect(init.result.instructions).toContain("memory_list, memory_read and memory_write");
    expect(init.result.capabilities.experimental).toEqual({ "codex/sandbox-state-meta": {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["memory_list", "memory_read", "memory_write"]);
    const workspace = join(TEMP, "workspace");
    mkdirSync(workspace);
    const _meta = { "x-codex-turn-metadata": { workspaces: { [workspace]: {} } } };
    const written = await request("tools/call", {
      name: "memory_write",
      arguments: { store: "personal", path: "/MEMORY.md", content: "- [A](a.md) — a", if_version: "new" },
      _meta,
    });
    expect(written.result.content[0]?.text).toMatch(/^Wrote 17 bytes\./);
    const listed = await request("tools/call", { name: "memory_list", arguments: { store: "personal" }, _meta });
    expect(listed.result.content[0]?.text).toContain('"/MEMORY.md"  (17 bytes, updated');
    const plain = join(TEMP, "plain");
    mkdirSync(plain);
    const sandboxed = await request("tools/call", {
      name: "memory_write",
      arguments: { store: "personal", path: "/x.md", content: "x", if_version: "new" },
      _meta: { "codex/sandbox-state": { sandboxCwd: `file://${plain}` } },
    });
    expect(sandboxed.result.isError).toBeUndefined();
    expect(readFileSync(join(ROOT, "projects", sanitize(plain), "memory", "x.md"), "utf8")).toBe("x");
    const nowhere = await request("tools/call", { name: "memory_list", arguments: { store: "personal" } });
    expect(nowhere.result.content[0]?.text).toContain("doesn't say which folder its session is in");
    const unknown = await request("tools/call", { name: "memory_delete", arguments: {} });
    expect(unknown.error.message).toContain("memory_delete");
    child.kill();
    expect(replies.size).toBe(id);
  });
});
