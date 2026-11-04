// What the runner needs from an agent harness: run one case in a sandbox and report what happened in
// one shape, and answer a one-shot question (the judge, and agent-mocked servers).

import type { Sandbox } from "../sandbox.ts";

export type ToolCall = {
  id: string;
  /** The tool's name as the harness gave it to the model. */
  name: string;
  input: unknown;
  /** The input as JSON, which `input_match` patterns are matched against. */
  inputText: string;
  /** Other names graders may use for this call, such as an MCP tool's name outside its plugin. */
  aliases?: string[];
  output?: string;
  isError?: boolean;
  /** Set on calls a mock answered. */
  mock?: { server: string; tool: string; verdict: "ok" | "tool_error" | "abort" };
};

export type RunOutput = {
  /** The conversation as the harness reported it, one entry per message, for `trace` graders. */
  messages: unknown[];
  toolCalls: ToolCall[];
  /** The text of the last assistant message that had any. */
  lastAssistantText: string;
  numTurns: number;
  costUsd: number;
  error: string | null;
  timedOut: boolean;
  /** The run stopped on a model API error rather than on its own. */
  endedOnApiError: boolean;
  /** Authentication was refused: every later run would fail the same way. */
  authRejected: string | null;
  /** The raw event stream, saved in the run's output folder. */
  tracePath: string;
};

/** An MCP server to start for this run, in the harness's own config. */
export type McpServer = { name: string; command: string; args: string[] };

export type RunRequest = {
  box: Sandbox;
  prompt: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  /** Plugin folders to load (copies whose MCP servers point at mocks, where mocks apply). */
  pluginDirs: string[];
  /** Mock servers that stand on their own, not inside a plugin. */
  servers: McpServer[];
  allowedTools: string[];
  disallowedTools: string[];
  /** A recorded conversation to resume; the prompt is its next user message. */
  historyFile?: string;
  appendSystemPrompt?: string;
  /** Folders the agent may read beside its working folder. */
  addDirs: string[];
  /** Folders the agent may read but never write (the plugin and case under test). */
  readOnlyDirs: string[];
  env: Record<string, string>;
  /** An instruction file was written for the run; the harness must let it load. */
  loadsInstructions: boolean;
  signal?: AbortSignal;
  /** Called once the agent's process starts, with a way to stop it. */
  onSpawn?: (kill: () => void) => void;
};

export type Answer = { text: string; costUsd: number };

export type Harness = {
  name: string;
  /** The harness's version, for the results. */
  version(): Promise<string>;
  run(request: RunRequest): Promise<RunOutput>;
  /** One question, one answer, no tools: used by the judge and by agent-mocked servers. */
  ask(system: string, user: string, model: string | undefined, signal?: AbortSignal): Promise<Answer>;
  /** The name the model sees for a tool of an MCP server (inside a plugin, when pluginName is set). */
  mcpToolName(server: string, tool: string, pluginName?: string): string;
  /** Where the harness loads an instruction file from, in a run's sandbox, and the file's name. */
  instructionsPath(box: Sandbox, scope: "project" | "user", name?: string): string;
};
