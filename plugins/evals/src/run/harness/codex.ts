// Codex as the harness under test: `codex exec --json` in the run's sandbox, with CODEX_HOME set to
// the run's config folder. Codex has no folder-loaded plugins, so a plugin reaches the run the way
// Codex would install it: its skills under CODEX_HOME/skills and its MCP servers (the mocks, where
// mocks apply) in CODEX_HOME/config.toml. Codex loads no plugin hooks, so none run here either.
//
// What Codex can't do the way Claude Code does: resume a recorded Claude Code session (such cases
// fail), cap turns (`max_turns` is not enforced; the timeout is), allow tools one by one (a case
// that grants Bash, Write or Edit runs in the workspace-write sandbox, any other in read-only), and
// report cost (tokens are counted, costUsd stays 0, so --max-cost-usd can't bound a Codex run).

import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Sandbox, createSandbox, exec, removeSandbox, runEnv } from "../sandbox.ts";
import type { Answer, Harness, McpServer, RunOutput, RunRequest, ToolCall } from "./types.ts";

function codexBin(): string {
  return process.env.EVALS_CODEX_BIN || "codex";
}

function provideCredentials(codexHome: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return null;
  const source = join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  if (existsSync(source)) {
    copyFileSync(source, join(codexHome, "auth.json"));
    return null;
  }
  return "no Codex credentials: sign in with `codex login` or set OPENAI_API_KEY";
}

function toml(value: string): string {
  return JSON.stringify(value);
}

/** CODEX_HOME/config.toml for a run: no approvals, the MCP servers, nothing of the operator's. */
export function codexConfig(servers: McpServer[], model?: string): string {
  const lines = ['approval_policy = "never"', "[sandbox_workspace_write]", "network_access = false"];
  if (model) lines.unshift(`model = ${toml(model)}`);
  for (const s of servers) {
    lines.push(
      "",
      `[mcp_servers.${toml(s.name)}]`,
      `command = ${toml(s.command)}`,
      `args = [${s.args.map(toml).join(", ")}]`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The plugin's skills, copied where Codex finds user skills. */
function installSkills(pluginDir: string, codexHome: string): void {
  const skills = join(pluginDir, "skills");
  if (!existsSync(skills)) return;
  for (const name of readdirSync(skills)) {
    if (existsSync(join(skills, name, "SKILL.md")))
      cpSync(join(skills, name), join(codexHome, "skills", name), { recursive: true });
  }
}

/** The plugin's MCP servers (already rebound to mocks where they apply), from its .mcp.json. */
function pluginServers(pluginDir: string): McpServer[] {
  const file = join(pluginDir, ".mcp.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    return Object.entries(parsed.mcpServers ?? {})
      .filter(([, c]) => typeof c.command === "string")
      .map(([name, c]) => ({ name, command: c.command!, args: c.args ?? [] }));
  } catch {
    return [];
  }
}

type Item = Record<string, unknown> & { type?: string; id?: string };
type Event = Record<string, unknown> & { type?: string; item?: Item };

function skillOf(command: string): string | undefined {
  return /skills\/([A-Za-z0-9_.-]+)\/SKILL\.md/.exec(command)?.[1];
}

/** Reads a `codex exec --json` stream into the runner's shape. */
export function parseCodex(
  events: Event[],
  exit: { code: number | null; timedOut: boolean; stderrTail: string; timeoutMs: number },
  tracePath: string,
): RunOutput {
  const toolCalls: ToolCall[] = [];
  let lastAssistantText = "";
  let steps = 0;
  let error: string | null = null;
  let authFailed = false;
  let apiError = false;
  for (const e of events) {
    if (e.type === "item.completed" && e.item) {
      const it = e.item;
      const id = String(it.id ?? toolCalls.length);
      if (it.type === "agent_message") {
        lastAssistantText = String(it.text ?? "");
        steps++;
      } else if (it.type === "command_execution") {
        const command = String(it.command ?? "");
        const input = { command };
        const call: ToolCall = {
          id,
          name: "Bash",
          input,
          inputText: JSON.stringify(input),
          output: String(it.aggregated_output ?? ""),
          isError: typeof it.exit_code === "number" && it.exit_code !== 0,
        };
        toolCalls.push(call);
        const skill = skillOf(command);
        if (skill)
          toolCalls.push({ id: `${id}-skill`, name: "Skill", input: { skill }, inputText: JSON.stringify({ skill }) });
        steps++;
      } else if (it.type === "file_change") {
        const changes = Array.isArray(it.changes) ? it.changes : [];
        const input = { changes };
        toolCalls.push({ id, name: "Edit", input, inputText: JSON.stringify(input), isError: it.status === "failed" });
        steps++;
      } else if (it.type === "mcp_tool_call") {
        const name = `mcp__${String(it.server ?? "")}__${String(it.tool ?? "")}`;
        const input = it.arguments ?? {};
        const result = it.result as { content?: { text?: string }[] } | undefined;
        toolCalls.push({
          id,
          name,
          input,
          inputText: JSON.stringify(input),
          output:
            result?.content?.map((c) => c.text ?? "").join("\n") ??
            String((it.error as { message?: string } | undefined)?.message ?? ""),
          isError: it.status === "failed" || it.error != null,
        });
        steps++;
      } else if (it.type === "web_search") {
        const input = { query: it.query };
        toolCalls.push({ id, name: "WebSearch", input, inputText: JSON.stringify(input) });
        steps++;
      }
    } else if (e.type === "turn.failed") {
      error = String((e.error as { message?: string } | undefined)?.message ?? "turn failed");
      apiError = /unexpected status \d{3}/.test(error);
    } else if (e.type === "error") {
      error = String(e.message ?? "error");
    }
  }
  if (error && /401|unauthori[sz]ed|not logged in|auth/i.test(error)) authFailed = true;
  if (exit.timedOut) error = `timed out after ${Math.round(exit.timeoutMs / 1000)}s`;
  else if (exit.code !== 0) error = `exit ${exit.code}: ${error ?? (exit.stderrTail || "(no stderr)")}`;
  return {
    messages: events,
    toolCalls,
    lastAssistantText,
    numTurns: steps,
    costUsd: 0,
    error,
    timedOut: exit.timedOut,
    endedOnApiError: apiError && !exit.timedOut,
    authRejected: authFailed && error ? error : null,
    tracePath,
  };
}

function parseLines(text: string): Event[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Event];
      } catch {
        return [];
      }
    });
}

function env(box: Sandbox, extra: Record<string, string>): Record<string, string> {
  return runEnv(box, { CODEX_HOME: box.configDir, ...extra });
}

export const codexHarness: Harness = {
  name: "codex",

  async version() {
    const r = await exec(codexBin(), ["--version"], { timeoutMs: 30_000 });
    return r.stdout.trim().split(/\s/).pop() || "unknown";
  },

  mcpToolName(server, tool) {
    return `mcp__${server}__${tool}`;
  },

  instructionsPath(box, scope, name) {
    return scope === "user" ? join(box.configDir, "AGENTS.md") : join(box.cwd, name ?? "AGENTS.md");
  },

  async run(request: RunRequest) {
    const { box } = request;
    const tracePath = join(box.outDir, "trace.jsonl");
    if (request.historyFile) {
      writeFileSync(tracePath, "");
      return parseCodex(
        [{ type: "error", message: "Codex can't resume a recorded Claude Code session (context.history_file)" }],
        { code: 1, timedOut: false, stderrTail: "", timeoutMs: request.timeoutMs },
        tracePath,
      );
    }
    const problem = provideCredentials(box.configDir);
    for (const dir of request.pluginDirs) installSkills(dir, box.configDir);
    const servers = [...request.pluginDirs.flatMap(pluginServers), ...request.servers];
    writeFileSync(join(box.configDir, "config.toml"), codexConfig(servers, request.model));
    const writes = request.allowedTools.some((t) => /^(Bash|Write|Edit|MultiEdit|NotebookEdit)(\(|$)/.test(t));
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      box.cwd,
      "-s",
      writes ? "workspace-write" : "read-only",
    ];
    if (request.model) args.push("-m", request.model);
    for (const dir of request.addDirs) args.push("--add-dir", dir);
    args.push("-");
    const prompt = request.appendSystemPrompt ? `${request.prompt}\n\n${request.appendSystemPrompt}` : request.prompt;
    const r = await exec(codexBin(), args, {
      cwd: box.cwd,
      env: env(box, request.env),
      input: prompt,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onSpawn: request.onSpawn,
    });
    writeFileSync(tracePath, r.stdout);
    const stderrTail = r.stderr.trim().split("\n").slice(-5).join(" ").slice(-500);
    return parseCodex(
      parseLines(r.stdout),
      {
        code: r.code,
        timedOut: r.timedOut,
        stderrTail: problem ? `${problem} · ${stderrTail}` : stderrTail,
        timeoutMs: request.timeoutMs,
      },
      tracePath,
    );
  },

  async ask(system, user, model, signal): Promise<Answer> {
    const box = createSandbox();
    try {
      const problem = provideCredentials(box.configDir);
      writeFileSync(join(box.configDir, "config.toml"), codexConfig([], model));
      const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", box.cwd, "-s", "read-only", "-"];
      if (model) args.splice(1, 0, "-m", model);
      const r = await exec(codexBin(), args, {
        cwd: box.cwd,
        env: env(box, {}),
        input: `${system}\n\n${user}`,
        timeoutMs: 300_000,
        signal,
      });
      const run = parseCodex(
        parseLines(r.stdout),
        { code: r.code, timedOut: r.timedOut, stderrTail: r.stderr.slice(-400), timeoutMs: 300_000 },
        "",
      );
      if (run.error || !run.lastAssistantText)
        throw new Error(`codex exec failed: ${run.error ?? "no answer"}${problem ? ` · ${problem}` : ""}`);
      return { text: run.lastAssistantText, costUsd: 0 };
    } finally {
      removeSandbox(box);
    }
  },
};
