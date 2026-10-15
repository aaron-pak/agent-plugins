// The bundled MCP server as Claude Code and Codex start it: `node mcp/server.mjs` over stdio, in
// both MCP eras (the initialize handshake, and 2026-07-28's server/discover with a _meta envelope
// on every request), with a publish, read, list and delete round trip in a temporary store.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { NATIVE_ONLY } from "./native-only.ts";

const SERVER = join(import.meta.dir, "..", "mcp", "server.mjs");
const TEMP = mkdtempSync(join(tmpdir(), "artifact-server-test-"));
const STORE = join(TEMP, "store");

afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

type Reply = { id: number; result?: any; error?: { code: number; message: string } };

const spawnServer = (store: string, env: Record<string, string> = {}) =>
  spawn("node", [SERVER], {
    env: { ...process.env, ARTIFACTS_DIR: store, ARTIFACT_OPEN: "0", ARTIFACT_PREVIEW: "0", TMPDIR: TEMP, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });

class Client {
  private child: ReturnType<typeof spawnServer>;
  private waiting = new Map<number, (reply: Reply) => void>();
  private next = 0;

  constructor(
    private meta?: Record<string, unknown>,
    store = STORE,
    env: Record<string, string> = {},
  ) {
    this.child = spawnServer(store, env);
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

  async call(
    args: Record<string, unknown>,
    name = "Artifact",
  ): Promise<{ text: string; isError: boolean; images: number }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const content = reply.result.content as { type: string; text?: string }[];
    const images = content.filter((part) => part.type === "image").length;
    return { text: content[0]!.text!, isError: reply.result.isError === true, images };
  }

  close(): Promise<unknown> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.on("exit", resolve));
  }
}

async function legacy(client: string, store = STORE, env: Record<string, string> = {}): Promise<Client> {
  const server = new Client(undefined, store, env);
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
    expect(tools[0].description.length).toBeLessThanOrEqual(4096);
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

  test("keeps the compact tool within Codex's limits with long paths, preview and opening", async () => {
    const long = join(TEMP, "Library", "Application Support", "Some Long Folder Name For Pages", "artifacts");
    const temp = mkdtempSync(join(TEMP, "private-var-folders-xx-yyyyyyyyyyyyyyyyyyyy-T-"));
    const server = await legacy("codex-mcp-client", long, { ARTIFACT_OPEN: "1", ARTIFACT_PREVIEW: "1", TMPDIR: temp });
    const [tool] = (await server.request("tools/list")).result.tools;
    expect(Buffer.byteLength(tool.description, "utf8")).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8")).toBeLessThanOrEqual(5000);
    await server.close();
  }, 60_000);
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

  test("publishes edits and saves them to the file", async () => {
    const server = await legacy("claude-code");
    const source = join(TEMP, "notes.html");
    writeFileSync(source, "<title>Team Notes</title>\n<h1>Draft</h1>\n");
    expect((await server.call({ file_path: source, description: "Notes.", icon: "note" })).isError).toBe(false);

    const edited = await server.call({ file_path: source, edits: [{ old_str: "Draft", new_str: "Final" }] });
    expect(edited.isError).toBe(false);
    expect(edited.text).toContain("(Version 2)");
    expect(edited.text).toContain("The edit was written to the file after it was published");
    expect(readFileSync(source, "utf8")).toBe("<title>Team Notes</title>\n<h1>Final</h1>\n");
    expect(readFileSync(join(STORE, "team-notes", "index.html"), "utf8")).toContain("<h1>Final</h1>");

    const missed = await server.call({ file_path: source, edits: [{ old_str: "Draft", new_str: "Again" }] });
    expect(missed).toEqual({
      isError: true,
      text: expect.stringMatching(
        /^No edits were applied and nothing was published: edits\[0\] old_str does not occur/,
      ),
      images: 0,
    });
    expect(readFileSync(join(STORE, "team-notes", "index.html"), "utf8")).toContain("<h1>Final</h1>");
    expect(existsSync(join(STORE, "team-notes", ".versions", "3.html"))).toBe(false);

    const stored = join(STORE, "team-notes", "index.html");
    const inStore = await server.call({ file_path: stored, edits: [{ old_str: "Final", new_str: "Twice" }] });
    expect(inStore.text).toStartWith("No edits were applied and nothing was published: ");
    expect(inStore.text).toContain("inside the published artifact team-notes");
    expect(readFileSync(stored, "utf8")).toContain("<h1>Final</h1>");

    const latin = join(TEMP, "latin.html");
    writeFileSync(latin, Buffer.from("<title>Caf\xe9</title>\n", "latin1"));
    const notUtf8 = await server.call({ file_path: latin, edits: [{ old_str: "Caf", new_str: "Cafe" }] });
    expect(notUtf8.text).toStartWith("No edits were applied: the source file is not valid UTF-8");

    const withFiles = await server.call({ file_path: source, files: [], edits: [{ old_str: "Final", new_str: "X" }] });
    expect(withFiles.text).toStartWith("`edits` changes only the file at `file_path`");
    expect((await server.call({ action: "read", url: "team-notes", edits: [] })).text).toBe(
      '`edits` applies only to a publish of `file_path` \u2014 remove it from this "read" call.',
    );
    await server.close();
  });

  test("names and describes artifacts as Claude Code does", async () => {
    const server = await legacy("claude-code");
    const md = join(TEMP, "plan-notes.md");
    writeFileSync(md, "# Launch plan\n\nSteps.\n");
    await server.call({ file_path: md, title: "Custom Name" });
    const html = join(TEMP, "board.html");
    writeFileSync(html, "<title>Ops Board</title>\n<h1>Weekly status for the ops team</h1>\n");
    const named = await server.call({ file_path: html, title: "Other Name" });
    expect(named.text).toContain(
      'The document\'s own <title> ("Ops Board") names this artifact; the `title` parameter ("Other Name") was not applied',
    );
    expect(named.text).not.toContain("No `description`");
    const listed = (await server.call({ action: "list" })).text;
    expect(listed).toContain("plan-notes.md");
    expect(listed).not.toContain("Custom Name");
    expect(readFileSync(join(STORE, "ops-board", "index.html"), "utf8")).toContain(
      '<meta name="description" content="Weekly status for the ops team">',
    );
    writeFileSync(html, "<title>Ops Board</title>\n<h1>Final status for the ops team</h1>\n");
    await server.call({ file_path: html });
    expect(readFileSync(join(STORE, "ops-board", "index.html"), "utf8")).toContain(
      '<meta name="description" content="Final status for the ops team">',
    );
    await server.call({ file_path: html, description: "Chosen words." });
    writeFileSync(html, "<title>Ops Board</title>\n<h1>Another heading entirely</h1>\n");
    await server.call({ file_path: html });
    expect(readFileSync(join(STORE, "ops-board", "index.html"), "utf8")).toContain(
      '<meta name="description" content="Chosen words.">',
    );
    await server.close();
  });

  test("renders a Markdown file into the document template, with highlight.js for code", async () => {
    const server = await legacy("claude-code");
    const source = join(TEMP, "notes.md");
    writeFileSync(source, "# Notes\n\nSome **text**.\n\n```js\nlet a = 1;\n```\n");
    expect((await server.call({ file_path: source, description: "Notes." })).isError).toBe(false);
    const page = readFileSync(join(STORE, "notes", "index.html"), "utf8");
    expect(page).toContain("<title>notes.md</title>");
    expect(page).toContain("<strong>text</strong>");
    expect(page).toContain("highlight.js 11.11.1, 186 grammars");
    await server.close();
  });

  test("keeps a damaged store from reaching outside it or stalling the server", async () => {
    const home = join(TEMP, "damaged");
    const store = join(home, "artifacts");
    mkdirSync(join(home, "keep"), { recursive: true });
    mkdirSync(store);
    writeFileSync(join(home, "keep", "file.txt"), "keep");
    // A hand-edited index naming the store's parent, and a lock a crashed publish left with the clock since set back.
    const entry = { source: null, version: 1, created: null, page: "index.html" };
    writeFileSync(join(store, "index.json"), JSON.stringify({ "..": entry }));
    const lock = join(store, ".publish-lock");
    writeFileSync(lock, "");
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(lock, later, later);
    const server = await legacy("claude-code", store);
    expect((await server.call({ action: "delete", url: ".." })).isError).toBe(true);
    expect(existsSync(join(home, "keep", "file.txt"))).toBe(true);
    await server.close();
  });

  test("reports mistakes as tool errors", async () => {
    const server = await legacy("claude-code");
    const relative = await server.call({ file_path: "plan.html" });
    expect(relative.isError).toBe(true);
    const unknown = await server.call({ action: "list", pin: true });
    expect(unknown).toEqual({
      isError: true,
      text: expect.stringContaining("Unknown parameter `pin`. This tool takes"),
      images: 0,
    });
    expect((await server.call({ action: "preview", file_path: join(TEMP, "x.html") })).text).toBe(
      "Unknown action 'preview'.",
    );
    const noCheck = await server.request("tools/call", { name: "ArtifactCheck", arguments: {} });
    expect(noCheck.error?.code).toBe(-32602);
    const wrongTool = await server.request("tools/call", { name: "Other", arguments: {} });
    expect(wrongTool.error?.code).toBe(-32602);
    await server.close();
  });
});

// Preview needs Playwright and a Chromium, which CI doesn't install; where they are found, the
// server renders a page through preview.mjs.
const PREVIEW_CHECK = join(import.meta.dir, "..", "skills", "artifact-design", "scripts", "preview.mjs");
const canPreview = (() => {
  try {
    return JSON.parse(spawnSync("node", [PREVIEW_CHECK, "--check"], { encoding: "utf8" }).stdout).ok === true;
  } catch {
    return false;
  }
})();

const toolNames = (reply: { result?: { tools?: { name: string }[] } }) =>
  (reply.result?.tools ?? []).map((tool) => tool.name);

describe("preview", () => {
  // The answers sit in this user's drafts folder in the temp directory, one file per setup.
  const answers = (temp: string) => {
    const folder = join(temp, `artifact-drafts-${process.getuid?.() ?? "user"}`);
    return readdirSync(folder)
      .filter((name) => /^preview-[0-9a-f]{16}\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as { ok: boolean });
  };
  const waitFor = async (done: () => boolean) => {
    for (let tries = 0; !done() && tries < 300; tries++) await Bun.sleep(100);
  };

  test("lists it from the last check's answer, kept in the user's drafts folder", async () => {
    const temp = mkdtempSync(join(TEMP, "check-"));
    const env = { ARTIFACT_PREVIEW: "1", TMPDIR: temp };
    const first = await legacy("claude-code", STORE, env);
    const listed = toolNames(await first.request("tools/list"));
    await waitFor(() => answers(temp).length > 0);
    await first.close();
    expect(answers(temp)).toEqual([{ ok: listed.includes("ArtifactCheck") }]);
    const second = await legacy("claude-code", STORE, env);
    expect(toolNames(await second.request("tools/list"))).toEqual(listed);
    await second.close();
  }, 60_000);

  test("lists it from another setup's answer until this setup has its own", async () => {
    const temp = mkdtempSync(join(TEMP, "stale-"));
    const folder = join(temp, `artifact-drafts-${process.getuid?.() ?? "user"}`);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "preview-0123456789abcdef.json"), JSON.stringify({ ok: !canPreview }));
    const env = { ARTIFACT_PREVIEW: "1", TMPDIR: temp };
    const server = await legacy("claude-code", STORE, env);
    const listed = toolNames(await server.request("tools/list"));
    expect(listed.includes("ArtifactCheck")).toBe(!canPreview);
    await waitFor(() => answers(temp).length > 1);
    await server.close();
    expect(
      answers(temp)
        .map((answer) => answer.ok)
        .sort(),
    ).toEqual([false, true]);
    // The other setup's answer stays, and this setup now lists from its own.
    const again = await legacy("claude-code", STORE, env);
    const relisted = toolNames(await again.request("tools/list"));
    expect(relisted.includes("ArtifactCheck")).toBe(canPreview);
    await again.close();
  }, 60_000);

  test("ignores an answer that isn't a file of this user's own folder", async () => {
    const temp = mkdtempSync(join(TEMP, "planted-"));
    const folder = join(temp, `artifact-drafts-${process.getuid?.() ?? "user"}`);
    const elsewhere = join(temp, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ ok: !canPreview }));
    mkdirSync(folder, { mode: 0o700 });
    symlinkSync(elsewhere, join(folder, "preview-0123456789abcdef.json"));
    const server = await legacy("claude-code", STORE, { ARTIFACT_PREVIEW: "1", TMPDIR: temp });
    const listed = toolNames(await server.request("tools/list"));
    expect(listed.includes("ArtifactCheck")).toBe(canPreview);
    await server.close();
    expect(JSON.parse(readFileSync(elsewhere, "utf8"))).toEqual({ ok: !canPreview });
  }, 60_000);

  test("routes preview to ArtifactCheck and names it in quickstart only when it is listed", async () => {
    const temp = mkdtempSync(join(TEMP, "listed-"));
    const folder = join(temp, `artifact-drafts-${process.getuid?.() ?? "user"}`);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "preview-0123456789abcdef.json"), JSON.stringify({ ok: true }));
    const server = await legacy("claude-code", STORE, { ARTIFACT_PREVIEW: "1", TMPDIR: temp });
    expect(toolNames(await server.request("tools/list"))).toEqual(["Artifact", "ArtifactCheck"]);
    const page = join(TEMP, "routed.html");
    writeFileSync(page, "<title>Routed</title>\n<p>Hello</p>\n");
    const redirect = await server.call({ action: "preview", file_path: page });
    expect(redirect.text).toBe("preview is an action of the ArtifactCheck tool: call ArtifactCheck with `file_path`.");
    expect(redirect.isError).toBe(true);
    const files = await server.call({ file_path: page, files: {} }, "ArtifactCheck");
    expect(files.text).toStartWith("Unknown parameter `files`");
    const verify = await server.call({ action: "verify" }, "ArtifactCheck");
    expect(verify.text).toBe("Unknown action 'verify'.");
    if (!canPreview) {
      const missing = await server.call({ file_path: page, widths: [800], themes: ["dark"] }, "ArtifactCheck");
      expect(missing.text).toStartWith("preview failed: preview isn't available here");
    }
    const listed = (await server.call({ action: "quickstart", intent: "other" })).text;
    expect(listed).toContain("one `ArtifactCheck` preview, or else one screenshot");
    expect(listed).toContain("`artifact-design:artifact-diagramming` in the Skill tool");
    expect(listed).not.toMatch(NATIVE_ONLY);
    await server.close();
    const off = await legacy("codex-mcp-client", STORE, { ARTIFACT_PREVIEW: "0" });
    for (const intent of ["other", "document", "slides", "design"]) {
      const text = (await off.call({ action: "quickstart", intent })).text;
      expect(text).not.toContain("ArtifactCheck");
      expect(text).not.toContain("Skill tool");
      expect(text).toContain("In this text, Claude means you.");
      expect(text).not.toMatch(NATIVE_ONLY);
    }
    await off.close();
  }, 60_000);

  test.skipIf(!canPreview)(
    "renders a page as publish wraps it and returns its captures",
    async () => {
      const server = await legacy("claude-code", STORE, { ARTIFACT_PREVIEW: "1" });
      const { tools } = (await server.request("tools/list")).result;
      expect(tools[1].name).toBe("ArtifactCheck");
      expect(tools[1]._meta).toBeUndefined();
      expect(tools[0].inputSchema.properties.action.enum).not.toContain("preview");
      const page = join(TEMP, "look.html");
      writeFileSync(page, "<title>Look</title>\n<p>Hello</p>\n");
      expect((await server.call({ action: "preview", file_path: page })).text).toStartWith(
        "preview is an action of the ArtifactCheck tool",
      );
      const result = await server.call({ action: "preview", file_path: page }, "ArtifactCheck");
      expect(result.text).toStartWith("Previewed look.html");
      expect(result.isError).toBe(false);
      expect(result.images).toBe(4);
      const narrow = await server.call({ file_path: page, widths: [800, 99999], themes: ["dark"] }, "ArtifactCheck");
      expect(narrow.text).toStartWith("Previewed look.html");
      expect(narrow.text).toContain("at 800/2560 px in dark");
      expect(narrow.images).toBe(2);
      expect(readFileSync(page, "utf8")).toBe("<title>Look</title>\n<p>Hello</p>\n");
      await server.close();
    },
    120_000,
  );
});
