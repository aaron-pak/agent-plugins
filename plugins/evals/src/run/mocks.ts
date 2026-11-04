// MCP mocks, as `claude plugin eval` serves them. `mocks/<server>/<tool>.md` in the eval root, any
// folder between it and the case, or the case itself (the nearer layer wins, tool by tool) answers
// calls to that server's tool:
//
// - a fixed responder: the body is the result (`{{input.<field>}}` echoes an argument,
//   `{{file:<path>}}` inlines a file beside the mock), `error: true` returns it as a tool error, and
//   `expect:` guards the arguments (a violation stops the run, score 0);
// - an agent responder (`type: agent`): a model plays the server from the body's description, with
//   `abort_when:` conditions under which it stops the run. `_server.md` with `tools: [...]` answers
//   several tools from one description.
//
// `_tools.json` (a saved tools/list response) gives the mocked tools their real descriptions and
// schemas. A server the plugins declare that has no mock is not started, unless real servers are
// allowed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { CaseError, splitFrontmatter } from "./case.ts";

export const ABORT_PREFIX = "ABORT:";
export const ERROR_PREFIX = "ERROR:";
export const ABORTED_TEXT = "eval aborted by mock";
export const RESPONDER_FAILED = "mock agent responder failed";
const STUB = "TODO: replace with the canned result this tool should return";
const NAME = /^[A-Za-z0-9_-]+$/;
const MAX_EXPECT_GUARDS = 32;
const HISTORY_CALLS = 40;
const HISTORY_CHARS = 240_000;
const ARG_CHARS = 16_384;
const ANSWER_CHARS = 49_152;
/** An agent-mocked run may make this many mock calls per turn of its budget. */
export const MOCK_CALLS_PER_TURN = 4;

export type Expect = { [key: string]: string | string[] | Expect };

export type Responder =
  | { kind: "fixed"; body: string; isError: boolean; expect: Expect | null; baseDir: string; sourceFile: string }
  | {
      kind: "agent";
      prompt: string;
      abortWhen: string | null;
      expect: Expect | null;
      baseDir: string;
      sourceFile: string;
    };

export type ToolListing = { name: string; description: string; inputSchema: Record<string, unknown> };

export type MockServer = {
  /** The mocks/<dir> name. */
  dirName: string;
  tools: Map<string, Responder>;
  listings: Map<string, ToolListing>;
};

export type ServerPlan = {
  dirName: string;
  /** shadow: stands in for a server a plugin declares; standalone: a server of its own. */
  kind: "shadow" | "standalone";
  /** For a shadow, the plugin folder that declares the server. */
  pluginDir?: string;
  /** A declared server with no mock: not started this run. */
  withheld?: boolean;
  server: MockServer;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkExpect(e: unknown, file: string, path = ""): Expect {
  if (!isObj(e)) throw new CaseError(`${file}: expect: must be a map of argument names to guards`);
  const out: Expect = {};
  for (const [k, v] of Object.entries(e)) {
    const at = path ? `${path}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length === 0)
        throw new CaseError(`${file}: expect.${at}: an empty list of allowed values can never be satisfied`);
      out[k] = v.map(String);
    } else if (isObj(v)) out[k] = checkExpect(v, file, at);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      const re = /^\/(.+)\/([a-z]*)$/s.exec(s);
      if (re) {
        if (!/^[is]*$/.test(re[2]!))
          throw new CaseError(`${file}: expect.${at}: ${s}: only the i and s flags are supported`);
        try {
          new RegExp(re[1]!, re[2]);
        } catch (error) {
          throw new CaseError(`${file}: expect.${at}: invalid regular expression ${s} (${(error as Error).message})`);
        }
      }
      out[k] = s;
    } else throw new CaseError(`${file}: expect.${at}: expected a value, a list of values, a /regex/ or a type name`);
  }
  return out;
}

function countGuards(e: Expect): number {
  return Object.values(e).reduce<number>((n, v) => n + (isObj(v) ? countGuards(v as Expect) : 1), 0);
}

function readResponder(file: string, baseDir: string, label: string): { responder: Responder; tools: string[] } {
  const { fm, body } = splitFrontmatter(readFileSync(file, "utf8"), label);
  for (const k of Object.keys(fm)) {
    if (!["type", "expect", "error", "tools", "abort_when"].includes(k)) {
      throw new CaseError(`${label}: ${k}: unknown key (keys: type, expect, error, tools, abort_when)`);
    }
  }
  const type = fm.type ?? "fixed";
  if (type !== "fixed" && type !== "agent") throw new CaseError(`${label}: type: expected fixed or agent`);
  const expect = fm.expect === undefined ? null : checkExpect(fm.expect, label);
  if (expect && countGuards(expect) > MAX_EXPECT_GUARDS) {
    throw new CaseError(`${label}: expect: more than the ${MAX_EXPECT_GUARDS} guards one responder may carry`);
  }
  const tools = fm.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !NAME.test(t)))) {
    throw new CaseError(`${label}: tools: expected a list of tool names (letters, digits, "_" and "-")`);
  }
  if (tools !== undefined && basename(file) !== "_server.md") {
    throw new CaseError(`${label}: \`tools:\` belongs in _server.md (a <tool>.md answers the tool it is named after)`);
  }
  const text = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (type === "agent") {
    if (fm.error !== undefined) throw new CaseError(`${label}: \`error:\` applies to fixed responders only`);
    if (!text || text.includes(STUB)) {
      throw new CaseError(`${label}: an agent responder needs a description of the server it plays as its body`);
    }
    const abortWhen = typeof fm.abort_when === "string" && fm.abort_when.trim() ? fm.abort_when : null;
    return {
      responder: { kind: "agent", prompt: text, abortWhen, expect, baseDir, sourceFile: file },
      tools: (tools as string[] | undefined) ?? [],
    };
  }
  if (fm.abort_when !== undefined) {
    throw new CaseError(
      `${label}: \`abort_when:\` needs \`type: agent\`; a fixed responder guards its input with \`expect:\``,
    );
  }
  if (text.includes(STUB))
    throw new CaseError(`${label}: still holds the placeholder; write the tool's canned answer as the body`);
  if (fm.error !== undefined && typeof fm.error !== "boolean")
    throw new CaseError(`${label}: error: expected true or false`);
  return {
    responder: { kind: "fixed", body: text, isError: fm.error === true, expect, baseDir, sourceFile: file },
    tools: (tools as string[] | undefined) ?? [],
  };
}

function readListings(file: string, label: string): Map<string, ToolListing> {
  const out = new Map<string, ToolListing>();
  if (!existsSync(file)) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CaseError(`${label}: not valid JSON (${(error as Error).message})`);
  }
  const body = isObj(raw) && "result" in raw ? raw.result : raw;
  if (!isObj(body) || !Array.isArray(body.tools)) {
    throw new CaseError(
      `${label}: expected a saved tools/list response ({"tools": [{"name", "description", "inputSchema"}]})`,
    );
  }
  for (const t of body.tools) {
    if (!isObj(t) || typeof t.name !== "string") continue;
    out.set(t.name, {
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: isObj(t.inputSchema) ? t.inputSchema : { type: "object" },
    });
  }
  return out;
}

type Layer = {
  toolFiles: Map<string, Responder>;
  serverAgent: { responder: Responder; tools: string[] } | null;
  listings: Map<string, ToolListing>;
};

function readLayer(mocksDir: string, root: string): Map<string, Layer> {
  const out = new Map<string, Layer>();
  if (!existsSync(mocksDir) || !statSync(mocksDir).isDirectory()) return out;
  for (const dirName of readdirSync(mocksDir).sort()) {
    const dir = join(mocksDir, dirName);
    if (!statSync(dir).isDirectory()) continue;
    const shown = relative(root, dir) || dir;
    if (!NAME.test(dirName)) {
      throw new CaseError(`${shown}: name the folder after the server (letters, digits, "_" and "-" only)`);
    }
    if (dirName.includes("__"))
      throw new CaseError(`${shown}: "__" is the tool-name separator and can't appear in a mock folder name`);
    const layer: Layer = {
      toolFiles: new Map(),
      serverAgent: null,
      listings: readListings(join(dir, "_tools.json"), `${shown}/_tools.json`),
    };
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const label = `${shown}/${file}`;
      const tool = file.slice(0, -3);
      if (file === "_server.md") {
        const r = readResponder(join(dir, file), dir, label);
        if (r.responder.kind !== "agent") {
          throw new CaseError(`${label}: only \`type: agent\` is meaningful here; put a fixed answer in <tool>.md`);
        }
        if (r.tools.length === 0)
          throw new CaseError(`${label}: an agent answering several tools needs \`tools: [...]\``);
        if (r.responder.expect && r.tools.length > 1) {
          throw new CaseError(
            `${label}: \`expect:\` here would guard all ${r.tools.length} tools; put it on one tool's <tool>.md`,
          );
        }
        layer.serverAgent = r;
        continue;
      }
      if (!NAME.test(tool) || tool.includes("__")) {
        throw new CaseError(
          `${label}: name responder files after the tool (letters, digits, "_" and "-" only), e.g. list_issues.md`,
        );
      }
      layer.toolFiles.set(tool, readResponder(join(dir, file), dir, label).responder);
    }
    out.set(dirName, layer);
  }
  return out;
}

/** The folders from the eval root down to the case, each of which may hold mocks/. */
export function layerDirs(caseDir: string, evalRoot: string): string[] {
  const dirs: string[] = [];
  let d = resolve(caseDir);
  const root = resolve(evalRoot);
  for (;;) {
    dirs.unshift(d);
    if (d === root || !d.startsWith(`${root}/`)) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
}

/** Loads every layer of mocks that applies to a case and merges them, nearest last. */
export function loadMocks(caseDir: string, evalRoot: string): { servers: Map<string, MockServer>; notes: string[] } {
  const notes: string[] = [];
  const layers = layerDirs(caseDir, evalRoot).map((d) => readLayer(join(d, "mocks"), evalRoot));
  const servers = new Map<string, MockServer>();
  for (const name of new Set(layers.flatMap((l) => [...l.keys()]))) {
    const mine = layers.flatMap((l) => (l.has(name) ? [l.get(name)!] : []));
    const tools = new Map<string, Responder>();
    const agent = mine.map((l) => l.serverAgent).findLast((a) => a !== null) ?? null;
    if (agent) for (const t of agent.tools) tools.set(t, agent.responder);
    for (const l of mine) for (const [t, r] of l.toolFiles) tools.set(t, r);
    const listings = new Map<string, ToolListing>();
    for (const l of mine) for (const [t, v] of l.listings) listings.set(t, v);
    if (tools.size === 0) {
      notes.push(`mocks: mocks/${name}/ has no <tool>.md responders in any layer; nothing is mocked for ${name}`);
      continue;
    }
    for (const [t, r] of tools) {
      if (r.kind === "agent" && !r.abortWhen && /\b(fail|abort|stop)\b/i.test(r.prompt)) {
        notes.push(
          `mocks: ${name}/${t} mentions failing the run in its prose but has no abort_when:; only abort_when can abort`,
        );
        break;
      }
    }
    servers.set(name, { dirName: name, tools, listings });
  }
  return { servers, notes };
}

/** The MCP servers a plugin folder declares: `.mcp.json`, then `mcpServers` in its manifests. */
export function declaredServers(pluginDir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const read = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  const take = (value: unknown, base: string): void => {
    if (typeof value === "string") value = read(resolve(base, value));
    if (!isObj(value)) return;
    const map = isObj(value.mcpServers) ? value.mcpServers : value;
    for (const [k, v] of Object.entries(map)) if (isObj(v) && !out.has(k)) out.set(k, v);
  };
  if (existsSync(join(pluginDir, ".mcp.json"))) take(read(join(pluginDir, ".mcp.json")), pluginDir);
  for (const manifest of [".claude-plugin/plugin.json", "plugin.json", ".codex-plugin/plugin.json"]) {
    const m = read(join(pluginDir, manifest));
    if (isObj(m) && m.mcpServers !== undefined) take(m.mcpServers, pluginDir);
  }
  return out;
}

/** Decides, for one arm, which servers run as mocks, which are withheld, and which run for real. */
export function planServers(
  mocks: Map<string, MockServer>,
  pluginDirs: string[],
  allowRealServers: boolean,
): { servers: ServerPlan[]; notes: string[] } {
  const declared = new Map<string, string>();
  for (const dir of pluginDirs)
    for (const name of declaredServers(dir).keys()) if (!declared.has(name)) declared.set(name, dir);
  const servers: ServerPlan[] = [];
  const notes: string[] = [];
  if (mocks.size === 0 && allowRealServers) {
    if (declared.size > 0)
      notes.push(
        `mocks: no mocks/; the plugin's REAL servers ${[...declared.keys()].map((s) => `"${s}"`).join(", ")} start`,
      );
    return { servers, notes };
  }
  for (const [name, server] of mocks) {
    const pluginDir = declared.get(name);
    servers.push(
      pluginDir ? { dirName: name, kind: "shadow", pluginDir, server } : { dirName: name, kind: "standalone", server },
    );
  }
  const unmocked = [...declared.keys()].filter((s) => !mocks.has(s));
  if (unmocked.length > 0) {
    const list = unmocked.map((s) => `"${s}"`).join(", ");
    if (allowRealServers)
      notes.push(`mocks: ${list} has no mock; the plugin's REAL server starts (--allow-real-servers)`);
    else {
      notes.push(`mocks: ${list} has no mock and is NOT started; add mocks/<server>/ or pass --allow-real-servers`);
      for (const s of unmocked) {
        servers.push({
          dirName: s,
          kind: "shadow",
          pluginDir: declared.get(s)!,
          withheld: true,
          server: { dirName: s, tools: new Map(), listings: new Map() },
        });
      }
    }
  }
  return { servers, notes };
}

/** In the arm without the plugin only standalone mocks stand. */
export function forArm(servers: ServerPlan[], arm: "with" | "without"): ServerPlan[] {
  return arm === "without" ? servers.filter((s) => s.kind === "standalone") : servers;
}

export function hasAgentResponders(servers: ServerPlan[]): boolean {
  return servers.some((s) => [...s.server.tools.values()].some((r) => r.kind === "agent"));
}

// ---- answering a call ----

function at(input: unknown, path: string): unknown {
  let v = input;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      if (!/^\d+$/.test(part)) return undefined;
      v = v[Number(part)];
      continue;
    }
    v = Object.hasOwn(v, part) ? (v as Record<string, unknown>)[part] : undefined;
  }
  return v;
}

function show(v: unknown): string {
  if (v === undefined) return "(missing)";
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null || v === undefined) return "missing";
  if (typeof v === "boolean") return "bool";
  return typeof v;
}

const TYPE_NAMES = new Set(["string", "number", "bool", "boolean", "object", "array"]);

function sameScalar(v: unknown, want: string): boolean {
  if (typeof v === "string") return v === want;
  if (typeof v === "number" || typeof v === "boolean") return String(v) === want;
  return false;
}

/** Checks a call's arguments against `expect:`; returns the first violation, or null. */
export function checkCall(input: unknown, expect: Expect, prefix = ""): string | null {
  for (const [k, guard] of Object.entries(expect)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = at(input, path);
    let problem: string | null = null;
    if (Array.isArray(guard))
      problem = guard.some((g) => sameScalar(v, g)) ? null : `${path} = ${show(v)} is not one of [${guard.join(", ")}]`;
    else if (typeof guard === "object") problem = checkCall(input, guard, path);
    else {
      const re = /^\/(.+)\/([a-z]*)$/s.exec(guard);
      if (re) {
        const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
        problem =
          s !== null && new RegExp(re[1]!, re[2]).test(s) ? null : `${path} = ${show(v)} does not match ${guard}`;
      } else if (TYPE_NAMES.has(guard)) {
        const want = guard === "boolean" ? "bool" : guard;
        problem = typeOf(v) === want ? null : `${path} = ${show(v)} is not a ${guard}`;
      } else problem = sameScalar(v, guard) ? null : `${path} = ${show(v)} is not "${guard}"`;
    }
    if (problem !== null) return problem;
  }
  return null;
}

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** Fills `{{input.x}}` and `{{file:path}}` (the path may hold `{input.x}`) in a responder's text. */
export function fillTemplate(
  text: string,
  input: unknown,
  baseDir: string,
  maxArg = Number.POSITIVE_INFINITY,
): { ok: true; text: string } | { ok: false; reason: string } {
  let problem: string | null = null;
  const out = text.replace(
    /\{\{\s*(input\.[A-Za-z0-9_.-]+|file:(?:[^{}]|\{input\.[A-Za-z0-9_.-]+\})+?)\s*\}\}/g,
    (_m, ref: string) => {
      if (ref.startsWith("input.")) {
        const v = at(input, ref.slice(6));
        const s = v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
        return s.length > maxArg ? `${s.slice(0, maxArg)}… [${s.length - maxArg} more characters omitted]` : s;
      }
      let path = ref.slice(5).trim();
      path = path.replace(/\{input\.([A-Za-z0-9_.-]+)\}/g, (_x, p: string) => {
        const v = at(input, p);
        const s = v === undefined || v === null ? "" : String(v);
        if (!SEGMENT.test(s)) problem ??= `{input.${p}} = ${show(v)} is not a plain file-name segment`;
        return s;
      });
      const file = resolve(baseDir, path);
      const rel = relative(baseDir, file);
      if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
        problem ??= `{{file:${path}}} names a path outside the mock's folder`;
        return "";
      }
      if (!existsSync(file)) {
        problem ??= `{{file:${path}}}: no such file`;
        return "";
      }
      return readFileSync(file, "utf8");
    },
  );
  return problem === null ? { ok: true, text: out } : { ok: false, reason: problem };
}

/** The system prompt the model playing an agent-mocked server gets. */
export function responderSystem(server: string, abortWhen: string | null): string {
  const parts = [
    `You are standing in for the MCP server "${server}" inside an automated evaluation of a coding-agent plugin. Each user turn is one tool call the agent under test just made; earlier calls this run and your answers to them are listed first as history. Reply with ONLY the tool's result content, exactly as the real server would return it (JSON when the server returns JSON) — no commentary, no markdown fences unless the real result would contain them. Stay consistent with your earlier answers this run.`,
    `To return an ordinary tool ERROR the agent should handle (bad arguments, not found, rate limited), reply with a single line starting "${ERROR_PREFIX} " followed by the error text.`,
  ];
  if (abortWhen) {
    parts.push(
      `The evaluation author listed conditions under which this run must be STOPPED because the agent has gone off the rails. If — and only if — the current call meets one of them, reply with a single line starting "${ABORT_PREFIX} " followed by a short reason naming the condition. The conditions:\n${abortWhen.trim()}`,
    );
  } else parts.push(`Never reply with a line starting "${ABORT_PREFIX}".`);
  parts.push("The author's description of the server you are playing follows.");
  return parts.join("\n\n");
}

export type MockCall = {
  server: string;
  tool: string;
  input: unknown;
  verdict: "ok" | "tool_error" | "abort";
  output: string;
  costUsd?: number;
};

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters omitted]` : s;
}

export function responderUser(tool: string, input: unknown, history: MockCall[]): string {
  const recent = history.slice(-HISTORY_CALLS);
  const lines: string[] = [];
  let size = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const h = recent[i]!;
    const line = `- ${h.tool}(${typeof h.input === "string" ? h.input : JSON.stringify(h.input)}) → ${h.verdict === "ok" ? "" : `[${h.verdict}] `}${h.output}`;
    if (size + line.length > HISTORY_CHARS) break;
    lines.unshift(line);
    size += line.length;
  }
  const parts: string[] = [];
  const omitted = history.length - lines.length;
  if (lines.length > 0)
    parts.push(`Earlier calls this run${omitted > 0 ? ` (${omitted} older omitted)` : ""}:\n${lines.join("\n")}`);
  parts.push(`Current call: ${tool}\nArguments:\n${clipText(JSON.stringify(input, null, 2) ?? "null", ARG_CHARS)}`);
  return parts.join("\n\n");
}

/** Reads an agent responder's reply: ABORT: and ERROR: lines, or the result itself. */
export function readReply(text: string, canAbort: boolean): { verdict: MockCall["verdict"]; text: string } {
  if (text.startsWith(ABORT_PREFIX)) {
    const reason = text.slice(ABORT_PREFIX.length).trim() || "abort_when condition met";
    return canAbort ? { verdict: "abort", text: reason } : { verdict: "tool_error", text: reason };
  }
  if (text.startsWith(ERROR_PREFIX))
    return { verdict: "tool_error", text: text.slice(ERROR_PREFIX.length).trim() || "error" };
  return { verdict: "ok", text };
}

export type Ask = (system: string, user: string) => Promise<{ text: string; costUsd: number }>;

/** Answers one call to a mocked tool. */
export async function answer(
  responder: Responder,
  server: string,
  tool: string,
  input: unknown,
  history: MockCall[],
  ask: Ask | null,
): Promise<MockCall> {
  if (responder.expect) {
    const problem = checkCall(input, responder.expect);
    if (problem) return { server, tool, input, verdict: "abort", output: `input violates expect: ${problem}` };
  }
  if (responder.kind === "fixed") {
    const filled = fillTemplate(responder.body, input, responder.baseDir);
    if (!filled.ok) return { server, tool, input, verdict: "tool_error", output: filled.reason };
    return { server, tool, input, verdict: responder.isError ? "tool_error" : "ok", output: filled.text };
  }
  const filled = fillTemplate(responder.prompt, input, responder.baseDir, ARG_CHARS);
  if (!filled.ok) return { server, tool, input, verdict: "tool_error", output: filled.reason };
  if (!ask) return { server, tool, input, verdict: "tool_error", output: `${RESPONDER_FAILED} (no model to answer)` };
  try {
    const reply = await ask(
      `${responderSystem(server, responder.abortWhen)}\n\n${filled.text}`,
      responderUser(tool, input, history),
    );
    const r = readReply(reply.text.trim(), responder.abortWhen !== null);
    return { server, tool, input, verdict: r.verdict, output: clipText(r.text, ANSWER_CHARS), costUsd: reply.costUsd };
  } catch (error) {
    return { server, tool, input, verdict: "tool_error", output: `${RESPONDER_FAILED} (${(error as Error).message})` };
  }
}

/** The tools/list a mock server offers: the saved listing when there is one. */
export function listingsOf(server: MockServer): ToolListing[] {
  return [...server.tools.keys()].map(
    (t) =>
      server.listings.get(t) ?? {
        name: t,
        description: `Mocked tool ${t}.`,
        inputSchema: { type: "object", additionalProperties: true },
      },
  );
}

/** A short fingerprint of the mocks a run used, for the report. */
export function mocksHash(servers: ServerPlan[]): string {
  const h = createHash("sha256");
  for (const s of servers) for (const [t, r] of s.server.tools) h.update(`${s.dirName}/${t}:${r.sourceFile}\n`);
  return h.digest("hex").slice(0, 12);
}
