// The bundled MCP server as Claude Code and Codex start it: `node mcp/server.mjs` over stdio, in
// both MCP eras (the initialize handshake, and 2026-07-28's server/discover with a _meta envelope
// on every request), with a publish, read, list and delete round trip in a temporary store.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SERVER = join(import.meta.dir, "..", "mcp", "server.mjs");
const TEMP = mkdtempSync(join(tmpdir(), "artifact-server-test-"));
const STORE = join(TEMP, "store");

afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

type Reply = { id: number; result?: any; error?: { code: number; message: string } };

class Client {
  private child = spawn("node", [SERVER], {
    env: { ...process.env, ARTIFACTS_DIR: STORE, ARTIFACT_OPEN: "0", ARTIFACT_PREVIEW: "0", TMPDIR: TEMP },
    stdio: ["pipe", "pipe", "inherit"],
  });
  private waiting = new Map<number, (reply: Reply) => void>();
  private next = 0;

  constructor(private meta?: Record<string, unknown>) {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const reply = JSON.parse(line) as Reply;
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = ++this.next;
    const withMeta = this.meta ? { ...params, _meta: this.meta } : params;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: withMeta }) + "\n");
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const reply = await this.request("tools/call", { name: "Artifact", arguments: args });
    return { text: reply.result.content[0].text, isError: reply.result.isError === true };
  }

  close(): Promise<unknown> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.on("exit", resolve));
  }
}

async function legacy(client: string): Promise<Client> {
  const server = new Client();
  const reply = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: client, version: "1" },
  });
  expect(reply.result.serverInfo.name).toBe("artifact");
  expect(reply.result.instructions).toContain("Artifact");
  server.notify("notifications/initialized");
  return server;
}

const envelope = (client: string) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: client, version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

describe("initialize era", () => {
  test("lists the full tool for Claude Code", async () => {
    const server = await legacy("claude-code");
    const { tools } = (await server.request("tools/list")).result;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["Artifact"]);
    expect(tools[0].description.length).toBeLessThanOrEqual(2048);
    expect(tools[0]._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(tools[0].inputSchema.properties.action.enum).not.toContain("preview");
    await server.close();
  });

  test("lists the compact tool for Codex", async () => {
    const server = await legacy("codex-mcp-client");
    const [tool] = (await server.request("tools/list")).result.tools;
    expect(Buffer.byteLength(tool.description, "utf8")).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8")).toBeLessThanOrEqual(5000);
    expect(tool._meta).toBeUndefined();
    await server.close();
  });
});

describe("2026-07-28 era", () => {
  test("answers server/discover and stateless requests", async () => {
    const server = new Client(envelope("codex-mcp-client"));
    const discovered = (await server.request("server/discover")).result;
    expect(discovered.supportedVersions).toContain("2026-07-28");
    expect(discovered.capabilities.tools).toBeDefined();
    const [tool] = (await server.request("tools/list")).result.tools;
    expect(Buffer.byteLength(tool.description, "utf8")).toBeLessThanOrEqual(1000);
    const listed = await server.call({ action: "list" });
    expect(listed.text).toStartWith("No artifacts published yet");
    await server.close();
  });
});

describe("Artifact tool", () => {
  test("publishes, republishes, reads, lists and deletes", async () => {
    const server = await legacy("claude-code");
    const source = join(TEMP, "plan.html");
    writeFileSync(source, "<title>Budget Plan</title>\n<p>First</p>\n");

    const first = await server.call({ file_path: source, description: "A budget plan.", icon: "chart" });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("(Version 1)");
    const page = join(STORE, "budget-plan", "index.html");
    expect(readFileSync(page, "utf8")).toContain('<meta name="description" content="A budget plan.">');

    writeFileSync(source, "<title>Budget Plan</title>\n<p>Second</p>\n");
    expect((await server.call({ file_path: source })).text).toContain("(Version 2)");
    expect(existsSync(join(STORE, "budget-plan", ".versions", "2.html"))).toBe(true);

    const read = await server.call({ action: "read", url: "budget-plan" });
    expect(read.text).toContain("(Version 2, source ");
    expect(read.text).toEndWith("<title>Budget Plan</title>\n<p>Second</p>");

    expect((await server.call({ action: "list" })).text).toStartWith("- Budget Plan \u2014 file://");

    const deleted = await server.call({ action: "delete", url: "budget-plan" });
    expect(deleted.text).toStartWith("Deleted Budget Plan and its versions");
    expect(existsSync(join(STORE, "budget-plan"))).toBe(false);
    expect(existsSync(source)).toBe(true);
    await server.close();
  });

  test("renders a Markdown file into the document template", async () => {
    const server = await legacy("claude-code");
    const source = join(TEMP, "notes.md");
    writeFileSync(source, "# Notes\n\nSome **text**.\n");
    expect((await server.call({ file_path: source, description: "Notes." })).isError).toBe(false);
    const page = readFileSync(join(STORE, "notes", "index.html"), "utf8");
    expect(page).toContain("<title>notes.md</title>");
    expect(page).toContain("<strong>text</strong>");
    await server.close();
  });

  test("reports mistakes as tool errors", async () => {
    const server = await legacy("claude-code");
    const relative = await server.call({ file_path: "plan.html" });
    expect(relative.isError).toBe(true);
    const unknown = await server.call({ action: "list", pin: true });
    expect(unknown).toEqual({
      isError: true,
      text: expect.stringContaining("Unknown parameter `pin`: it belongs to claude.ai's Artifact tool."),
    });
    expect((await server.call({ action: "preview", file_path: join(TEMP, "x.html") })).text).toBe(
      "Unknown action 'preview'.",
    );
    const wrongTool = await server.request("tools/call", { name: "Other", arguments: {} });
    expect(wrongTool.error?.code).toBe(-32602);
    await server.close();
  });
});
