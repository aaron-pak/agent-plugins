// Running a suite: every case, in each arm (with the plugin, and without it under ablation), as many
// times as it asks, each run in a fresh sandbox; grading each run; and writing the results in
// `claude plugin eval`'s aggregate-result.json shape, so the same tools read either.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Edit, recordedFiles, rewriteHistory } from "../instructions.ts";
import { readTranscript } from "../transcript.ts";
import { prepareHistory } from "./history.ts";
import { type Case, CaseError, findCaseDirs, globMatch, inCase, loadCase } from "./case.ts";
import { scoreOf, gradeRun, type GraderResult } from "./graders.ts";
import { READ_ONLY_TOOLS } from "./harness/claude.ts";
import type { Harness, McpServer, RunOutput } from "./harness/types.ts";
import {
  type MockCall,
  type ServerPlan,
  MOCK_CALLS_PER_TURN,
  answer,
  forArm,
  hasAgentResponders,
  listingsOf,
  loadMocks,
  planServers,
} from "./mocks.ts";
import {
  casePluginDirs,
  cleanupWrapped,
  evalDirOf,
  isPlugin,
  isSkill,
  pluginName,
  pluginVersion,
  rebindPlugin,
  wrapSkill,
} from "./plugins.ts";
import { type Sandbox, createSandbox, createdFiles, exec, listFiles, removeSandbox } from "./sandbox.ts";

export type Ablation = "auto" | "with-without" | "none";

export type RunOptions = {
  target: string;
  evalDir?: string;
  runs?: number;
  model?: string;
  judgeModel?: string;
  ablation: Ablation;
  threshold: number;
  maxCostUsd?: number;
  allowTools: string[];
  disallowTools: string[];
  caseGlobs: string[];
  tags: string[];
  scaffold: boolean;
  outputDir?: string;
  concurrency: number;
  keepTemp: boolean;
  mocks: boolean;
  allowRealServers: boolean;
  harness: Harness;
  judgeHarness: Harness;
  /** An instruction file every case loads, in place of the case's own `context.instructions`. */
  instructions?: string;
  /** Where the instruction file loads from: the project (working folder) or the user's config. */
  instructionsScope: "project" | "user";
  /** The instruction file's name in the working folder (default: the harness's own, CLAUDE.md or AGENTS.md). */
  instructionsName?: string;
  onLine: (line: string) => void;
  signal?: AbortSignal;
};

export type ArmName = "with" | "without";

export type RunRecord = {
  score: number;
  passed: boolean;
  turns: number;
  costUsd: number;
  judgeCostUsd: number;
  durationSeconds: number;
  startedAt: string;
  error: string | null;
  tracePath: string;
  skippedPaidGraders?: boolean;
  aborted?: { server: string; tool: string; reason: string };
  endedOnApiError?: boolean;
  authRejected?: string;
  notes?: string[];
  mocks?: {
    servers: { server: string; kind: string; withheld?: boolean; tools: { tool: string; responder: string }[] }[];
    warnings: string[];
    calls: { total: number; errors: number; costUsd: number };
  };
  graders: {
    name: string;
    passed: boolean;
    weight: number;
    explanation: string;
    withOnly: boolean;
    scored: boolean;
    judgeVotes?: boolean[];
    criteria?: string;
    evidence?: string;
  }[];
};

export type CaseRecord = {
  name: string;
  dir: string;
  source: Case["source"];
  promptMarkdown: string;
  model: string | null;
  runsPerCase: number;
  timeoutSeconds: number;
  maxTurns: number;
  tags: string[];
  graders: {
    name: string;
    type: string;
    weight: number;
    graderMarkdown: string | null;
    config: Record<string, unknown>;
  }[];
  arms: { with: RunRecord[]; without?: RunRecord[] };
  advisories: string[];
  aggregates: {
    score: number;
    passRate: number;
    /** pass^k with k = the case's runs: every run scored 1. */
    allRunsPassed: boolean;
    scoreWithout?: number;
    passRateWithout?: number;
    delta?: number;
  };
};

export type Result = {
  schemaVersion: 1;
  harness: string;
  harnessVersion: string;
  claudeVersion?: string;
  startedAt: string;
  durationSeconds: number;
  costUsd: number;
  partial: boolean;
  partialReason?: "cost_ceiling" | "interrupted" | "auth_failed";
  suite: {
    root: string;
    ablation: "with-without" | "none";
    modelOverride: string | null;
    judgeModel: string | null;
    caseFilter: string[];
    tagFilters: string[];
    threshold: number;
    concurrency: number;
    pluginId: string | null;
    plugins: { name: string; version: string | null; path: string; problem: string | null }[];
    judgeHarness: string;
    /** The instruction file every case loaded (--instructions), with its hash. */
    instructions: { path: string; sha256: string; scope: "project" | "user" } | null;
  };
  cases: CaseRecord[];
  errors: { case: string; error: string }[];
  aggregates: {
    casesTotal: number;
    casesPassed: number;
    overallScore: number;
    overallPassRate: number;
    allRunsPassRate: number;
    meanDelta: number | null;
  };
};

/** Where the stand-in MCP server's bundle sits, beside this runner's own bundle or under bin/. */
export function mockServerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    join(here, "mock-server.mjs"),
    join(here, "..", "..", "bin", "mock-server.mjs"),
    join(here, "..", "bin", "mock-server.mjs"),
  ]) {
    if (existsSync(p)) return p;
  }
  return process.env.EVALS_MOCK_SERVER ?? join(here, "mock-server.mjs");
}

type Rule = { tool: string; content?: string };

function rule(text: string): Rule {
  const m = /^([^(]+)\((.*)\)$/.exec(text.trim());
  return m ? { tool: m[1]!.trim(), content: m[2]! } : { tool: text.trim() };
}

/** The case's tools the run may use: the read-only set, plus whatever the operator granted. */
export function grantTools(caseTools: string[], operator: string[]): { allowed: string[]; denied: string[] } {
  const grants = operator.flatMap((t) => t.split(",")).map(rule);
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const t of caseTools
    .flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean)) {
    const r = rule(t);
    const granted =
      READ_ONLY_TOOLS.includes(r.tool) ||
      grants.some((g) => g.tool === r.tool && (g.content === undefined || g.content === r.content));
    (granted ? allowed : denied).push(t);
  }
  return { allowed, denied };
}

function armsOf(c: Case, pluginDirs: string[], mode: "with-without" | "none", auto: boolean): ArmName[] {
  if (mode !== "with-without" || pluginDirs.length === 0) return ["with"];
  if (auto && c.context.history_file) return ["with"];
  return ["with", "without"];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "case";
}

/** The instruction file a case's run loads: the operator's, else the case's own. */
export function instructionsFor(c: Case, options: Pick<RunOptions, "instructions">): string | undefined {
  if (options.instructions) return resolve(options.instructions);
  return c.context.instructions ? inCase(c, c.context.instructions) : undefined;
}

/**
 * Puts the instruction file where the harness loads it. A recorded case's history already carries
 * the files its session loaded, so there the recorded text is replaced in a copy of the history
 * (the resumed conversation then reads the new text where the old was). Either way a recorded case's
 * files are then written into the sandbox to match the history (see history.ts), so that Claude
 * Code's re-read on resume finds them unchanged.
 */
function loadInstructions(
  c: Case,
  options: RunOptions,
  box: Sandbox,
  historyFile: string | undefined,
): { written: boolean; notes: string[] } {
  const file = instructionsFor(c, options);
  const text = file ? readFileSync(file, "utf8") : undefined;
  const target = () => options.harness.instructionsPath(box, options.instructionsScope, options.instructionsName);
  if (!historyFile) {
    if (text === undefined) return { written: false, notes: [] };
    writeFileSync(target(), text);
    return { written: true, notes: [] };
  }
  let records = readTranscript(historyFile);
  const notes: string[] = [];
  let wrote = false;
  if (text !== undefined) {
    const type = options.instructionsScope === "user" ? "User" : "Project";
    const edits: Edit[] = recordedFiles(records)
      .filter((f) => (f.type ?? "Project") === type)
      .map((f) => ({ kind: "replace", path: f.path, text }));
    if (edits.length > 0) {
      const result = rewriteHistory(records, edits);
      records = result.records;
      notes.push(...result.warnings);
    } else {
      writeFileSync(target(), text);
      wrote = true;
      notes.push(
        "the history loaded no instruction file of this scope, so the file was written for the resumed session to load",
      );
    }
  }
  const prepared = prepareHistory(records, {
    cwd: box.cwd,
    parents: [dirname(box.cwd), box.root],
    configDir: box.configDir,
  });
  notes.push(...prepared.notes);
  if (c.execution.append_system_prompt)
    notes.push(
      "append_system_prompt has no effect on a resumed Claude Code session: it reuses the system prompt it recorded",
    );
  writeFileSync(historyFile, `${prepared.records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return { written: wrote || prepared.placed > 0, notes };
}

/** Runs the case's scaffold script in the run's working folder. */
async function scaffold(c: Case, box: Sandbox, signal?: AbortSignal): Promise<string | null> {
  const script = inCase(c, c.context.scaffold_script!);
  const r = await exec("bash", [script], {
    cwd: box.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: box.home,
      USERPROFILE: box.home,
      TMPDIR: box.tmpDir,
      TMP: box.tmpDir,
      TEMP: box.tmpDir,
      TERM: "dumb",
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_ENV: "production",
    },
    timeoutMs: 120_000,
    signal,
  });
  return r.code === 0 ? null : `scaffold failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`;
}

/** Listens for the stand-in servers' calls and answers them. */
function mockRelay(
  socketPath: string,
  token: string,
  servers: ServerPlan[],
  ask: ((s: string, u: string) => Promise<{ text: string; costUsd: number }>) | null,
  budget: number,
  onAbort: (call: MockCall) => void,
) {
  const calls: MockCall[] = [];
  const history = new Map<string, MockCall[]>();
  let agentCalls = 0;
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = "";
      let msg: { token?: string; server?: string; tool?: string; input?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        socket.end(`${JSON.stringify({ verdict: "tool_error", text: "mock relay: unreadable call" })}\n`);
        return;
      }
      if (msg.token !== token) {
        socket.end(`${JSON.stringify({ verdict: "tool_error", text: "mock relay: bad token" })}\n`);
        return;
      }
      const plan = servers.find((s) => s.dirName === msg.server);
      const responder = plan?.server.tools.get(String(msg.tool));
      let result: MockCall;
      if (!plan || !responder)
        result = {
          server: String(msg.server),
          tool: String(msg.tool),
          input: msg.input,
          verdict: "tool_error",
          output: "no mock for this tool",
        };
      else if (responder.kind === "agent" && ++agentCalls > budget) {
        result = {
          server: plan.dirName,
          tool: String(msg.tool),
          input: msg.input,
          verdict: "abort",
          output: `agent-mock call budget (${budget}) spent`,
        };
      } else {
        const past = history.get(plan.dirName) ?? [];
        result = await answer(responder, plan.dirName, String(msg.tool), msg.input, past, ask);
        past.push(result);
        history.set(plan.dirName, past);
      }
      calls.push(result);
      socket.end(`${JSON.stringify({ verdict: result.verdict, text: result.output })}\n`);
      if (result.verdict === "abort") onAbort(result);
    });
    socket.on("error", () => {});
  });
  const ready = new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => res());
  });
  return { calls, ready, close: () => new Promise<void>((res) => server.close(() => res())) };
}

type Planned = {
  c: Case;
  pluginDirs: string[];
  arms: ArmName[];
  servers: ServerPlan[];
  notes: string[];
  allowed: string[];
  denied: string[];
};

type Job = { plan: Planned; arm: ArmName; index: number };

async function runOne(job: Job, options: RunOptions, runsDir: string, state: { spent: number }): Promise<RunRecord> {
  const { plan, arm, index } = job;
  const c = plan.c;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const box = createSandbox();
  const out = join(runsDir, safeName(c.name), `${arm}-${index + 1}`);
  mkdirSync(out, { recursive: true });
  const base = { passed: false, turns: 0, costUsd: 0, judgeCostUsd: 0, graders: [], startedAt, tracePath: "" };
  const finish = (r: Omit<RunRecord, "durationSeconds">): RunRecord => ({
    ...r,
    durationSeconds: Math.round((Date.now() - started) / 1000),
  });
  let relay: ReturnType<typeof mockRelay> | undefined;
  try {
    if (c.context.scaffold_script && options.scaffold) {
      const problem = await scaffold(c, box, options.signal);
      if (problem) return finish({ ...base, score: 0, error: problem });
    }
    let historyFile: string | undefined;
    if (c.context.history_file) {
      historyFile = join(box.root, "history.jsonl");
      copyFileSync(inCase(c, c.context.history_file), historyFile);
    }
    const loaded = loadInstructions(c, options, box, historyFile);

    const servers = options.mocks ? forArm(plan.servers, arm) : [];
    const live = servers.filter((s) => !s.withheld);
    const token = randomBytes(12).toString("hex");
    const socketPath = join(box.root, "mock.sock");
    let kill: (() => void) | undefined;
    let aborted: MockCall | undefined;
    const ask = hasAgentResponders(live)
      ? (s: string, u: string) => options.judgeHarness.ask(s, u, options.judgeModel, options.signal)
      : null;
    if (live.length > 0) {
      relay = mockRelay(socketPath, token, live, ask, MOCK_CALLS_PER_TURN * c.execution.max_turns, (call) => {
        aborted ??= call;
        kill?.();
      });
      await relay.ready;
    }
    const command = (s: ServerPlan) => {
      const spec = join(box.outDir, `mock-${s.dirName}.json`);
      writeFileSync(
        spec,
        JSON.stringify({ server: s.dirName, tools: listingsOf(s.server), socket: socketPath, token }),
      );
      return { command: process.execPath.endsWith("node") ? process.execPath : "node", args: [mockServerPath(), spec] };
    };
    const pluginsHome = join(box.root, "plugins");
    mkdirSync(pluginsHome, { recursive: true });
    const pluginDirs = arm === "with" ? plan.pluginDirs.map((d) => rebindPlugin(d, pluginsHome, servers, command)) : [];
    const standalone: McpServer[] = live
      .filter((s) => s.kind === "standalone")
      .map((s) => ({ name: s.dirName, ...command(s) }));
    const mockedTools = live.flatMap((s) =>
      [...s.server.tools.keys()].map((t) =>
        options.harness.mcpToolName(s.dirName, t, s.kind === "shadow" ? pluginName(s.pluginDir!) : undefined),
      ),
    );
    const disallowed = [...(c.execution.disallowed_tools ?? []), ...options.disallowTools];
    const allowed = [...new Set([...READ_ONLY_TOOLS, ...plan.allowed, ...mockedTools])].filter(
      (t) => !disallowed.includes(t),
    );

    const before = listFiles(box.cwd);
    const run: RunOutput = await options.harness.run({
      box,
      prompt: c.execution.prompt,
      model: options.model ?? c.execution.model,
      maxTurns: c.execution.max_turns,
      timeoutMs: c.execution.timeout_seconds * 1000,
      pluginDirs,
      servers: standalone,
      allowedTools: allowed,
      disallowedTools: disallowed,
      ...(historyFile && { historyFile }),
      ...(c.execution.append_system_prompt && { appendSystemPrompt: c.execution.append_system_prompt }),
      addDirs: c.context.add_dirs.map((d) => inCase(c, d)),
      readOnlyDirs: [...plan.pluginDirs, c.dir],
      env: c.execution.env,
      loadsInstructions: loaded.written,
      signal: options.signal,
      onSpawn: (k) => {
        kill = k;
      },
    });
    const cwdDiff = createdFiles(before, listFiles(box.cwd));
    if (existsSync(run.tracePath)) {
      copyFileSync(run.tracePath, join(out, "trace.jsonl"));
      run.tracePath = join(out, "trace.jsonl");
    }
    const mockCalls = relay?.calls ?? [];
    if (relay) writeFileSync(join(out, "mock-calls.jsonl"), mockCalls.map((m) => JSON.stringify(m)).join("\n"));
    // Pair each call the model made to a mocked tool with the answer the mock gave, in order.
    const queue = [...mockCalls];
    for (const call of run.toolCalls) {
      const i = queue.findIndex(
        (m) =>
          options.harness.mcpToolName(
            m.server,
            m.tool,
            live.find((s) => s.dirName === m.server)?.kind === "shadow"
              ? pluginName(live.find((s) => s.dirName === m.server)!.pluginDir!)
              : undefined,
          ) === call.name,
      );
      if (i >= 0) {
        const m = queue.splice(i, 1)[0]!;
        call.mock = { server: m.server, tool: m.tool, verdict: m.verdict };
        // A grader can name the tool the same way under every harness: mcp__<server>__<tool>.
        const plain = `mcp__${m.server}__${m.tool}`;
        if (plain !== call.name) call.aliases = [...(call.aliases ?? []), plain];
      }
    }
    const mockCost = mockCalls.reduce((n, m) => n + (m.costUsd ?? 0), 0);
    const mocks = servers.length
      ? {
          servers: servers.map((s) => ({
            server: s.dirName,
            kind: s.kind,
            ...(s.withheld && { withheld: true }),
            tools: [...s.server.tools].map(([t, r]) => ({ tool: t, responder: r.kind })),
          })),
          warnings: plan.notes,
          calls: {
            total: mockCalls.length,
            errors: mockCalls.filter((m) => m.verdict !== "ok").length,
            costUsd: mockCost,
          },
        }
      : undefined;
    const costUsd = run.costUsd + mockCost;
    const common = {
      ...base,
      turns: run.numTurns,
      tracePath: run.tracePath,
      ...(loaded.notes.length > 0 && { notes: loaded.notes }),
      ...(mocks && { mocks }),
      ...(run.authRejected && { authRejected: run.authRejected }),
    };
    if (aborted) {
      return finish({
        ...common,
        score: 0,
        costUsd,
        error: null,
        aborted: { server: aborted.server, tool: aborted.tool, reason: aborted.output },
      });
    }
    if (run.endedOnApiError) return finish({ ...common, score: 0, costUsd, error: run.error, endedOnApiError: true });

    const skipPaid = options.maxCostUsd !== undefined && costUsd >= options.maxCostUsd - state.spent;
    const graded = await gradeRun({
      case_: c,
      run,
      cwdDiff,
      sandboxCwd: box.cwd,
      harness: options.judgeHarness,
      ...(options.judgeModel && { judgeModel: options.judgeModel }),
      skipPaidGraders: skipPaid,
      ...(plan.arms.length > 1 && { arm }),
      mockCallsWithOnly:
        plan.arms.length > 1 &&
        plan.servers.some((s) => !s.withheld) &&
        plan.servers.every((s) => s.withheld || s.kind === "shadow"),
      mocksActive: live.length > 0,
      signal: options.signal,
    });
    const score = scoreOf(graded.results);
    return finish({
      ...common,
      score,
      passed: score >= 1,
      costUsd: costUsd + graded.judgeCostUsd,
      judgeCostUsd: graded.judgeCostUsd,
      error: run.error,
      ...(graded.paidGradersSkipped && { skippedPaidGraders: true }),
      graders: graded.results.map((g: GraderResult) => ({
        name: g.name,
        passed: g.passed,
        weight: g.weight,
        explanation: g.explanation,
        withOnly: g.with_only === true,
        scored: g.scored !== false,
        ...(g.judge_votes && { judgeVotes: g.judge_votes }),
        ...(g.criteria !== undefined && { criteria: g.criteria }),
        ...(g.evidence !== undefined && { evidence: g.evidence }),
      })),
    });
  } catch (error) {
    return finish({ ...base, score: 0, error: (error as Error).message });
  } finally {
    await relay?.close();
    if (options.keepTemp) options.onLine(`  kept temp: ${box.root}`);
    else removeSandbox(box);
  }
}

async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

export type Loaded = {
  root: string;
  evalDir: string;
  targetPlugin: string | null;
  cases: Case[];
  errors: { case: string; error: string }[];
  notes: string[];
};

/** Finds and loads a suite's cases, applying the --case and --tag filters. */
export function loadSuite(
  target: string,
  evalDirFlag: string | undefined,
  caseGlobs: string[],
  tags: string[],
): Loaded {
  const root = resolve(target);
  if (!existsSync(root)) throw new CaseError(`${target} does not exist`);
  const targetPlugin = isPlugin(root) ? root : isSkill(root) ? wrapSkill(root) : null;
  const evalDir = isSkill(root) && !isPlugin(root) ? evalDirOf(root, evalDirFlag) : evalDirOf(root, evalDirFlag);
  const errors: { case: string; error: string }[] = [];
  const notes: string[] = [];
  const cases: Case[] = [];
  const dirs = findCaseDirs(evalDir);
  if (dirs.length === 0)
    throw new CaseError(`no cases under ${evalDir} (each case is a folder holding case.yaml or prompt.md)`);
  for (const dir of dirs) {
    try {
      const c = loadCase(dir, evalDir);
      if (!c) continue;
      if (caseGlobs.length && !caseGlobs.some((g) => globMatch(g, c.name))) continue;
      if (tags.length && !tags.some((t) => c.tags.includes(t))) continue;
      cases.push(c);
      notes.push(...c.notes);
    } catch (error) {
      errors.push({ case: relative(evalDir, dir) || ".", error: (error as Error).message });
    }
  }
  const names = new Map<string, number>();
  for (const c of cases) names.set(c.name, (names.get(c.name) ?? 0) + 1);
  for (const [n, k] of names)
    if (k > 1) notes.push(`⚠ ${k} cases share the name "${n}"; the report and --case filter can't tell them apart`);
  return { root, evalDir, targetPlugin, cases, errors, notes };
}

export async function runSuite(options: RunOptions): Promise<{ result: Result; exitCode: number; outputDir: string }> {
  const started = Date.now();
  const suite = loadSuite(options.target, options.evalDir, options.caseGlobs, options.tags);
  for (const n of suite.notes) options.onLine(n);
  for (const e of suite.errors) options.onLine(`✗ ${e.case}: ${e.error}`);

  const planned: Planned[] = [];
  for (const c of suite.cases) {
    try {
      const pluginDirs = casePluginDirs(c, suite.targetPlugin);
      const mocks = options.mocks ? loadMocks(c.dir, suite.evalDir) : { servers: new Map(), notes: [] };
      const plan = options.mocks
        ? planServers(mocks.servers, pluginDirs, options.allowRealServers)
        : { servers: [], notes: [] };
      const { allowed, denied } = grantTools(c.execution.allowed_tools, options.allowTools);
      planned.push({
        c,
        pluginDirs,
        arms: [],
        servers: plan.servers,
        notes: [...mocks.notes, ...plan.notes],
        allowed,
        denied,
      });
    } catch (error) {
      suite.errors.push({ case: c.name, error: (error as Error).message });
      options.onLine(`✗ ${c.name}: ${(error as Error).message}`);
    }
  }
  const mode: "with-without" | "none" =
    options.ablation === "auto"
      ? planned.some((p) => p.pluginDirs.length > 0)
        ? "with-without"
        : "none"
      : options.ablation;
  if (options.ablation === "auto" && mode === "with-without") {
    options.onLine(
      "ablation: with-without (a plugin resolved); graders marked with-only, including `tool_used: Skill`, are a plugin-fired indicator, not part of the score. Pass --ablation none for one arm.",
    );
  }
  for (const p of planned) {
    p.arms = armsOf(p.c, p.pluginDirs, mode, options.ablation === "auto");
    if (p.c.context.scaffold_script && !options.scaffold) {
      options.onLine(
        `⚠ case "${p.c.name}": its scaffold_script runs only with --scaffold (author-supplied bash that runs as you); the case runs against an empty workspace`,
      );
    }
    if (p.denied.length) {
      options.onLine(
        `⚠ case "${p.c.name}": allowed_tools ${p.denied.join(", ")} not granted; pass --allow-tools to grant them`,
      );
    }
    for (const n of p.notes) options.onLine(`  ${p.c.name}: ${n}`);
  }

  const startedAt = new Date(started).toISOString();
  const outputDir = resolve(options.outputDir ?? join(suite.evalDir, "results", startedAt.replace(/[:.]/g, "-")));
  const runsDir = join(outputDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const harnessVersion = await options.harness.version().catch(() => "unknown");

  const jobs: Job[] = planned.flatMap((plan) =>
    plan.arms.flatMap((arm) =>
      Array.from({ length: options.runs ?? plan.c.runs }, (_, index) => ({ plan, arm, index })),
    ),
  );
  const results = new Map<Job, RunRecord>();
  const state = { spent: 0 };
  let partialReason: Result["partialReason"];
  if (options.maxCostUsd === 0 && jobs.length > 0) {
    partialReason = "cost_ceiling";
    options.onLine(`⚠ --max-cost-usd 0: ${planned.length} case(s) loaded, ${jobs.length} run(s) planned, nothing run`);
  }
  await pool(partialReason ? [] : jobs, options.concurrency, async (job) => {
    if (partialReason) return;
    if (options.signal?.aborted) {
      partialReason = "interrupted";
      return;
    }
    if (options.maxCostUsd !== undefined && state.spent >= options.maxCostUsd) {
      partialReason = "cost_ceiling";
      options.onLine(`⚠ cost ceiling $${options.maxCostUsd} hit; skipping remaining runs`);
      return;
    }
    const r = await runOne(job, options, runsDir, state);
    state.spent += r.costUsd;
    results.set(job, r);
    if (r.authRejected) partialReason = "auth_failed";
    const tag = job.plan.arms.length > 1 ? ` [${job.arm}]` : "";
    const status = r.aborted
      ? `aborted by mock ${r.aborted.server}/${r.aborted.tool}: ${r.aborted.reason}`
      : r.error
        ? `error: ${r.error}`
        : `score ${r.score.toFixed(2)}`;
    options.onLine(
      `  ${job.plan.c.name}${tag} run ${job.index + 1}: ${status}  ${r.turns} turns  $${r.costUsd.toFixed(2)}  ${r.durationSeconds}s`,
    );
    for (const g of r.graders)
      options.onLine(
        `    ${g.passed ? "✓" : "✗"} ${g.name}${g.withOnly ? " [with-only, not scored]" : ` (weight ${g.weight})`}: ${g.explanation}`,
      );
  });

  const cases: CaseRecord[] = planned.map((p) => {
    const mine = jobs.filter((j) => j.plan === p);
    const arm = (a: ArmName) => mine.filter((j) => j.arm === a && results.has(j)).map((j) => results.get(j)!);
    const w = arm("with");
    const wo = p.arms.includes("without") ? arm("without") : undefined;
    const score = mean(w.map((r) => r.score));
    const passRate = w.length ? w.filter((r) => r.score >= 1).length / w.length : 0;
    const allRunsPassed = w.length > 0 && w.every((r) => r.score >= 1);
    const aggregates: CaseRecord["aggregates"] = { score, passRate, allRunsPassed };
    if (wo) {
      aggregates.scoreWithout = mean(wo.map((r) => r.score));
      aggregates.passRateWithout = wo.length ? wo.filter((r) => r.score >= 1).length / wo.length : 0;
      const unfair = [...w, ...wo].some((r) => r.skippedPaidGraders || r.endedOnApiError);
      if (!unfair && w.length && wo.length) aggregates.delta = score - aggregates.scoreWithout;
    }
    const advisories = [...p.notes];
    if (p.denied.length) advisories.push(`allowed_tools not granted: ${p.denied.join(", ")}`);
    if (w.length || wo?.length) {
      const total = [...w, ...(wo ?? [])].reduce((n, r) => n + r.costUsd, 0);
      const runs = w.length + (wo?.length ?? 0);
      const delta = aggregates.delta;
      const pass = score >= options.threshold ? "✓" : "✗";
      options.onLine(
        wo
          ? `${pass} ${p.c.name}  with ${score.toFixed(2)}  without ${aggregates.scoreWithout!.toFixed(2)}  Δ ${delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}  (${runs} runs)  $${total.toFixed(2)}`
          : `${pass} ${p.c.name}  score ${score.toFixed(2)}  (${runs} runs)  $${total.toFixed(2)}`,
      );
    }
    return {
      name: p.c.name,
      dir: relative(suite.evalDir, p.c.dir) || ".",
      source: p.c.source,
      promptMarkdown: p.c.execution.prompt,
      model: options.model ?? p.c.execution.model ?? null,
      runsPerCase: options.runs ?? p.c.runs,
      timeoutSeconds: p.c.execution.timeout_seconds,
      maxTurns: p.c.execution.max_turns,
      tags: p.c.tags,
      graders: p.c.graders.map((g) => {
        const { name, type, weight, ...config } = g;
        return { name, type, weight, graderMarkdown: p.c.graderMarkdown[name] ?? null, config };
      }),
      arms: { with: w, ...(wo && { without: wo }) },
      advisories,
      aggregates,
    };
  });

  const ran = cases.filter((c) => c.arms.with.length > 0);
  const deltas = ran.map((c) => c.aggregates.delta).filter((d): d is number => d !== undefined);
  const allRuns = ran.flatMap((c) => [...c.arms.with, ...(c.arms.without ?? [])]);
  const result: Result = {
    schemaVersion: 1,
    harness: options.harness.name,
    harnessVersion,
    ...(options.harness.name === "claude" && { claudeVersion: harnessVersion }),
    startedAt,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    costUsd: allRuns.reduce((n, r) => n + r.costUsd, 0),
    partial: partialReason !== undefined,
    ...(partialReason && { partialReason }),
    suite: {
      root: suite.root,
      ablation: mode,
      modelOverride: options.model ?? null,
      judgeModel: options.judgeModel ?? null,
      caseFilter: options.caseGlobs,
      tagFilters: options.tags,
      threshold: options.threshold,
      concurrency: options.concurrency,
      pluginId: suite.targetPlugin ? pluginName(suite.targetPlugin) : null,
      judgeHarness: options.judgeHarness.name,
      instructions: options.instructions
        ? {
            path: resolve(options.instructions),
            sha256: createHash("sha256").update(readFileSync(options.instructions)).digest("hex"),
            scope: options.instructionsScope,
          }
        : null,
      plugins: [...new Set(planned.flatMap((p) => p.pluginDirs))].map((d) => ({
        name: pluginName(d),
        version: pluginVersion(d),
        path: d,
        problem: null,
      })),
    },
    cases,
    errors: suite.errors,
    aggregates: {
      casesTotal: cases.length,
      casesPassed: ran.filter((c) => c.aggregates.score >= options.threshold).length,
      overallScore: mean(ran.map((c) => c.aggregates.score)),
      overallPassRate: mean(ran.map((c) => c.aggregates.passRate)),
      // pass^k: the share of cases where every run passed. An agent that's right two times in three
      // has a pass rate of 0.67 and fails here.
      allRunsPassRate: mean(ran.map((c) => (c.aggregates.allRunsPassed ? 1 : 0))),
      meanDelta: deltas.length ? mean(deltas) : null,
    },
  };
  writeFileSync(join(outputDir, "aggregate-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  cleanupWrapped();
  const failed = ran.some(
    (c) =>
      c.aggregates.score < options.threshold ||
      [...c.arms.with, ...(c.arms.without ?? [])].some((r) => r.error || r.aborted),
  );
  const exitCode = partialReason
    ? 2
    : failed || suite.errors.length > 0 || allRuns.some((r) => r.endedOnApiError)
      ? 1
      : 0;
  return { result, exitCode, outputDir };
}
