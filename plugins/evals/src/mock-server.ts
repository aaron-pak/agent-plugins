// The stand-in MCP server an eval run starts in place of a real one. It speaks MCP over stdio,
// lists the mocked tools, and relays each call over a local socket to the runner, which answers it
// (a canned result, a model playing the server, or a stop) and logs it. Started as
// `node mock-server.mjs <spec.json>`; the spec names the server, its tools, the socket and a token.

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

type Spec = {
  server: string;
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  socket: string;
  token: string;
};

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function relay(tool: string, input: unknown): Promise<{ verdict: string; text: string }> {
  return new Promise((resolve) => {
    const socket = createConnection(spec.socket);
    let buffer = "";
    const done = (value: { verdict: string; text: string }) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token: spec.token, server: spec.server, tool, input })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        try {
          done(JSON.parse(buffer.slice(0, nl)) as { verdict: string; text: string });
        } catch {
          done({ verdict: "tool_error", text: "mock relay: unreadable answer" });
        }
      }
    });
    socket.on("error", (error) => done({ verdict: "tool_error", text: `mock relay: ${error.message}` }));
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: spec.server, version: "0.0.0" },
        },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: spec.tools } });
      return;
    case "tools/call": {
      const name = String(params?.name ?? "");
      if (!spec.tools.some((t) => t.name === name)) {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true },
        });
        return;
      }
      const answer = await relay(name, params?.arguments ?? {});
      const text = answer.verdict === "abort" ? "eval aborted by mock" : answer.text;
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: answer.verdict !== "ok" } });
      return;
    }
    case "resources/list":
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    case "prompts/list":
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
