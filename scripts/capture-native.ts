// Capture the text Claude Code's own Artifact tool gives the model, for the artifact-design plugin to
// carry verbatim: the tool's description and input schema, its quickstart result for a plain page,
// and the artifact-design skill as the Skill tool loads it.
//
//   bun run capture                       refresh the plugin's copies (src/text/native/, and the
//                                         artifact-design and artifact-capabilities skills)
//   bun run capture --raw --out DIR       keep what Claude Code's model sees in DIR instead
//   bun run capture --plugin --out DIR    run this checkout's plugin (or --plugin-dir DIR's), and keep what its model sees in DIR
//
// It starts Claude Code headless (`claude -p`) against a stand-in for the Anthropic API on this
// machine. The stand-in records each request and answers with scripted tool calls, so no model runs:
// first `quickstart` with intent `other`, then the Skill tool with `artifact-design`, then a closing
// line. The native run needs a claude.ai login whose account has artifacts; the plugin run turns
// Claude Code's own artifacts off with CLAUDE_CODE_DISABLE_ARTIFACT=1 and loads this checkout's
// plugin.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pluginDir = process.argv.includes("--plugin-dir")
  ? resolve(process.argv[process.argv.indexOf("--plugin-dir") + 1]!)
  : join(root, "plugins", "artifact-design");
const args = process.argv.slice(2);
const asPlugin = args.includes("--plugin");
const out = args.includes("--out")
  ? resolve(args[args.indexOf("--out") + 1]!)
  : join(pluginDir, "src", "text", "native");
const artifactTool = asPlugin ? "mcp__plugin_artifact-design_artifact__Artifact" : "Artifact";

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
type Request = {
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  system: { text: string }[];
  messages: { role: string; content: string | Block[] }[];
};

// The scripted turns, in order; each answers the request after the previous one.
const turns: Block[][] = [
  [{ type: "tool_use", name: artifactTool, input: { action: "quickstart", intent: "other" } }],
  [
    {
      type: "tool_use",
      name: "Skill",
      input: { skill: asPlugin ? "artifact-design:artifact-design" : "artifact-design" },
    },
  ],
  [{ type: "text", text: "Done." }],
];
const requests: Request[] = [];

/** The answer to one request, as the Messages API streams it. */
function stream(blocks: Block[]): string {
  const events: [string, unknown][] = [];
  events.push([
    "message_start",
    {
      type: "message_start",
      message: {
        id: `msg_capture_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]);
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      ]);
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      ]);
    } else {
      const id = `toolu_capture_${requests.length}_${index}`;
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "tool_use", id, name: block.name, input: {} } },
      ]);
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  events.push([
    "message_delta",
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (process.env.CAPTURE_DEBUG) console.error(request.method, url.pathname + url.search);
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
      return Response.json({ type: "error", error: { type: "not_found_error", message: "not here" } }, { status: 404 });
    }
    const body = (await request.json()) as Request & { stream?: boolean; max_tokens?: number };
    // Side requests (a title, a summary) carry no tools; answer them with a line of text.
    if (!body.tools?.some((tool) => tool.name === artifactTool)) {
      return new Response(stream([{ type: "text", text: "Capture" }]), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    requests.push(body);
    const blocks = turns[Math.min(requests.length - 1, turns.length - 1)]!;
    return new Response(stream(blocks), { headers: { "content-type": "text/event-stream" } });
  },
});

const work = mkdtempSync(join(tmpdir(), "artifact-capture-"));
Bun.spawnSync(["git", "init", "-q", work]);
const env: Record<string, string | undefined> = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  ARTIFACT_OPEN: "0",
};
const command = [
  "claude",
  "-p",
  "Make an artifact.",
  "--output-format",
  "stream-json",
  "--verbose",
  "--allowedTools",
  "Skill",
  artifactTool,
];
if (asPlugin) {
  env.CLAUDE_CODE_DISABLE_ARTIFACT = "1";
  env.ARTIFACTS_DIR = join(work, "artifacts");
  command.push("--plugin-dir", pluginDir);
}
// Async, so that this process's stand-in server can answer while Claude Code runs.
const run = Bun.spawn(command, { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
await run.exited;
server.stop(true);
if (requests.length < 3) {
  console.error(stdout.slice(-2000), stderr.slice(-2000));
  throw new Error(`Claude Code made ${requests.length} of the 3 requests the capture needs`);
}

/** The tool_result for the scripted call in a request's last user turn, as text. */
function resultIn(request: Request): string {
  const last = request.messages.at(-1)!;
  const blocks = typeof last.content === "string" ? [] : last.content;
  const result = blocks.find((block) => block.type === "tool_result");
  if (!result) throw new Error("no tool result in the request");
  const content = result.content as string | Block[];
  return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");
}

/** The text that follows the tool_result in that turn (a skill's body arrives this way). */
function afterResult(request: Request): string {
  const last = request.messages.at(-1)!;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const at = blocks.findIndex((block) => block.type === "tool_result");
  return blocks
    .slice(at + 1)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n");
}

const tool = requests[0]!.tools.find((candidate) => candidate.name === artifactTool)!;
const quickstart = resultIn(requests[1]!);
const skillLoad = resultIn(requests[2]!) + "\n\n" + afterResult(requests[2]!);
mkdirSync(out, { recursive: true });
if (asPlugin || args.includes("--raw")) {
  // What this run's model saw, kept whole for comparing the plugin with Claude Code.
  writeFileSync(join(out, "description.md"), tool.description + "\n");
  writeFileSync(join(out, "input-schema.json"), JSON.stringify(tool.input_schema, null, 2) + "\n");
  writeFileSync(join(out, "quickstart.md"), quickstart + "\n");
  writeFileSync(join(out, "skill-load.md"), skillLoad + "\n");
  writeFileSync(join(out, "requests.json"), JSON.stringify(requests, null, 1));
  console.log(`Captured ${asPlugin ? "the plugin's" : "Claude Code's"} Artifact tool text in ${out}.`);
  process.exit(0);
}

// The plugin's copies. quickstart's result for a plain page is a lead paragraph and then the
// artifact-design skill's text, which the skill file carries; an account's Artifact types come
// before the lead and its design systems after the text, and neither is copied.
const CONTRACT = "## Page contract";
const lead = quickstart.slice(0, quickstart.indexOf(CONTRACT)).trim().split(/\n\n+/);
const leadAt = lead.findIndex((paragraph) => paragraph.startsWith("For a plain page"));
if (leadAt === -1) throw new Error("quickstart's result has no plain-page lead");
const tail = quickstart.indexOf("\n\nBelow: the design systems");
const guidance = quickstart.slice(quickstart.indexOf(CONTRACT), tail === -1 ? undefined : tail).trimEnd();
const skillBody = skillLoad.slice(skillLoad.indexOf(CONTRACT)).trimEnd();
if (skillBody !== guidance)
  console.log("  note      the artifact-design skill's text differs from quickstart's; copied quickstart's");

const listing = (name: string) => {
  const found = JSON.stringify(requests[0]!.messages).match(new RegExp(`\\\\n- ${name}: (.*?)\\\\n`));
  if (!found) throw new Error(`the skill listing has no ${name}`);
  return JSON.parse(`"${found[1]}"`) as string;
};
const yaml = (text: string) => `'${text.replaceAll("'", "''")}'`;
const withHead = (file: string, description: string, body?: string) => {
  const current = readFileSync(file, "utf8");
  const head = current.replace(
    /^(---\nname: [^\n]*\ndescription: )[^\n]*/,
    (_whole, start: string) => start + yaml(description),
  );
  if (body === undefined) return head;
  const at = head.indexOf(CONTRACT);
  if (at === -1) throw new Error(`${file} has no "${CONTRACT}" section to replace`);
  return head.slice(0, at) + body + "\n";
};

writeFileSync(join(out, "description.md"), tool.description + "\n");
writeFileSync(join(out, "input-schema.json"), JSON.stringify(tool.input_schema, null, 2) + "\n");
writeFileSync(join(out, "quickstart-lead.md"), lead.slice(leadAt).join("\n\n") + "\n");
const skills = join(pluginDir, "skills");
writeFileSync(
  join(skills, "artifact-design", "SKILL.md"),
  withHead(join(skills, "artifact-design", "SKILL.md"), listing("artifact-design"), guidance),
);
writeFileSync(
  join(skills, "artifact-capabilities", "SKILL.md"),
  withHead(join(skills, "artifact-capabilities", "SKILL.md"), listing("artifact-capabilities")),
);
console.log(
  `Captured Claude Code's Artifact tool text into ${out} and the artifact-design and artifact-capabilities skills.`,
);
