#!/usr/bin/env node
// A stand-in for `claude -p` in the runner's tests. It answers `--version`, answers one-shot judge
// questions with PASS, and otherwise plays a short run: it starts the MCP servers of each plugin
// passed with --plugin-dir (and of --mcp-config), calls a tool when the prompt says
// `call <server> <tool> <json>`, writes a file when the prompt says `write <name>`, and prints the
// stream-json events Claude Code would.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
const stdin = readFileSync(0, "utf8");
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);

if (args.includes("json")) {
  emit({ type: "result", result: process.env.FAKE_JUDGE ?? "PASS", total_cost_usd: 0.001, is_error: false });
  process.exit(0);
}

const values = (flag) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : a.startsWith(`${flag}=`) ? [a.slice(flag.length + 1)] : []));
const servers = [];
for (const dir of values("--plugin-dir")) {
  const file = join(dir, ".mcp.json");
  if (!existsSync(file)) continue;
  let name = basename(dir);
  for (const m of [".claude-plugin/plugin.json", "plugin.json"]) {
    if (existsSync(join(dir, m))) name = JSON.parse(readFileSync(join(dir, m), "utf8")).name ?? name;
  }
  for (const [server, config] of Object.entries(JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {})) {
    servers.push({ server, prefix: `mcp__plugin_${name}_${server}__`, config });
  }
}
for (const file of values("--mcp-config")) {
  for (const [server, config] of Object.entries(JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {})) {
    servers.push({ server, prefix: `mcp__${server}__`, config });
  }
}

function rpc(child, message) {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        child.stdout.off("data", onData);
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

emit({ type: "system", subtype: "init", tools: [], mcp_servers: servers.map((s) => ({ name: s.server })) });
let turns = 1;
const call = /call (\S+) (\S+) (\{.*\})/.exec(stdin);
if (call) {
  const target = servers.find((s) => s.server === call[1]);
  const input = JSON.parse(call[3]);
  const name = `${target ? target.prefix : `mcp__${call[1]}__`}${call[2]}`;
  emit({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name, input }] } });
  let text = `No such tool available: ${name}`;
  let isError = true;
  if (target) {
    const child = spawn(target.config.command, target.config.args ?? [], { stdio: ["pipe", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    await rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const res = await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: call[2], arguments: input },
    });
    text = res.result.content[0].text;
    isError = res.result.isError;
    child.kill();
  }
  emit({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text, is_error: isError }] },
  });
  turns++;
}
const write = /write (\S+)/.exec(stdin);
if (write) writeFileSync(join(process.cwd(), write[1]), "written\n");
emit({
  type: "assistant",
  message: {
    id: "m2",
    content: [{ type: "text", text: `hello from fake (${process.env.HOME === process.cwd() ? "home" : "work"})` }],
  },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: turns,
  total_cost_usd: 0.01,
  result: "hello from fake",
});
