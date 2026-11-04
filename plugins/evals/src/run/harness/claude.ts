// Claude Code as the harness under test: `claude -p` in stream-json mode, in the run's sandbox, the
// way `claude plugin eval` starts its child. Settings come only from the run's own config folder
// (where the Bash sandbox is written), instruction files are switched off, and the prompt goes on
// stdin.

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Sandbox, createSandbox, exec, operatorHome, removeSandbox, runEnv } from "../sandbox.ts";
import type { Answer, Harness, RunOutput, RunRequest, ToolCall } from "./types.ts";

const AUTH_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/** The read-only tools every run may use without asking. */
export const READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "Skill",
  "AskUserQuestion",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  "Agent",
  "TodoWrite",
];

function claudeBin(): string {
  return process.env.EVALS_CLAUDE_BIN || "claude";
}

/** Gives a run's config folder the operator's login when the environment carries none. */
export function provideCredentials(configDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (AUTH_ENV.some((k) => env[k])) return null;
  const source = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
  if (existsSync(source)) {
    copyFileSync(source, join(configDir, ".credentials.json"));
    return null;
  }
  return "no credentials for the run: set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY; a macOS keychain login can't be passed to an isolated run";
}

function childEnv(box: Sandbox, extra: Record<string, string>, instructions = false): Record<string, string> {
  return runEnv(box, {
    CLAUDE_CONFIG_DIR: box.configDir,
    CLAUDE_CODE_TMPDIR: box.tmpDir,
    ...(!instructions && { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  });
}

/** The run's settings: the Bash sandbox, when a shell tool is granted. */
export function sandboxSettings(
  box: Sandbox,
  request: Pick<RunRequest, "allowedTools" | "readOnlyDirs" | "addDirs">,
): Record<string, unknown> {
  const shell = request.allowedTools.some((t) => /^Bash(\(|$)/.test(t));
  if (!shell) return {};
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [box.home, box.tmpDir],
        denyWrite: [box.configDir, box.outDir, ...request.readOnlyDirs, join(box.home, ".config", "git")],
        denyRead: [operatorHome(), box.configDir, box.outDir],
        allowRead: [box.home, box.tmpDir, ...request.readOnlyDirs, ...request.addDirs],
      },
      network: { allowedDomains: [] },
    },
  };
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

type Event = Record<string, unknown> & { type?: string };

/** Reads a stream-json run into the runner's shape. */
export function parseStream(
  events: Event[],
  exit: { kind: "ok" } | { kind: "error"; message: string } | { kind: "exit"; code: number | null; stderrTail: string },
  tracePath: string,
  timedOut: boolean,
): RunOutput {
  const toolCalls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const seen = new Set<string>();
  let lastAssistantText = "";
  let numTurns = 0;
  let messages = 0;
  let costUsd = 0;
  let resultError: string | null = null;
  let sawResult = false;
  let authFailed = false;
  let endedOnApiError = false;
  for (const e of events) {
    if (e.type === "assistant") {
      const message = e.message as { id?: string; content?: unknown } | undefined;
      const id = typeof message?.id === "string" ? message.id : null;
      if (id === null || !seen.has(id)) {
        if (id !== null) seen.add(id);
        messages++;
      }
      if (Array.isArray(message?.content)) {
        const texts: string[] = [];
        for (const b of message.content as Record<string, unknown>[]) {
          if (b?.type === "tool_use") {
            const call: ToolCall = {
              id: String(b.id ?? ""),
              name: String(b.name ?? ""),
              input: b.input,
              inputText: JSON.stringify(b.input ?? null),
            };
            toolCalls.push(call);
            if (typeof b.id === "string") byId.set(b.id, call);
          } else if (b?.type === "text") texts.push(String(b.text ?? ""));
        }
        if (texts.length > 0) lastAssistantText = texts.join("\n");
      }
      if (e.parent_tool_use_id == null && (e.error === "authentication_failed" || e.error === "oauth_org_not_allowed"))
        authFailed = true;
    } else if (e.type === "user") {
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const call = byId.get(b.tool_use_id);
          if (call) {
            call.output = textOfContent(b.content);
            call.isError = b.is_error === true;
          }
        }
      }
    } else if (e.type === "result") {
      sawResult = true;
      if (typeof e.num_turns === "number") numTurns = e.num_turns;
      if (typeof e.total_cost_usd === "number") costUsd = Math.max(0, e.total_cost_usd);
      endedOnApiError = e.is_error === true && typeof e.api_error_status === "number";
      if (e.is_error === true) {
        if (typeof e.result === "string") resultError = e.result;
        else if (Array.isArray(e.errors) && e.errors.length > 0) resultError = e.errors.map(String).join(" ");
      }
      if (e.subtype === "error_max_turns") resultError ??= `reached the turn limit (${numTurns} turns)`;
    }
  }
  if (!sawResult && numTurns === 0) numTurns = messages;
  let error: string | null = null;
  if (exit.kind === "error") error = exit.message;
  else if (exit.kind === "exit") {
    error =
      resultError !== null
        ? `exit ${exit.code}: ${resultError.slice(0, 2000)}${exit.stderrTail ? ` · stderr: ${exit.stderrTail}` : ""}`
        : `exit ${exit.code}: ${exit.stderrTail || "(no stderr)"}`;
  } else if (resultError !== null) error = resultError;
  return {
    messages: events,
    toolCalls,
    lastAssistantText,
    numTurns,
    costUsd,
    error,
    timedOut,
    endedOnApiError,
    authRejected: authFailed && error !== null ? error : null,
    tracePath,
  };
}

function parseLines(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v as Event);
    } catch {}
  }
  return out;
}

function pluginSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

export const claudeHarness: Harness = {
  name: "claude",

  async version() {
    const r = await exec(claudeBin(), ["--version"], { timeoutMs: 30_000 });
    return r.stdout.trim().split(/\s/)[0] || "unknown";
  },

  mcpToolName(server, tool, pluginName) {
    return pluginName
      ? `mcp__plugin_${pluginSegment(pluginName)}_${pluginSegment(server)}__${tool}`
      : `mcp__${pluginSegment(server)}__${tool}`;
  },

  instructionsPath(box, scope, name) {
    return scope === "user" ? join(box.configDir, "CLAUDE.md") : join(box.cwd, name ?? "CLAUDE.md");
  },

  async run(request) {
    const { box } = request;
    const credentialProblem = provideCredentials(box.configDir);
    writeFileSync(join(box.configDir, "settings.json"), JSON.stringify(sandboxSettings(box, request), null, 2));
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(request.maxTurns),
      "--permission-mode",
      "dontAsk",
      // A project CLAUDE.md loads only from the project source, so a run that loads instruction files
      // takes it too; the sandbox's cwd holds nothing else that source would read.
      "--setting-sources",
      request.loadsInstructions ? "user,project" : "user",
    ];
    if (request.model) args.push(`--model=${request.model}`);
    for (const dir of request.pluginDirs) args.push("--plugin-dir", dir);
    for (const dir of request.addDirs) args.push("--add-dir", dir);
    if (request.allowedTools.length) args.push(`--allowed-tools=${request.allowedTools.join(",")}`);
    if (request.disallowedTools.length) args.push(`--disallowed-tools=${request.disallowedTools.join(",")}`);
    if (request.historyFile) args.push("--resume", request.historyFile);
    if (request.appendSystemPrompt) args.push(`--append-system-prompt=${request.appendSystemPrompt}`);
    if (request.servers.length) {
      const config = join(box.outDir, "mcp-config.json");
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: Object.fromEntries(
            request.servers.map((s) => [s.name, { type: "stdio", command: s.command, args: s.args }]),
          ),
        }),
      );
      args.push(`--mcp-config=${config}`);
    }
    const tracePath = join(box.outDir, "trace.jsonl");
    const result = await exec(claudeBin(), args, {
      cwd: box.cwd,
      env: childEnv(box, request.env, request.loadsInstructions),
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onSpawn: request.onSpawn,
    });
    writeFileSync(tracePath, result.stdout);
    const events = parseLines(result.stdout);
    const stderrTail = result.stderr.trim().split("\n").slice(-5).join(" ").slice(-500);
    const exit = result.timedOut
      ? { kind: "error" as const, message: `timed out after ${Math.round(request.timeoutMs / 1000)}s` }
      : result.code === 0
        ? { kind: "ok" as const }
        : {
            kind: "exit" as const,
            code: result.code,
            stderrTail: credentialProblem ? `${credentialProblem} · ${stderrTail}` : stderrTail,
          };
    return parseStream(events, exit, tracePath, result.timedOut);
  },

  async ask(system, user, model, signal): Promise<Answer> {
    const box = createSandbox();
    try {
      const problem = provideCredentials(box.configDir);
      writeFileSync(join(box.configDir, "settings.json"), "{}");
      const args = [
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--setting-sources",
        "user",
        "--no-session-persistence",
        "--system-prompt",
        system,
      ];
      if (model) args.push(`--model=${model}`);
      const r = await exec(claudeBin(), args, {
        cwd: box.cwd,
        env: childEnv(box, {}),
        input: user,
        timeoutMs: 300_000,
        signal,
      });
      let parsed: { result?: unknown; total_cost_usd?: unknown; is_error?: unknown } = {};
      try {
        parsed = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
      } catch {}
      if (r.code !== 0 || parsed.is_error === true || typeof parsed.result !== "string") {
        throw new Error(
          `claude -p failed (exit ${r.code}): ${String(parsed.result ?? r.stderr ?? "").slice(0, 400)}${problem ? ` · ${problem}` : ""}`,
        );
      }
      return { text: parsed.result, costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0 };
    } finally {
      removeSandbox(box);
    }
  },
};
